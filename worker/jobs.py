"""Supabase-backed runner for build_rubric jobs.

Loop: claim a queued build_rubric job, draft the rubric from the stored
questions, schemes and course notes, write it back to rubrics.

Run as `python -m worker.jobs [--once] [--interval 5]`.
"""

import argparse
import json
import os
import sys
import tempfile
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .rubric_build import draft_rubric
from .supabase_client import SupabaseClient
from .tools import check_rubric

NOTES_BUCKET = "course-notes"
PROGRESS_INTERVAL = 2.0
STALE_MINUTES = 15
STOPPED_MESSAGE = "Worker stopped before finishing. Queue the job again."


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
    """Throttled marking_jobs.progress writer (at most one write per 2s)."""

    def __init__(self, client, job_id):
        self.client = client
        self.job_id = job_id
        self.state = {}
        self._last_write = 0.0

    def update(self, force=False, **fields):
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


def process_job(client, job):
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


def run_loop(client, once=False, interval=5):
    """Claim and run build_rubric jobs until none remain (--once) or forever."""
    while True:
        try:
            _reset_stale_working(client)
            job = _first_job(
                client.rpc("claim_marking_job", {"p_type": "build_rubric"}))
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
        print("claimed job %s for assessment %s"
              % (job["id"], job["assessment_id"]))
        try:
            process_job(client, job)
        except Exception:
            traceback.print_exc()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Markwise rubric job runner")
    parser.add_argument("--once", action="store_true",
                        help="exit when no queued job remains")
    parser.add_argument("--interval", type=float, default=5,
                        help="seconds to sleep when idle (default 5)")
    args = parser.parse_args(argv)
    client = SupabaseClient()
    try:
        return run_loop(client, once=args.once, interval=args.interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
