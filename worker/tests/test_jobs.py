"""Offline tests for the build_rubric job runner. No network, no model calls."""

import io
import json
import threading
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import worker.jobs as jobs
from worker import supabase_client as sc
from worker.supabase_client import SupabaseClient, SupabaseError

AID = "11111111-1111-1111-1111-111111111111"
Q1 = "22222222-2222-2222-2222-222222222222"
Q2 = "33333333-3333-3333-3333-333333333333"

ASSESSMENT_ROW = {"id": AID, "title": "Cells"}
QUESTION_ROWS = [
    {"id": Q1, "code": "q1", "position": 1, "prompt": "Define osmosis.",
     "max_marks": 2, "subparts": []},
    {"id": Q2, "code": "q2", "position": 2, "prompt": "Enzymes.",
     "max_marks": 4,
     "subparts": [{"id": "a", "max_marks": 2}, {"id": "b", "max_marks": 2}]},
]
SCHEME_ROW_Q1 = {"question_id": Q1, "scheme": "Water moves across (2)."}

GOOD_POINTS = [
    {"id": "p1", "question_id": "q1", "description": "water moves",
     "max_marks": 2},
    {"id": "p2", "question_id": "q2", "description": "enzymes",
     "max_marks": 4},
]


def good_draft_result():
    return {"points": [dict(p) for p in GOOD_POINTS], "warnings": ["check q2"],
            "unreadable": [], "usage": {"input_tokens": 10, "output_tokens": 5}}


class FakeClient:
    """Scripted Supabase stand-in. Records updates, upserts and downloads."""

    def __init__(self, questions=None, schemes=None, reference_note="Be kind.",
                 notes=(), blobs=None, assessment_missing=False,
                 answer_mode="typed", submissions=(), answers=(),
                 results=(), rubric_points=None, rubric_approved=False):
        self.questions = QUESTION_ROWS if questions is None else questions
        self.schemes = [SCHEME_ROW_Q1] if schemes is None else schemes
        self.reference_note = reference_note
        self.notes = list(notes)
        self.blobs = blobs or {}
        self.assessment_missing = assessment_missing
        self.answer_mode = answer_mode
        self.submissions = list(submissions)
        self.answers = list(answers)
        self.results = list(results)
        self.rubric_points = GOOD_POINTS if rubric_points is None \
            else rubric_points
        self.rubric_approved = rubric_approved
        self.claims = []
        self.rpc_calls = []
        self.select_calls = []
        self.updates = []
        self.upserts = []
        self.downloaded = []
        self.events = []
        self.stale_result = []
        self.update_error = None

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        self.events.append(("rpc", name))
        return self.claims.pop(0) if self.claims else []

    def select(self, table, params=None):
        self.select_calls.append((table, params or {}))
        if table == "assessments":
            if self.assessment_missing:
                return []
            row = dict(ASSESSMENT_ROW)
            row["answer_mode"] = self.answer_mode
            return [row]
        if table == "questions":
            return [dict(q) for q in self.questions]
        if table == "marking_schemes":
            return [dict(s) for s in self.schemes]
        if table == "rubrics":
            return [{"assessment_id": AID,
                     "points": [dict(p) for p in self.rubric_points],
                     "approved": self.rubric_approved,
                     "reference_note": self.reference_note}]
        if table == "course_notes":
            return [dict(n) for n in self.notes]
        if table == "submissions":
            rows = [dict(s) for s in self.submissions]
            if (params or {}).get("status") == "eq.submitted":
                rows = [s for s in rows if s.get("status") == "submitted"]
            return rows
        if table == "answers":
            return [dict(a) for a in self.answers]
        if table == "results":
            return [dict(r) for r in self.results]
        raise AssertionError("unexpected table %r" % table)

    def update(self, table, values, params):
        self.updates.append((table, dict(values), dict(params)))
        self.events.append(("update", table, dict(params)))
        if self.update_error is not None:
            raise self.update_error
        if params.get("status") == "eq.working":
            return list(self.stale_result)
        return [values]

    def upsert(self, table, rows, on_conflict=None):
        record = dict(rows) if isinstance(rows, dict) else [dict(r) for r in rows]
        self.upserts.append((table, record, on_conflict))
        return [rows]

    def download(self, bucket, path):
        self.downloaded.append((bucket, path))
        return self.blobs[path]


