"""Supabase-backed runner for build_rubric and mark_all jobs.

Loop: claim a queued job, draft the rubric or mark new scripts, write
results back to Supabase.

Run as `python -m worker.jobs [--once] [--interval 5] [--workers 3]`.
"""

import argparse
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .agent import mark_submission
from .rubric_build import draft_rubric
from .segment import locate_answers
from .supabase_client import SupabaseClient
from .tools import check_rubric, extract_pdf_pages

NOTES_BUCKET = "course-notes"
SCRIPTS_BUCKET = "answer-pdfs"
PROGRESS_INTERVAL = 2.0
STALE_MINUTES = 15
STOPPED_MESSAGE = "Worker stopped before finishing. Queue the job again."
ILLEGIBLE_NOTE = ("No readable text in the script (scanned or handwritten). "
                  "Needs manual marking.")


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _fmt_marks(value):
    if isinstance(value, float):
        return "%g" % value
    return "%s" % value


def build_assessment(assessment_row, question_rows, scheme_rows,
                     reference_note):
    """Worker assessment dict from DB rows. Question codes become ids."""
    schemes = {row["question_id"]: row.get("scheme", "")
               for row in scheme_rows}
    questions = []
    marking_scheme = {}
    for row in question_rows:
        prompt = row.get("prompt", "")
        parts = ["(%s) %s marks" % (sub.get("id"), _fmt_marks(sub.get("max_marks")))
                 for sub in row.get("subparts") or []]
        if parts:
            prompt = "%s %s" % (prompt, "; ".join(parts))
        questions.append({"id": row["code"], "prompt": prompt,
                          "max_marks": row.get("max_marks")})
        if row["id"] in schemes:
            marking_scheme[row["code"]] = schemes[row["id"]]
    return {"id": assessment_row["id"],
            "title": assessment_row.get("title", ""),
            "questions": questions,
            "marking_scheme": marking_scheme,
            "reference_note": reference_note or ""}


def _missing_scheme_labels(assessment):
    schemes = assessment.get("marking_scheme") or {}
    return [q["id"].upper() for q in assessment.get("questions", [])
            if not str(schemes.get(q["id"]) or "").strip()]


def _local_note_names(note_rows):
    """Original filenames, number-prefixed only on duplicates."""
    used = set()
    names = []
    for row in note_rows:
        base = Path(row.get("filename") or "note").name or "note"
        name, n = base, 2
        while name in used:
            name = "%d_%s" % (n, base)
            n += 1
        used.add(name)
        names.append(name)
    return names


def _count_notes_pages(tmpdir):
    path = Path(tmpdir) / "notes_text.json"
    if not path.exists():
        return 0
    try:
        data = json.loads(path.read_text())
    except ValueError:
        return 0
    return len(data) if isinstance(data, list) else 0


def _short_message(exc):
    message = str(exc).strip() or exc.__class__.__name__
    secret = os.environ.get("SUPABASE_SECRET_KEY") or ""
    if len(secret) >= 8 and secret in message:
        message = message.replace(secret, "[redacted]")
    return message[:500]


class _Progress:
    """Throttled marking_jobs.progress writer (at most one write per 2s).

    Thread-safe: parallel marking threads share one instance.
    """

    def __init__(self, client, job_id):
        self.client = client
        self.job_id = job_id
        self.state = {}
        self._last_write = 0.0
        self._lock = threading.Lock()

    def update(self, force=False, **fields):
        with self._lock:
            self.state.update(fields)
            now = time.monotonic()
            if not force and now - self._last_write < PROGRESS_INTERVAL:
                return
            self._last_write = now
            self.client.update(
                "marking_jobs",
                {"progress": self.state, "updated_at": _now_iso()},
                {"id": "eq.%s" % self.job_id})


