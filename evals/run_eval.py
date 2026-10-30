"""Score the marking agent against human marks.

Usage: python evals/run_eval.py <assessment_id>

Reads evals/ground_truth/<id>.json:
    {"assessment_id": ..., "marks": {student: {question: marks}},
     "expected_flags": {student: [reason, ...]}}

Compares with the latest run per student under worker/runs/ for that
assessment. Prints tables and saves a JSON summary to
evals/results/<id>_<timestamp>.json.

Students with no run are listed as missing and excluded from every stat.
Runs with status "incomplete" are listed but also excluded from the stats,
since their totals are partial.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS_DIR = ROOT / "worker" / "runs"
RESULTS_DIR = ROOT / "evals" / "results"

COMPLETE = ("marked", "needs_review")


def load_ground_truth(assessment_id):
    path = ROOT / "evals" / "ground_truth" / ("%s.json" % assessment_id)
    with path.open() as f:
        data = json.load(f)
    return data.get("marks", {}), data.get("expected_flags", {})


def latest_runs(assessment_id):
    """Map student_id -> result.json dict for the newest run each."""
    runs = {}
    if not RUNS_DIR.is_dir():
        return runs
    for result_path in sorted(RUNS_DIR.glob("*/result.json")):
        try:
            with result_path.open() as f:
                result = json.load(f)
        except (ValueError, OSError):
            continue
        if result.get("assessment_id") != assessment_id:
            continue
        student = result.get("student_id")
        if not student:
            continue
        mtime = result_path.stat().st_mtime
        if student not in runs or mtime > runs[student][0]:
            runs[student] = (mtime, result)
    return {student: result for student, (_, result) in runs.items()}


def point_question_map(assessment_id, rubric_path=None):
    """Map rubric point id -> question id (empty when no rubric)."""
    if rubric_path is None:
        rubric_path = ROOT / "data" / "sample" / assessment_id / "rubric.json"
    path = Path(rubric_path)
    try:
        with path.open() as f:
            points = json.load(f).get("points", [])
    except (ValueError, OSError):
        return {}
    return {p.get("id"): p.get("question_id") for p in points}


def evaluate(human_marks, expected_flags, runs, point_map):
    questions = sorted({q for marks in human_marks.values() for q in marks})
    students = []
    missing = []
    pairs = []  # {student, question, human, agent, diff} for complete runs
    for student in sorted(human_marks):
        human = human_marks[student]
        human_total = sum(human.get(q, 0) for q in questions)
        result = runs.get(student)
        if result is None:
            missing.append(student)
            students.append({"student": student, "human_total": human_total,
                             "agent_total": None, "difference": None,
                             "status": "missing", "flags": []})
            continue
        scores = result.get("scores", {})
        agent_total = result.get("total_marks")
        status = result.get("status", "?")
        flags = ["%s:%s" % (f.get("target"), f.get("reason"))
                 for f in result.get("flags", [])]
        difference = (round(agent_total - human_total, 2)
                      if isinstance(agent_total, (int, float)) else None)
        students.append({"student": student, "human_total": human_total,
                         "agent_total": agent_total, "difference": difference,
                         "status": status, "flags": flags})
        if status not in COMPLETE:
            continue
        for q in questions:
            if q not in human or q not in scores:
                continue
            agent_marks = scores[q].get("marks")
            if not isinstance(agent_marks, (int, float)):
                continue
            pairs.append({"student": student, "question": q,
                          "human": human[q], "agent": agent_marks,
                          "diff": abs(agent_marks - human[q])})

    by_question = {}
    for q in questions:
        diffs = [p["diff"] for p in pairs if p["question"] == q]
        if not diffs:
            by_question[q] = {"n": 0, "exact_rate": None,
                              "within1_rate": None, "mad": None}
            continue
        by_question[q] = {
            "n": len(diffs),
            "exact_rate": sum(1 for d in diffs if d == 0) / len(diffs),
            "within1_rate": sum(1 for d in diffs if d <= 1) / len(diffs),
            "mad": sum(diffs) / len(diffs),
        }

    all_diffs = [p["diff"] for p in pairs]
    if all_diffs:
        overall = {
            "n_pairs": len(all_diffs),
            "exact_rate": sum(1 for d in all_diffs if d == 0) / len(all_diffs),
            "within1_rate": sum(1 for d in all_diffs if d <= 1) / len(all_diffs),
            "mad_per_question": sum(all_diffs) / len(all_diffs),
        }
    else:
        overall = {"n_pairs": 0, "exact_rate": None,
                   "within1_rate": None, "mad_per_question": None}
    overall["total_diff_over_2"] = sorted(
        s["student"] for s in students
        if s["difference"] is not None and abs(s["difference"]) > 2
        and s["status"] in COMPLETE)

    disagreements = []
    for p in pairs:
        if p["diff"] == 0:
            continue
        student_flags = runs.get(p["student"], {}).get("flags", [])
        flagged = any(f.get("target") == p["question"]
                      or point_map.get(f.get("target")) == p["question"]
                      for f in student_flags)
        disagreements.append({"student": p["student"], "question": p["question"],
                              "human": p["human"], "agent": p["agent"],
                              "flagged": flagged})
    disagreement_summary = {
        "items": disagreements,
        "flagged": sum(1 for d in disagreements if d["flagged"]),
        "total": len(disagreements),
    }

    flag_check = {}
    for student, expected in expected_flags.items():
        reasons = {f.get("reason") for f in
                   runs.get(student, {}).get("flags", [])}
        flag_check[student] = {
            reason: ("present" if reason in reasons else "missing")
            for reason in expected}

    tokens = [runs[s].get("usage", {}) for s in runs
              if runs[s].get("status") in COMPLETE]
    total_in = sum(u.get("input_tokens", 0) for u in tokens)
    total_out = sum(u.get("output_tokens", 0) for u in tokens)
    usage = {"scripts": len(tokens), "input_tokens": total_in,
             "output_tokens": total_out, "total_tokens": total_in + total_out,
             "avg_tokens_per_script": (total_in + total_out) / len(tokens)
             if tokens else None}

    return {"students": students, "missing": missing,
            "by_question": by_question, "overall": overall,
            "disagreements": disagreement_summary,
            "flag_check": flag_check, "usage": usage}


def _table(rows):
    widths = [max(len(str(cell)) for cell in col) for col in zip(*rows)]
    return ["  ".join(str(cell).ljust(width)
                      for cell, width in zip(row, widths)) for row in rows]


def _pct(rate):
    return "n/a" if rate is None else "%5.1f%%" % (100 * rate)


def report_text(assessment_id, summary):
    lines = ["eval: %s" % assessment_id, ""]
    rows = [["student", "human", "agent", "diff", "status", "flags"]]
    for s in summary["students"]:
        rows.append([
            s["student"], s["human_total"],
            "n/a" if s["agent_total"] is None else s["agent_total"],
            "n/a" if s["difference"] is None else "%+g" % s["difference"],
            s["status"], ", ".join(s["flags"]) or "-"])
    lines.extend(_table(rows))
    lines += ["", "per question:"]
    rows = [["q", "n", "exact", "within-1", "mad"]]
    for q, stats in sorted(summary["by_question"].items()):
        rows.append([
            q, stats["n"], _pct(stats["exact_rate"]),
            _pct(stats["within1_rate"]),
            "n/a" if stats["mad"] is None else "%.2f" % stats["mad"]])
    lines.extend(_table(rows))
    overall = summary["overall"]
    lines += ["", "overall: %d (student, question) pairs" % overall["n_pairs"],
              "  exact agreement:   %s" % _pct(overall["exact_rate"]),
              "  within-1 agreement: %s" % _pct(overall["within1_rate"]),
              "  mean abs diff/q:    %s" % (
                  "n/a" if overall["mad_per_question"] is None
                  else "%.2f" % overall["mad_per_question"]),
              "  total differs by >2: %s" % (
                  ", ".join(overall["total_diff_over_2"]) or "none"),
              "  missing runs: %s" % (", ".join(summary["missing"]) or "none")]
    disag = summary["disagreements"]
    lines += ["", "disagreements:"]
    if disag["items"]:
        for d in disag["items"]:
            lines.append("  %s %s: human %s, agent %s, flagged %s" % (
                d["student"], d["question"], d["human"], d["agent"],
                "yes" if d["flagged"] else "no"))
    else:
        lines.append("  none")
    lines.append("disagreements flagged: %d of %d" % (
        disag["flagged"], disag["total"]))
    if summary["flag_check"]:
        lines += ["", "expected flags:"]
        for student, checks in sorted(summary["flag_check"].items()):
            for reason, state in checks.items():
                lines.append("  %s %s: %s" % (student, reason, state))
    usage = summary["usage"]
    lines += ["", "tokens: %d total over %d scripts (in %d, out %d)" % (
        usage["total_tokens"], usage["scripts"],
        usage["input_tokens"], usage["output_tokens"]),
        "avg tokens per script: %s" % (
            "n/a" if usage["avg_tokens_per_script"] is None
            else "%.0f" % usage["avg_tokens_per_script"])]
    return "\n".join(lines) + "\n"


def main(argv):
    args = list(argv[1:])
    rubric_path = None
    if "--rubric" in args:
        i = args.index("--rubric")
        if i + 1 >= len(args):
            print("usage: python evals/run_eval.py <assessment_id> [--rubric <file>]",
                  file=sys.stderr)
            return 2
        rubric_path = args[i + 1]
        del args[i:i + 2]
    if len(args) != 1:
        print("usage: python evals/run_eval.py <assessment_id> [--rubric <file>]",
              file=sys.stderr)
        return 2
    assessment_id = args[0]
    try:
        human_marks, expected_flags = load_ground_truth(assessment_id)
    except OSError:
        print("no ground truth for %r" % assessment_id, file=sys.stderr)
        return 1
    runs = latest_runs(assessment_id)
    summary = evaluate(human_marks, expected_flags, runs,
                         point_question_map(assessment_id, rubric_path))
    summary["assessment_id"] = assessment_id
    print(report_text(assessment_id, summary), end="")
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = RESULTS_DIR / ("%s_%s.json" % (assessment_id, stamp))
    with out_path.open("w") as f:
        json.dump(summary, f, indent=2)
    print("saved %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