def status_updates(fake, status, job_id=None):
    out = []
    for table, values, params in fake.updates:
        if table != "marking_jobs" or values.get("status") != status:
            continue
        if job_id is not None and params.get("id") != "eq.%s" % job_id:
            continue
        out.append(values)
    return out


def note_row(storage_path, filename):
    return {"storage_path": storage_path, "filename": filename}


class BuildAssessmentTests(unittest.TestCase):
    def test_codes_subparts_and_schemes(self):
        assessment = jobs.build_assessment(
            ASSESSMENT_ROW, QUESTION_ROWS, [SCHEME_ROW_Q1], "Be kind.")
        self.assertEqual(assessment["id"], AID)
        self.assertEqual(assessment["title"], "Cells")
        self.assertEqual(assessment["reference_note"], "Be kind.")
        self.assertEqual(
            [q["id"] for q in assessment["questions"]], ["q1", "q2"])
        self.assertEqual(assessment["questions"][0]["prompt"],
                         "Define osmosis.")
        self.assertEqual(assessment["questions"][1]["prompt"],
                         "Enzymes. (a) 2 marks; (b) 2 marks")
        self.assertEqual(assessment["questions"][1]["max_marks"], 4)
        self.assertEqual(assessment["marking_scheme"],
                         {"q1": "Water moves across (2)."})

    def test_float_subpart_marks(self):
        rows = [dict(QUESTION_ROWS[1], subparts=[{"id": "a", "max_marks": 2.0}])]
        assessment = jobs.build_assessment(ASSESSMENT_ROW, rows, [], "")
        self.assertEqual(assessment["questions"][0]["prompt"],
                         "Enzymes. (a) 2 marks")
        self.assertEqual(assessment["marking_scheme"], {})


class GuardTests(unittest.TestCase):
    def test_single_missing_scheme(self):
        fake = FakeClient()
        with patch("worker.jobs.draft_rubric") as draft:
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
            draft.assert_not_called()
        errors = status_updates(fake, "error", "job-1")
        self.assertEqual(len(errors), 1)
        self.assertEqual(
            errors[0]["error"],
            "Q2 has no marking scheme and no course notes were uploaded.")
        self.assertEqual(fake.upserts, [])

    def test_lists_all_missing_schemes(self):
        fake = FakeClient(schemes=[])
        with patch("worker.jobs.draft_rubric") as draft:
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
            draft.assert_not_called()
        errors = status_updates(fake, "error", "job-1")
        self.assertEqual(
            errors[0]["error"],
            "Q1, Q2 has no marking scheme and no course notes were uploaded.")

    def test_notes_lift_the_guard(self):
        notes = [note_row("%s/n.md" % AID, "n.md")]
        fake = FakeClient(schemes=[], notes=notes,
                          blobs={"%s/n.md" % AID: b"# Notes\nWater moves."})
        with patch("worker.jobs.draft_rubric",
                   return_value=good_draft_result()):
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
        self.assertEqual(len(status_updates(fake, "done", "job-1")), 1)


class FilenameTests(unittest.TestCase):
    def test_unique_names_unchanged(self):
        rows = [note_row("a", "one.md"), note_row("b", "two.pdf")]
        self.assertEqual(jobs._local_note_names(rows), ["one.md", "two.pdf"])

    def test_duplicates_get_number_prefix(self):
        rows = [note_row("a", "n.md"), note_row("b", "n.md"),
                note_row("c", "n.md")]
        self.assertEqual(jobs._local_note_names(rows),
                         ["n.md", "2_n.md", "3_n.md"])

    def test_downloads_keep_filenames(self):
        notes = [note_row("p1/notes.md", "notes.md"),
                 note_row("p2/notes.md", "notes.md")]
        blobs = {"p1/notes.md": b"# One", "p2/notes.md": b"# Two"}
        fake = FakeClient(schemes=[], notes=notes, blobs=blobs)
        seen = {}

        def fake_draft(assessment, notes_dir, run_dir, ignore_scheme=False,
                       on_progress=None):
            seen["names"] = sorted(p.name for p in Path(notes_dir).iterdir())
            seen["first"] = (Path(notes_dir) / "notes.md").read_bytes()
            seen["second"] = (Path(notes_dir) / "2_notes.md").read_bytes()
            return good_draft_result()

        with patch("worker.jobs.draft_rubric", side_effect=fake_draft):
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
        self.assertEqual(seen["names"], ["2_notes.md", "notes.md"])
        self.assertEqual(seen["first"], b"# One")
        self.assertEqual(seen["second"], b"# Two")
        self.assertEqual(
            fake.downloaded,
            [("course-notes", "p1/notes.md"), ("course-notes", "p2/notes.md")])