def _load_job_inputs(client, assessment_id):
    rows = client.select(
        "assessments",
        {"id": "eq.%s" % assessment_id, "select": "id,title"})
    if not rows:
        raise RuntimeError("assessment not found")
    questions = client.select(
        "questions",
        {"assessment_id": "eq.%s" % assessment_id,
         "select": "id,code,position,prompt,max_marks,subparts",
         "order": "position"})
    schemes = []
    if questions:
        schemes = client.select(
            "marking_schemes",
            {"question_id": "in.(%s)" % ",".join(
                q["id"] for q in questions),
             "select": "question_id,scheme"})
    rubric_rows = client.select(
        "rubrics",
        {"assessment_id": "eq.%s" % assessment_id,
         "select": "assessment_id,reference_note"})
    notes = client.select(
        "course_notes",
        {"assessment_id": "eq.%s" % assessment_id,
         "select": "storage_path,filename", "order": "filename"})
    reference_note = rubric_rows[0].get("reference_note", "") if rubric_rows else ""
    return rows[0], questions, schemes, reference_note, notes


def process_job(client, job, workers=3):
    """Run one claimed job, dispatching on its type.

    Errors are recorded on the job; KeyboardInterrupt marks the job and
    is re-raised so the loop exits.
    """
    if job.get("type", "build_rubric") == "mark_all":
        return process_mark_job(client, job, workers=workers)
    return process_rubric_job(client, job)


def process_rubric_job(client, job):
    """Run one claimed build_rubric job.

    Errors are recorded on the job; KeyboardInterrupt marks the job and
    is re-raised so the loop exits.
    """
    job_id = job["id"]
    assessment_id = job["assessment_id"]
    progress = _Progress(client, job_id)
    try:
        progress.update(force=True, stage="reading_notes", points=0)
        assessment_row, questions, schemes, reference_note, notes = \
            _load_job_inputs(client, assessment_id)
        assessment = build_assessment(
            assessment_row, questions, schemes, reference_note)
        missing = _missing_scheme_labels(assessment)
        if not notes and missing:
            raise RuntimeError(
                "%s has no marking scheme and no course notes were uploaded."
                % ", ".join(missing))
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        run_dir = (Path("worker") / "runs") / ("%s_rubric_%s" % (assessment_id, stamp))

        def on_point(count):
            try:
                progress.update(stage="drafting", points=count)
            except Exception:
                pass

        with tempfile.TemporaryDirectory() as tmp:
            notes_dir = None
            if notes:
                notes_dir = Path(tmp) / "notes"
                notes_dir.mkdir()
                for row, name in zip(notes, _local_note_names(notes)):
                    (notes_dir / name).write_bytes(
                        client.download(NOTES_BUCKET, row["storage_path"]))
            progress.update(force=True, stage="drafting",
                            points=progress.state.get("points", 0))
            result = draft_rubric(assessment, notes_dir, run_dir,
                                  on_progress=on_point)
            notes_pages = _count_notes_pages(tmp)
        progress.update(force=True, stage="saving",
                        points=len(result["points"]), notes_pages=notes_pages,
                        unreadable_pages=result.get("unreadable", []),
                        warnings=result.get("warnings", []),
                        usage=result.get("usage", {}))
        errors = check_rubric(
            {"assessment_id": assessment_id, "points": result["points"]},
            assessment)
        if errors:
            raise RuntimeError("invalid rubric: %s" % "; ".join(errors))
        client.upsert(
            "rubrics",
            {"assessment_id": assessment_id, "points": result["points"],
             "approved": False, "updated_at": _now_iso()},
            on_conflict="assessment_id")
        client.update(
            "marking_jobs",
            {"status": "done", "progress": progress.state, "error": None,
             "updated_at": _now_iso()},
            {"id": "eq.%s" % job_id})
        print("job %s done (%d points)" % (job_id, len(result["points"])))
    except KeyboardInterrupt:
        try:
            client.update(
                "marking_jobs",
                {"status": "error", "error": STOPPED_MESSAGE,
                 "updated_at": _now_iso()},
                {"id": "eq.%s" % job_id})
        except Exception:
            pass
        raise
    except Exception as exc:
        traceback.print_exc()
        message = _short_message(exc)
        try:
            client.update(
                "marking_jobs",
                {"status": "error", "error": message,
                 "updated_at": _now_iso()},
                {"id": "eq.%s" % job_id})
        except Exception:
            traceback.print_exc()
        print("job %s error: %s" % (job_id, message), file=sys.stderr)


