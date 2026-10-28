"""Post-batch consistency check: same evidence, different marks?

Compares decisions on each rubric point across one mark-all batch.
Two conflict kinds:
- similar_quotes: two quoted awards with similar quotes, different marks
- quote_in_answer: one student's awarded quote also appears in another
  student's stored answer, where the point got different marks (e.g. 0)
"""

import json
from pathlib import Path

from .tools import quotes_similar

COMPLETE_STATUSES = ("marked", "needs_review")


def collect_run(run_dir):
    """Load awards and stored answers from one run folder."""
    run_dir = Path(run_dir)
    result = json.loads((run_dir / "result.json").read_text())
    stored = {}
    answers_dir = run_dir / "answers"
    if answers_dir.is_dir():
        for path in answers_dir.glob("*.txt"):
            stored[path.stem] = path.read_text()
    return {
        "student_id": result.get("student_id"),
        "status": result.get("status"),
        "awards": {a["point_id"]: a for a in result.get("awards", [])},
        "stored": stored,
    }


def _conflict(kind, pid, qid, run_a, award_a, run_b, award_b):
    return {
        "kind": kind,
        "point_id": pid,
        "question_id": qid,
        "a": {"student": run_a["student_id"], "marks": award_a["marks"],
              "quote": award_a.get("quote", "")},
        "b": {"student": run_b["student_id"], "marks": award_b["marks"],
              "quote": award_b.get("quote", "")},
    }


def find_conflicts(rubric, runs):
    """Decisions on the same point with similar evidence, different marks."""
    points = {p["id"]: p for p in rubric.get("points", [])}
    by_point = {}
    for run in runs:
        for pid, award in run["awards"].items():
            by_point.setdefault(pid, []).append((run, award))
    conflicts = []
    for pid in sorted(by_point):
        qid = points.get(pid, {}).get("question_id")
        decisions = by_point[pid]
        quoted = [(r, a) for r, a in decisions
                  if (a.get("quote") or "").strip()]
        unquoted = [(r, a) for r, a in decisions
                    if not (a.get("quote") or "").strip()]
        for i in range(len(quoted)):
            for j in range(i + 1, len(quoted)):
                (run_a, award_a), (run_b, award_b) = quoted[i], quoted[j]
                if award_a["marks"] == award_b["marks"]:
                    continue
                if quotes_similar(award_a["quote"], award_b["quote"]):
                    conflicts.append(_conflict(
                        "similar_quotes", pid, qid,
                        run_a, award_a, run_b, award_b))
        for run_a, award_a in quoted:
            for run_b, award_b in unquoted:
                if award_a["marks"] == award_b["marks"]:
                    continue
                text = run_b["stored"].get(qid, "") if qid else ""
                if text and quotes_similar(award_a["quote"], text):
                    conflicts.append(_conflict(
                        "quote_in_answer", pid, qid,
                        run_a, award_a, run_b, award_b))
    return conflicts


def _short(quote):
    if not quote:
        return "(no quote)"
    quote = " ".join(str(quote).split())
    if len(quote) > 60:
        quote = quote[:57] + "..."
    return "%r" % quote


def write_consistency_report(assessment, rubric, run_dirs, runs_dir):
    """Check the new runs, save JSON, return console lines."""
    runs = [collect_run(d) for d in run_dirs]
    runs = [r for r in runs if r["status"] in COMPLETE_STATUSES]
    conflicts = find_conflicts(rubric, runs)
    assessment_id = assessment.get("id", "unknown")
    out_path = Path(runs_dir) / ("%s_consistency.json" % assessment_id)
    out_path.write_text(json.dumps({
        "assessment_id": assessment_id,
        "runs_checked": len(runs),
        "conflicts": conflicts,
    }, indent=2))
    if not conflicts:
        return ["consistency: no conflicts across %d runs (%s)"
                % (len(runs), out_path)]
    lines = ["consistency: %d conflict(s) across %d runs (%s)"
             % (len(conflicts), len(runs), out_path)]
    for c in conflicts:
        lines.append("  %s [%s]: %s (%s, %s) vs %s (%s, %s)" % (
            c["point_id"], c["kind"],
            c["a"]["student"], c["a"]["marks"], _short(c["a"]["quote"]),
            c["b"]["student"], c["b"]["marks"], _short(c["b"]["quote"])))
    return lines