class SuccessTests(unittest.TestCase):
    def test_success_writes_rubric_and_done(self):
        notes = [note_row("%s/n.md" % AID, "n.md")]
        fake = FakeClient(notes=notes,
                          blobs={"%s/n.md" % AID: b"# Notes\nWater moves."})
        seen = {}

        def fake_draft(assessment, notes_dir, run_dir, ignore_scheme=False,
                       on_progress=None):
            seen["run_dir"] = Path(run_dir)
            seen["questions"] = [q["id"] for q in assessment["questions"]]
            (Path(notes_dir).parent / "notes_text.json").write_text(
                json.dumps([{"file": "n.md", "page": 1}] * 3))
            on_progress(1)
            on_progress(2)
            return good_draft_result()

        with patch("worker.jobs.draft_rubric", side_effect=fake_draft):
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})

        self.assertEqual(seen["questions"], ["q1", "q2"])
        self.assertEqual(seen["run_dir"].parent, Path("worker") / "runs")
        self.assertTrue(
            seen["run_dir"].name.startswith("%s_rubric_" % AID))
        self.assertEqual(len(fake.upserts), 1)
        table, rows, on_conflict = fake.upserts[0]
        self.assertEqual(table, "rubrics")
        self.assertEqual(on_conflict, "assessment_id")
        self.assertEqual(rows["assessment_id"], AID)
        self.assertEqual(rows["points"], GOOD_POINTS)
        self.assertIs(rows["approved"], False)
        self.assertIn("updated_at", rows)
        self.assertNotIn("reference_note", rows)
        done = status_updates(fake, "done", "job-1")
        self.assertEqual(len(done), 1)
        progress = done[0]["progress"]
        self.assertEqual(progress["stage"], "saving")
        self.assertEqual(progress["points"], 2)
        self.assertEqual(progress["notes_pages"], 3)
        self.assertEqual(progress["warnings"], ["check q2"])
        self.assertEqual(progress["usage"],
                         {"input_tokens": 10, "output_tokens": 5})

    def test_questions_ordered_by_position(self):
        fake = FakeClient(schemes=[
            SCHEME_ROW_Q1,
            {"question_id": Q2, "scheme": "Enzymes do things (4)."}])
        with patch("worker.jobs.draft_rubric",
                   return_value=good_draft_result()):
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
        question_selects = [params for table, params in fake.select_calls
                            if table == "questions"]
        self.assertEqual(len(question_selects), 1)
        self.assertEqual(question_selects[0].get("order"), "position")
        self.assertEqual(len(status_updates(fake, "done", "job-1")), 1)