def _load_mark_inputs(client, assessment_id):
    rows = client.select(
        "assessments",
        {"id": "eq.%s" % assessment_id, "select": "id,title,answer_mode"})
    if not rows:
        raise RuntimeError("assessment not found")
    questions = client.select(
        "questions",
        {"assessment_id": "eq.%s" % assessment_id,
         "select": "id,code,position,prompt,max_marks,subparts",
         "order": "position"})
    schemes = []
    if questions:
        schemes = client.select(
            "marking_schemes",
            {"question_id": "in.(%s)" % ",".join(
                q["id"] for q in questions),
             "select": "question_id,scheme"})
    rubric_rows = client.select(
        "rubrics",
        {"assessment_id": "eq.%s" % assessment_id,
         "select": "assessment_id,points,approved,reference_note"})
    rubric = rubric_rows[0] if rubric_rows else None
    return rows[0], questions, schemes, rubric


def _load_unmarked_submissions(client, assessment_id):
    """Submitted submissions with no results row yet, or a failed one.

    A re-run retries incomplete, unapproved scripts; marked,
    needs_review and approved rows are left alone.
    """
    subs = client.select(
        "submissions",
        {"assessment_id": "eq.%s" % assessment_id,
         "status": "eq.submitted",
         "select": "id,student_id,script_path"})
    if not subs:
        return []
    have = client.select(
        "results",
        {"submission_id": "in.(%s)" % ",".join(s["id"] for s in subs),
         "select": "submission_id,status,approved"})
    finished = {row["submission_id"] for row in have
                if not (row.get("status") == "incomplete"
                        and not row.get("approved"))}
    return [sub for sub in subs if sub["id"] not in finished]


def _typed_answers(client, questions, submissions):
    """{submission_id: [{question_id: code, text}]} from answers rows."""
    code_by_id = {q["id"]: q["code"] for q in questions}
    rows = client.select(
        "answers",
        {"submission_id": "in.(%s)" % ",".join(s["id"] for s in submissions),
         "select": "submission_id,question_id,text"})
    by_submission = {sub["id"]: [] for sub in submissions}
    for row in rows:
        code = code_by_id.get(row["question_id"])
        if code is None or row["submission_id"] not in by_submission:
            continue
        by_submission[row["submission_id"]].append(
            {"question_id": code, "text": row.get("text", "")})
    return by_submission


def _not_found_segments(codes):
    return {code: {"found": False, "start_quote": None, "page": None,
                   "text": ""}
            for code in codes}


def _empty_usage():
    return {"input_tokens": 0, "output_tokens": 0,
            "segmentation": {"input_tokens": 0, "output_tokens": 0}}


def _upsert_result(client, submission_id, max_marks, status, scores, awards,
                   flags, usage, segments, total_marks):
    """Write one results row. Never touches overrides (merge keeps it)."""
    client.upsert(
        "results",
        {"submission_id": submission_id, "status": status,
         "scores": scores, "awards": awards, "flags": flags,
         "usage": usage, "segments": segments,
         "total_marks": total_marks, "max_marks": max_marks,
         "marked_at": _now_iso(), "approved": False, "published": False},
        on_conflict="submission_id")