class FailureTests(unittest.TestCase):
    def test_draft_failure_sets_short_error(self):
        fake = FakeClient(schemes=[
            SCHEME_ROW_Q1,
            {"question_id": Q2, "scheme": "Enzymes do things (4)."}])
        with patch("worker.jobs.draft_rubric",
                   side_effect=RuntimeError("boom")):
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
        errors = status_updates(fake, "error", "job-1")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error"], "boom")
        self.assertEqual(fake.upserts, [])

    def test_long_message_truncated(self):
        fake = FakeClient(schemes=[
            SCHEME_ROW_Q1,
            {"question_id": Q2, "scheme": "Enzymes do things (4)."}])
        with patch("worker.jobs.draft_rubric",
                   side_effect=RuntimeError("x" * 600)):
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
        errors = status_updates(fake, "error", "job-1")
        self.assertEqual(errors[0]["error"], "x" * 500)

    def test_invalid_rubric_fails(self):
        fake = FakeClient(schemes=[
            SCHEME_ROW_Q1,
            {"question_id": Q2, "scheme": "Enzymes do things (4)."}])
        bad = good_draft_result()
        bad["points"] = []
        with patch("worker.jobs.draft_rubric", return_value=bad):
            jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
        errors = status_updates(fake, "error", "job-1")
        self.assertTrue(errors[0]["error"].startswith("invalid rubric"))
        self.assertEqual(fake.upserts, [])

    def test_loop_continues_after_failure(self):
        fake = FakeClient(schemes=[
            SCHEME_ROW_Q1,
            {"question_id": Q2, "scheme": "Enzymes do things (4)."}])
        fake.claims = [
            [{"id": "job-1", "assessment_id": AID}],
            [{"id": "job-2", "assessment_id": AID}],
            [],
        ]
        with patch("worker.jobs.draft_rubric",
                   side_effect=[RuntimeError("boom"),
                                 good_draft_result()]):
            self.assertEqual(jobs.run_loop(fake, once=True), 0)
        self.assertEqual(fake.rpc_calls[0],
                         ("claim_marking_job", {"p_type": "build_rubric"}))
        self.assertEqual(len(status_updates(fake, "error", "job-1")), 1)
        self.assertEqual(len(status_updates(fake, "done", "job-2")), 1)


class InterruptTests(unittest.TestCase):
    def _schemes(self):
        return [SCHEME_ROW_Q1,
                {"question_id": Q2, "scheme": "Enzymes do things (4)."}]

    def test_ctrl_c_marks_job_and_reraises(self):
        fake = FakeClient(schemes=self._schemes())
        with patch("worker.jobs.draft_rubric",
                   side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})
        errors = status_updates(fake, "error", "job-1")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error"], jobs.STOPPED_MESSAGE)

    def test_ctrl_c_mark_is_best_effort(self):
        fake = FakeClient(schemes=self._schemes())

        def interrupt_with_db_down(*args, **kwargs):
            fake.update_error = RuntimeError("db down")
            raise KeyboardInterrupt

        with patch("worker.jobs.draft_rubric",
                   side_effect=interrupt_with_db_down):
            with self.assertRaises(KeyboardInterrupt):
                jobs.process_job(fake, {"id": "job-1", "assessment_id": AID})

    def test_loop_exits_on_ctrl_c(self):
        fake = FakeClient(schemes=self._schemes())
        fake.claims = [[{"id": "job-1", "assessment_id": AID}]]
        with patch("worker.jobs.draft_rubric",
                   side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                jobs.run_loop(fake, once=True)
        errors = status_updates(fake, "error", "job-1")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error"], jobs.STOPPED_MESSAGE)

    def test_main_returns_zero_on_ctrl_c(self):
        with patch("worker.jobs.SupabaseClient"), \
                patch("worker.jobs.run_loop",
                      side_effect=KeyboardInterrupt):
            self.assertEqual(jobs.main(["--once"]), 0)


class StaleResetTests(unittest.TestCase):
    def _schemes(self):
        return [SCHEME_ROW_Q1,
                {"question_id": Q2, "scheme": "Enzymes do things (4)."}]

    def test_reset_before_claim(self):
        fake = FakeClient(schemes=self._schemes())
        fake.stale_result = [{"id": "stale-1"}, {"id": "stale-2"}]
        fake.claims = [[{"id": "job-1", "assessment_id": AID}], []]
        buf = io.StringIO()
        with patch("worker.jobs.draft_rubric",
                   return_value=good_draft_result()):
            with redirect_stdout(buf):
                self.assertEqual(jobs.run_loop(fake, once=True), 0)
        self.assertIn("reset 2", buf.getvalue())
        self.assertEqual(fake.events[0][0], "update")
        self.assertEqual(fake.events[0][2].get("status"), "eq.working")
        self.assertEqual(fake.events[1], ("rpc", "claim_marking_job"))
        resets = [(values, params) for table, values, params in fake.updates
                  if table == "marking_jobs"
                  and params.get("status") == "eq.working"]
        self.assertEqual(len(resets), 2)
        for values, params in resets:
            self.assertEqual(values["status"], "error")
            self.assertEqual(values["error"], jobs.STOPPED_MESSAGE)
            self.assertIn("updated_at", values)
            self.assertTrue(params["updated_at"].startswith("lt."))
        self.assertEqual(len(status_updates(fake, "done", "job-1")), 1)

    def test_cutoff_leaves_recent_jobs_alone(self):
        fake = FakeClient()
        jobs._reset_stale_working(fake)
        _, _, params = fake.updates[0]
        age = (datetime.now(timezone.utc)
               - datetime.fromisoformat(params["updated_at"][3:]))
        self.assertTrue(timedelta(minutes=14) < age < timedelta(minutes=16))

    def test_no_stale_jobs_logs_zero(self):
        fake = FakeClient(schemes=self._schemes())
        fake.claims = [[]]
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(jobs.run_loop(fake, once=True), 0)
        self.assertIn("reset 0", buf.getvalue())


SUBMITTED_1 = {"id": "sub-1", "student_id": "stu-1",
                 "status": "submitted", "script_path": None}
SUBMITTED_2 = {"id": "sub-2", "student_id": "stu-2",
               "status": "submitted", "script_path": None}
DRAFT_SUB = {"id": "sub-0", "student_id": "stu-0",
             "status": "draft", "script_path": None}


def mark_job():
    return {"id": "job-m", "assessment_id": AID, "type": "mark_all"}


def mark_result(status="marked"):
    return {
        "status": status,
        "scores": {"q1": {"marks": 2, "max": 2, "comment": "good"}},
        "awards": [{"point_id": "p1", "marks": 2, "quote": "water",
                    "reason": "stated"}],
        "flags": [],
        "total_marks": 5,
        "max_marks": 6,
        "usage": {"input_tokens": 7, "output_tokens": 8},
    }


def result_upserts(fake):
    return [(row, conflict) for table, row, conflict in fake.upserts
            if table == "results"]


class MarkAllTests(unittest.TestCase):
    def test_typed_answers_mapped_and_stored(self):
        fake = FakeClient(
            rubric_approved=True, submissions=[dict(SUBMITTED_1)],
            answers=[
                {"submission_id": "sub-1", "question_id": Q1,
                 "text": "Water moves."},
                {"submission_id": "sub-1", "question_id": Q2,
                 "text": "Enzymes rule."},
            ])
        seen = {}

        def fake_mark(assessment, rubric, submission, submission_dir,
                      run_dir):
            seen["submission"] = submission
            seen["rubric"] = rubric
            seen["run_dir"] = Path(run_dir)
            return mark_result()

        with patch("worker.jobs.mark_submission", side_effect=fake_mark):
            jobs.process_job(fake, mark_job())
        self.assertEqual(seen["submission"]["answers"],
                         [{"question_id": "q1", "text": "Water moves."},
                          {"question_id": "q2", "text": "Enzymes rule."}])
        self.assertEqual(seen["rubric"],
                         {"assessment_id": AID, "points": GOOD_POINTS})
        run_dir = seen["run_dir"]
        self.assertEqual(run_dir.parent, Path("worker") / "runs")
        self.assertTrue(run_dir.name.startswith("%s_sub-1_" % AID))
        rows = result_upserts(fake)
        self.assertEqual(len(rows), 1)
        row, conflict = rows[0]
        self.assertEqual(conflict, "submission_id")
        self.assertEqual(row["submission_id"], "sub-1")
        self.assertEqual(row["status"], "marked")
        self.assertEqual(row["segments"], {})
        self.assertEqual(row["usage"],
                         {"input_tokens": 7, "output_tokens": 8,
                          "segmentation": {"input_tokens": 0,
                                           "output_tokens": 0}})
        self.assertEqual(row["total_marks"], 5)
        self.assertEqual(row["max_marks"], 6)
        self.assertIn("marked_at", row)
        self.assertFalse(row["approved"])
        self.assertFalse(row["published"])
        self.assertNotIn("overrides", row)
        done = status_updates(fake, "done", "job-m")
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["progress"]["total"], 1)
        self.assertEqual(done[0]["progress"]["done"], 1)

    def test_only_unmarked_submitted(self):
        fake = FakeClient(
            rubric_approved=True,
            submissions=[dict(SUBMITTED_1), dict(SUBMITTED_2),
                         dict(DRAFT_SUB)],
            results=[{"submission_id": "sub-1"}])
        marked = []

        def fake_mark(assessment, rubric, submission, submission_dir,
                      run_dir):
            marked.append(submission["student_id"])
            return mark_result()

        with patch("worker.jobs.mark_submission", side_effect=fake_mark):
            jobs.process_job(fake, mark_job(), workers=1)
        self.assertEqual(marked, ["stu-2"])

    def test_incomplete_unapproved_retried(self):
        fake = FakeClient(
            rubric_approved=True,
            submissions=[dict(SUBMITTED_1)],
            results=[{"submission_id": "sub-1", "status": "incomplete",
                      "approved": False}])
        marked = []

        def fake_mark(assessment, rubric, submission, submission_dir,
                      run_dir):
            marked.append(submission["student_id"])
            return mark_result()

        with patch("worker.jobs.mark_submission", side_effect=fake_mark):
            jobs.process_job(fake, mark_job(), workers=1)
        self.assertEqual(marked, ["stu-1"])
        selects = [params for table, params in fake.select_calls
                   if table == "results"]
        self.assertEqual(selects[0]["select"],
                         "submission_id,status,approved")

    def test_finished_and_approved_skipped(self):
        subs = [{"id": "sub-%d" % n, "student_id": "stu-%d" % n,
                 "status": "submitted", "script_path": None}
                for n in (1, 2, 3, 4)]
        fake = FakeClient(
            rubric_approved=True, submissions=subs,
            results=[
                {"submission_id": "sub-1", "status": "marked",
                 "approved": False},
                {"submission_id": "sub-2", "status": "needs_review",
                 "approved": False},
                {"submission_id": "sub-3", "status": "incomplete",
                 "approved": True},
                {"submission_id": "sub-4", "status": "marked",
                 "approved": True},
            ])
        with patch("worker.jobs.mark_submission") as mark:
            jobs.process_job(fake, mark_job())
            mark.assert_not_called()
        done = status_updates(fake, "done", "job-m")
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["progress"]["note"], "Nothing new to mark.")

    def test_unapproved_rubric_fails(self):
        fake = FakeClient(rubric_approved=False,
                          submissions=[dict(SUBMITTED_1)])
        with patch("worker.jobs.mark_submission") as mark:
            jobs.process_job(fake, mark_job())
            mark.assert_not_called()
        errors = status_updates(fake, "error", "job-m")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error"], "The rubric isn't approved.")
        self.assertEqual(fake.upserts, [])

    def test_nothing_new_to_mark(self):
        fake = FakeClient(
            rubric_approved=True, submissions=[dict(SUBMITTED_1)],
            results=[{"submission_id": "sub-1"}])
        with patch("worker.jobs.mark_submission") as mark:
            jobs.process_job(fake, mark_job())
            mark.assert_not_called()
        done = status_updates(fake, "done", "job-m")
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["progress"]["total"], 0)
        self.assertEqual(done[0]["progress"]["note"], "Nothing new to mark.")

    def test_pdf_empty_pages_need_review(self):
        sub = dict(SUBMITTED_1, script_path="aid/stu/script.pdf")
        fake = FakeClient(
            rubric_approved=True, answer_mode="pdf", submissions=[sub],
            blobs={"aid/stu/script.pdf": b"%PDF-1.4 fake"})
        with patch("worker.jobs.extract_pdf_pages",
                   return_value=["", "   "]), \
                patch("worker.jobs.locate_answers") as locate, \
                patch("worker.jobs.mark_submission") as mark:
            jobs.process_job(fake, mark_job())
            locate.assert_not_called()
            mark.assert_not_called()
        self.assertEqual(fake.downloaded,
                         [("answer-pdfs", "aid/stu/script.pdf")])
        rows = result_upserts(fake)
        self.assertEqual(len(rows), 1)
        row, _ = rows[0]
        self.assertEqual(row["status"], "needs_review")
        self.assertEqual(row["flags"], [
            {"question_id": "q1", "reason": "illegible",
             "note": jobs.ILLEGIBLE_NOTE},
            {"question_id": "q2", "reason": "illegible",
             "note": jobs.ILLEGIBLE_NOTE},
        ])
        for code in ("q1", "q2"):
            self.assertFalse(row["segments"][code]["found"])
        self.assertEqual(row["usage"], jobs._empty_usage())

    def test_pdf_segments_marked(self):
        sub = dict(SUBMITTED_1, script_path="aid/stu/script.pdf")
        fake = FakeClient(
            rubric_approved=True, answer_mode="pdf", submissions=[sub],
            blobs={"aid/stu/script.pdf": b"%PDF-1.4 fake"})
        segments = {
            "q1": {"found": True, "start_quote": "Q1 alpha",
                   "page": 1, "text": "Q1 alpha beta gamma."},
            "q2": {"found": False, "start_quote": None, "page": None,
                   "text": ""},
        }
        seen = {}

        def fake_mark(assessment, rubric, submission, submission_dir,
                      run_dir):
            seen["submission"] = submission
            return mark_result()

        with patch("worker.jobs.extract_pdf_pages",
                   return_value=["Q1 alpha beta gamma.", "more"]), \
                patch("worker.jobs.locate_answers",
                      return_value={"segments": segments,
                                    "usage": {"input_tokens": 3,
                                              "output_tokens": 4}}), \
                patch("worker.jobs.mark_submission", side_effect=fake_mark):
            jobs.process_job(fake, mark_job())
        self.assertEqual(seen["submission"]["answers"],
                         [{"question_id": "q1",
                           "text": "Q1 alpha beta gamma."},
                          {"question_id": "q2", "text": ""}])
        row, _ = result_upserts(fake)[0]
        self.assertEqual(row["segments"], segments)
        self.assertEqual(row["usage"],
                         {"input_tokens": 10, "output_tokens": 12,
                          "segmentation": {"input_tokens": 3,
                                           "output_tokens": 4}})

    def test_failing_submission_isolated(self):
        fake = FakeClient(
            rubric_approved=True,
            submissions=[dict(SUBMITTED_1), dict(SUBMITTED_2)])
        with patch("worker.jobs.mark_submission",
                   side_effect=[RuntimeError("boom " + "x" * 600),
                                 mark_result()]):
            jobs.process_job(fake, mark_job(), workers=1)
        rows = {row["submission_id"]: row
                for row, _ in result_upserts(fake)}
        self.assertEqual(set(rows), {"sub-1", "sub-2"})
        self.assertEqual(rows["sub-1"]["status"], "incomplete")
        self.assertEqual(rows["sub-1"]["flags"],
                         [{"reason": "other",
                           "note": "boom " + "x" * 495}])
        self.assertEqual(rows["sub-2"]["status"], "marked")
        self.assertNotIn("overrides", rows["sub-1"])
        self.assertNotIn("overrides", rows["sub-2"])
        done = status_updates(fake, "done", "job-m")
        self.assertEqual(done[0]["progress"]["done"], 2)
        self.assertEqual(done[0]["progress"]["incomplete"], 1)

    def test_no_script_pdf_is_incomplete(self):
        fake = FakeClient(rubric_approved=True, answer_mode="pdf",
                          submissions=[dict(SUBMITTED_1)])
        with patch("worker.jobs.mark_submission") as mark:
            jobs.process_job(fake, mark_job())
            mark.assert_not_called()
        row, _ = result_upserts(fake)[0]
        self.assertEqual(row["status"], "incomplete")
        self.assertEqual(row["flags"],
                         [{"reason": "other", "note": "no script uploaded"}])

    def test_ctrl_c_during_marking(self):
        fake = FakeClient(rubric_approved=True,
                          submissions=[dict(SUBMITTED_1)])
        with patch("worker.jobs.mark_submission",
                   side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                jobs.process_job(fake, mark_job(), workers=1)
        errors = status_updates(fake, "error", "job-m")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["error"], jobs.STOPPED_MESSAGE)