def _mark_single(client, assessment, rubric, sub, answer_mode, typed,
                 codes, max_marks):
    """Mark one submission and upsert its results row.

    Returns (status, usage_in, usage_out). Raises on failure.
    """
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = (Path("worker") / "runs") / ("%s_%s_%s" % (
        assessment["id"], sub["id"], stamp))
    segments = {}
    seg_usage = {"input_tokens": 0, "output_tokens": 0}
    answers = None
    with tempfile.TemporaryDirectory() as tmp:
        if answer_mode == "pdf":
            if not sub.get("script_path"):
                raise RuntimeError("no script uploaded")
            script = Path(tmp) / "script.pdf"
            script.write_bytes(
                client.download(SCRIPTS_BUCKET, sub["script_path"]))
            pages = extract_pdf_pages(script)
            if not any((page or "").strip() for page in pages):
                flags = [{"question_id": code, "reason": "illegible",
                          "note": ILLEGIBLE_NOTE} for code in codes]
                _upsert_result(client, sub["id"], max_marks, "needs_review",
                               {}, [], flags, _empty_usage(),
                               _not_found_segments(codes), 0)
                return ("needs_review", 0, 0)
            located = locate_answers(assessment["questions"], pages)
            seg_usage = located["usage"]
            segments = located["segments"]
            answers = [{"question_id": code,
                        "text": segments[code]["text"]} for code in codes]
        else:
            answers = typed.get(sub["id"], [])
        submission = {"student_id": sub.get("student_id"), "answers": answers}
        result = mark_submission(
            assessment, rubric, submission, tmp, run_dir)
    marking_usage = result.get("usage", {})
    usage = {
        "input_tokens": marking_usage.get("input_tokens", 0)
        + seg_usage.get("input_tokens", 0),
        "output_tokens": marking_usage.get("output_tokens", 0)
        + seg_usage.get("output_tokens", 0),
        "segmentation": {"input_tokens": seg_usage.get("input_tokens", 0),
                         "output_tokens": seg_usage.get("output_tokens", 0)},
    }
    _upsert_result(client, sub["id"], max_marks, result["status"],
                   result.get("scores", {}), result.get("awards", []),
                   result.get("flags", []), usage, segments,
                   result.get("total_marks", 0))
    return (result["status"], usage["input_tokens"], usage["output_tokens"])


def _mark_all_usage():
    return {"input_tokens": 0, "output_tokens": 0}


def process_mark_job(client, job, workers=3):
    """Run one claimed mark_all job.

    Errors are recorded on the job; KeyboardInterrupt marks the job and
    is re-raised so the loop exits.
    """
    job_id = job["id"]
    assessment_id = job["assessment_id"]
    progress = _Progress(client, job_id)
    try:
        progress.update(force=True, stage="marking", total=0, done=0,
                        needs_review=0, incomplete=0,
                        usage=_mark_all_usage())
        assessment_row, questions, schemes, rubric_row = _load_mark_inputs(
            client, assessment_id)
        if not rubric_row or not rubric_row.get("approved"):
            raise RuntimeError("The rubric isn't approved.")
        assessment = build_assessment(
            assessment_row, questions, schemes,
            rubric_row.get("reference_note", ""))
        rubric = {"assessment_id": assessment_id,
                  "points": rubric_row.get("points", [])}
        submissions = _load_unmarked_submissions(client, assessment_id)
        if not submissions:
            progress.update(force=True, stage="marking", total=0, done=0,
                            note="Nothing new to mark.")
            client.update(
                "marking_jobs",
                {"status": "done", "progress": progress.state, "error": None,
                 "updated_at": _now_iso()},
                {"id": "eq.%s" % job_id})
            print("job %s done (nothing new to mark)" % job_id)
            return
        answer_mode = assessment_row.get("answer_mode", "typed")
        codes = [q["id"] for q in assessment["questions"]]
        max_marks = sum(
            q.get("max_marks", 0) for q in assessment["questions"]
            if isinstance(q.get("max_marks"), (int, float)))
        typed = {}
        if answer_mode != "pdf":
            typed = _typed_answers(client, questions, submissions)

        def work(sub):
            try:
                return _mark_single(client, assessment, rubric, sub,
                                    answer_mode, typed, codes, max_marks)
            except Exception as exc:
                traceback.print_exc()
                try:
                    _upsert_result(
                        client, sub["id"], max_marks, "incomplete", {}, [],
                        [{"reason": "other",
                          "note": _short_message(exc)}],
                        _empty_usage(), {}, 0)
                except Exception:
                    traceback.print_exc()
                return ("incomplete", 0, 0)

        total = len(submissions)
        done = needs_review = incomplete = 0
        usage_in = usage_out = 0
        pool = ThreadPoolExecutor(max_workers=max(1, workers))
        try:
            pending = {pool.submit(work, sub): sub["id"]
                       for sub in submissions}
            for future in as_completed(pending):
                status, uin, uout = future.result()
                done += 1
                usage_in += uin
                usage_out += uout
                if status == "needs_review":
                    needs_review += 1
                elif status == "incomplete":
                    incomplete += 1
                print("%s: %s" % (pending[future], status))
                progress.update(stage="marking", total=total, done=done,
                                needs_review=needs_review,
                                incomplete=incomplete,
                                usage={"input_tokens": usage_in,
                                       "output_tokens": usage_out})
        except KeyboardInterrupt:
            pool.shutdown(wait=False, cancel_futures=True)
            raise
        except Exception:
            pool.shutdown(wait=True)
            raise
        else:
            pool.shutdown(wait=True)
        progress.update(force=True, stage="marking", total=total, done=done,
                        needs_review=needs_review, incomplete=incomplete,
                        usage={"input_tokens": usage_in,
                               "output_tokens": usage_out})
        client.update(
            "marking_jobs",
            {"status": "done", "progress": progress.state, "error": None,
             "updated_at": _now_iso()},
            {"id": "eq.%s" % job_id})
        print("job %s done (%d marked, %d needs_review, %d incomplete)"
              % (job_id, done - needs_review - incomplete,
                 needs_review, incomplete))
    except KeyboardInterrupt:
        try:
            client.update(
                "marking_jobs",
                {"status": "error", "error": STOPPED_MESSAGE,
                 "updated_at": _now_iso()},
                {"id": "eq.%s" % job_id})
        except Exception:
            pass
        raise
    except Exception as exc:
        traceback.print_exc()
        message = _short_message(exc)
        try:
            client.update(
                "marking_jobs",
                {"status": "error", "error": message,
                 "updated_at": _now_iso()},
                {"id": "eq.%s" % job_id})
        except Exception:
            traceback.print_exc()
        print("job %s error: %s" % (job_id, message), file=sys.stderr)