class MarkClaimingTests(unittest.TestCase):
    def test_mark_all_claimed_after_empty_build(self):
        fake = FakeClient(rubric_approved=True,
                          submissions=[dict(SUBMITTED_1)])
        fake.claims = [
            [],
            [{"id": "job-m", "assessment_id": AID, "type": "mark_all"}],
            [],
            [],
        ]
        with patch("worker.jobs.mark_submission",
                   return_value=mark_result()):
            self.assertEqual(jobs.run_loop(fake, once=True), 0)
        self.assertEqual(
            [params["p_type"] for _, params in fake.rpc_calls],
            ["build_rubric", "mark_all", "build_rubric", "mark_all"])
        self.assertEqual(len(status_updates(fake, "done", "job-m")), 1)


class ProgressThreadTests(unittest.TestCase):
    def test_concurrent_updates(self):
        fake = FakeClient()
        progress = jobs._Progress(fake, "job-1")

        def hammer(n):
            for _ in range(50):
                progress.update(done=n)

        threads = [threading.Thread(target=hammer, args=(i,))
                   for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        progress.update(force=True, done="final")
        self.assertEqual(progress.state["done"], "final")
        writes = [values for table, values, _ in fake.updates
                  if table == "marking_jobs"]
        self.assertGreaterEqual(len(writes), 2)


class StubHttp:
    def __init__(self, result=None, error=None):
        self.calls = []
        self.result = result
        self.error = error

    def request(self, method, path, headers=None, **kwargs):
        self.calls.append({"method": method, "path": path,
                           "headers": dict(headers or {}), "kwargs": kwargs})
        if self.error is not None:
            raise self.error
        return self.result


KEY = "SECRET-KEY-abc123"


def make_client(stub):
    client = SupabaseClient(url="http://supabase.test", key=KEY)
    client._http = stub
    return client


def ok_response(payload):
    body = json.dumps(payload).encode()
    return SimpleNamespace(status_code=200, text=json.dumps(payload),
                           content=body, json=lambda: payload)


class ClientTests(unittest.TestCase):
    def test_auth_headers(self):
        stub = StubHttp(result=ok_response([]))
        make_client(stub).select("assessments")
        headers = stub.calls[0]["headers"]
        self.assertEqual(headers["apikey"], KEY)
        self.assertEqual(headers["Authorization"], "Bearer %s" % KEY)
        self.assertNotIn("SECRET", str(sorted(headers)))

    def test_transport_error_hides_secret(self):
        stub = StubHttp(error=sc.httpx.ConnectError("connection down"))
        with self.assertRaises(SupabaseError) as caught:
            make_client(stub).select("assessments")
        self.assertNotIn(KEY, str(caught.exception))

    def test_status_error_redacts_secret(self):
        stub = StubHttp(result=SimpleNamespace(
            status_code=500, text="detail: %s leaked" % KEY, content=b"x"))
        with self.assertRaises(SupabaseError) as caught:
            make_client(stub).select("assessments")
        self.assertNotIn(KEY, str(caught.exception))
        self.assertIn("[redacted]", str(caught.exception))

    def test_rpc_download_and_upsert_shapes(self):
        stub = StubHttp(result=ok_response([{"id": "job-1"}]))
        client = make_client(stub)
        self.assertEqual(
            client.rpc("claim_marking_job", {"p_type": "build_rubric"}),
            [{"id": "job-1"}])
        self.assertEqual(stub.calls[0]["method"], "POST")
        self.assertEqual(stub.calls[0]["path"],
                         "/rest/v1/rpc/claim_marking_job")
        stub.result = SimpleNamespace(status_code=200, text="",
                                      content=b"PDF-bytes")
        self.assertEqual(
            client.download("course-notes", "aid/notes.pdf"), b"PDF-bytes")
        self.assertEqual(stub.calls[1]["path"],
                         "/storage/v1/object/course-notes/aid/notes.pdf")
        stub.result = ok_response([{"a": 1}])
        client.upsert("rubrics", {"a": 1}, on_conflict="assessment_id")
        self.assertIn("merge-duplicates",
                      stub.calls[2]["headers"]["Prefer"])
        self.assertEqual(
            stub.calls[2]["kwargs"]["params"],
            {"on_conflict": "assessment_id"})


if __name__ == "__main__":
    unittest.main()