def _first_job(rows):
    if not rows:
        return None
    if isinstance(rows, dict):
        return rows
    return rows[0] if rows else None


def _reset_stale_working(client):
    """Fail 'working' jobs idle over STALE_MINUTES. Returns the count reset."""
    cutoff = (datetime.now(timezone.utc)
              - timedelta(minutes=STALE_MINUTES)).isoformat()
    rows = client.update(
        "marking_jobs",
        {"status": "error", "error": STOPPED_MESSAGE,
         "updated_at": _now_iso()},
        {"status": "eq.working", "updated_at": "lt.%s" % cutoff})
    count = len(rows) if rows else 0
    print("reset %d stale working job(s)" % count)
    return count


def run_loop(client, once=False, interval=5, workers=3):
    """Claim and run jobs until none remain (--once) or forever."""
    while True:
        try:
            _reset_stale_working(client)
            job = _first_job(
                client.rpc("claim_marking_job", {"p_type": "build_rubric"}))
            if job is None:
                job = _first_job(
                    client.rpc("claim_marking_job", {"p_type": "mark_all"}))
        except Exception:
            traceback.print_exc()
            if once:
                return 1
            time.sleep(interval)
            continue
        if job is None:
            if once:
                return 0
            time.sleep(interval)
            continue
        print("claimed %s job %s for assessment %s"
              % (job.get("type", "build_rubric"), job["id"],
                 job["assessment_id"]))
        try:
            process_job(client, job, workers=workers)
        except Exception:
            traceback.print_exc()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Markwise job runner")
    parser.add_argument("--once", action="store_true",
                        help="exit when no queued job remains")
    parser.add_argument("--interval", type=float, default=5,
                        help="seconds to sleep when idle (default 5)")
    parser.add_argument("--workers", type=int, default=3,
                        help="parallel marking threads (default 3)")
    args = parser.parse_args(argv)
    client = SupabaseClient()
    try:
        return run_loop(client, once=args.once, interval=args.interval,
                        workers=args.workers)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
