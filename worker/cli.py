"""Command line for the Markwise marking agent.

- build-rubric: draft rubric.json from assessment.json (lecturer edits after)
- mark-one: mark a single submission file
- mark-all: mark every submission in an assessment directory
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from .notes import has_notes
from .rubric_build import RUBRIC_SYSTEM, draft_rubric  # noqa: F401
from .tools import check_rubric


def load_json(path):
    return json.loads(Path(path).read_text())


def _save_rubric(assessment, points, rubric_path):
    """Validate and write a rubric file. Returns an exit code."""
    rubric = {"assessment_id": assessment.get("id"), "points": points}
    errors = check_rubric(rubric, assessment)
    if errors:
        print("invalid rubric:", file=sys.stderr)
        for error in errors:
            print("- %s" % error, file=sys.stderr)
        return 1
    rubric_path.parent.mkdir(parents=True, exist_ok=True)
    rubric_path.write_text(json.dumps(rubric, indent=2))
    return 0


def _rubric_run_dir(runs_dir, assessment_id, stamp):
    return (Path(runs_dir)
            / ("%s_rubric_%s" % (assessment_id, stamp)))


def _build_rubric_from_notes(assessment_dir, assessment, rubric_path,
                             ignore_scheme):
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = _rubric_run_dir(
        Path("worker") / "runs", assessment.get("id"), stamp)
    try:
        result = draft_rubric(
            assessment, assessment_dir / "notes", run_dir,
            ignore_scheme=ignore_scheme)
    except Exception as exc:
        print("rubric agent failed: %s" % exc, file=sys.stderr)
        return 1
    points = result["points"]
    code = _save_rubric(assessment, points, rubric_path)
    if code:
        return code
    counts = {}
    for point in points:
        counts[point["question_id"]] = counts.get(point["question_id"], 0) + 1
    per_question = ", ".join(
        "%s: %d" % (qid, counts[qid])
        for qid in [q["id"] for q in assessment.get("questions", [])]
        if qid in counts)
    sourced = sum(1 for point in points if point.get("source_file"))
    needy = sum(1 for point in points if point.get("needs_lecturer"))
    print("rubric: %d points (%s); %d with notes source, %d need lecturer"
          % (len(points), per_question, sourced, needy))
    for warning in result.get("warnings", []):
        print("warning: %s" % warning)
    print("wrote %s" % rubric_path)
    print("transcript: %s" % (run_dir / "transcript.jsonl"))
    usage = result["usage"]
    print("tokens: %d in, %d out"
          % (usage["input_tokens"], usage["output_tokens"]))
    return 0


def cmd_build_rubric(args):
    assessment_dir = Path(args.assessment_dir)
    assessment_path = assessment_dir / "assessment.json"
    rubric_path = Path(args.out) if args.out else assessment_dir / "rubric.json"
    if not assessment_path.exists():
        print("missing %s" % assessment_path, file=sys.stderr)
        return 2
    if rubric_path.exists() and not args.force:
        print("refusing to overwrite %s (use --force)" % rubric_path,
              file=sys.stderr)
        return 2
    assessment = load_json(assessment_path)
    if has_notes(assessment_dir / "notes"):
        return _build_rubric_from_notes(
            assessment_dir, assessment, rubric_path, args.ignore_scheme)
    try:
        result = draft_rubric(assessment, None, None)
    except ValueError:
        print("model did not return valid JSON", file=sys.stderr)
        return 1
    except Exception as exc:
        print("API error: %s" % exc, file=sys.stderr)
        return 1
    points = result["points"]
    code = _save_rubric(assessment, points, rubric_path)
    if code:
        return code
    print("wrote %s (%d points)" % (rubric_path, len(points)))
    return 0


def _run_marking(assessment, rubric, submission_path, runs_dir):
    from .agent import mark_submission

    submission_path = Path(submission_path)
    submission = load_json(submission_path)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = (Path(runs_dir)
               / ("%s_%s_%s" % (assessment.get("id"),
                                submission.get("student_id", "unknown"), stamp)))
    result = mark_submission(
        assessment, rubric, submission, submission_path.parent, run_dir
    )
    return submission_path, run_dir, result


def _mark_one_file(assessment, rubric, submission_path, runs_dir):
    submission_path, run_dir, result = _run_marking(
        assessment, rubric, submission_path, runs_dir)
    print("%s: %s %s/%s (%s)" % (
        submission_path.name, result["status"],
        result["total_marks"], result["max_marks"], run_dir))
    return result


def cmd_mark_one(args):
    assessment_dir = Path(args.assessment_dir)
    assessment = load_json(assessment_dir / "assessment.json")
    rubric_path = assessment_dir / "rubric.json"
    if not rubric_path.exists():
        print("refusing to start: missing %s (run build-rubric first)"
              % rubric_path, file=sys.stderr)
        return 2
    rubric = load_json(rubric_path)
    errors = check_rubric(rubric, assessment)
    if errors:
        print("invalid rubric.json:", file=sys.stderr)
        for error in errors:
            print("- %s" % error, file=sys.stderr)
        return 2
    _mark_one_file(assessment, rubric, args.submission, args.runs_dir)
    return 0


def cmd_mark_all(args):
    assessment_dir = Path(args.assessment_dir)
    assessment = load_json(assessment_dir / "assessment.json")
    rubric_path = Path(args.rubric) if args.rubric else assessment_dir / "rubric.json"
    if not rubric_path.exists():
        print("refusing to start: missing %s (run build-rubric first)"
              % rubric_path, file=sys.stderr)
        return 2
    rubric = load_json(rubric_path)
    errors = check_rubric(rubric, assessment)
    if errors:
        print("invalid rubric.json:", file=sys.stderr)
        for error in errors:
            print("- %s" % error, file=sys.stderr)
        return 2
    submissions = sorted((assessment_dir / "submissions").glob("*.json"))
    if not submissions:
        print("no submissions found", file=sys.stderr)
        return 1

    def work(path):
        try:
            name, run_dir, result = _run_marking(
                assessment, rubric, path, args.runs_dir)
            line = "%s: %s %s/%s (%s)" % (
                name.name, result["status"],
                result["total_marks"], result["max_marks"], run_dir)
            return line, run_dir
        except Exception as exc:
            return "%s: failed: %s" % (path.name, exc), None

    workers = max(1, args.workers)
    if workers == 1:
        outcomes = [work(path) for path in submissions]
    else:
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor(max_workers=workers) as pool:
            outcomes = list(pool.map(work, submissions))
    for line, _ in outcomes:
        print(line)
    new_runs = [run_dir for _, run_dir in outcomes if run_dir is not None]
    if new_runs:
        from .consistency import write_consistency_report

        try:
            summary = write_consistency_report(
                assessment, rubric, new_runs, args.runs_dir)
        except Exception as exc:
            print("consistency check failed: %s" % exc, file=sys.stderr)
        else:
            for line in summary:
                print(line)
    return 0


def _latest_run_dirs(assessment_id, runs_dir):
    """Newest run folder per student for one assessment."""
    latest = {}
    runs_dir = Path(runs_dir)
    if not runs_dir.is_dir():
        return []
    for result_path in sorted(runs_dir.glob("*/result.json")):
        try:
            result = json.loads(result_path.read_text())
        except (ValueError, OSError):
            continue
        if result.get("assessment_id") != assessment_id:
            continue
        student = result.get("student_id")
        if not student:
            continue
        mtime = result_path.stat().st_mtime
        if student not in latest or mtime > latest[student][0]:
            latest[student] = (mtime, result_path.parent)
    return [latest[student][1] for student in sorted(latest)]


def cmd_check_consistency(args):
    from .consistency import write_consistency_report

    assessment_dir = Path(args.assessment_dir)
    assessment = load_json(assessment_dir / "assessment.json")
    rubric_path = Path(args.rubric) if args.rubric else assessment_dir / "rubric.json"
    if not rubric_path.exists():
        print("missing %s (run build-rubric first)" % rubric_path,
              file=sys.stderr)
        return 2
    rubric = load_json(rubric_path)
    errors = check_rubric(rubric, assessment)
    if errors:
        print("invalid rubric.json:", file=sys.stderr)
        for error in errors:
            print("- %s" % error, file=sys.stderr)
        return 2
    run_dirs = _latest_run_dirs(assessment.get("id"), args.runs_dir)
    if not run_dirs:
        print("no runs found for %r" % assessment.get("id"), file=sys.stderr)
        return 1
    for line in write_consistency_report(
            assessment, rubric, run_dirs, args.runs_dir):
        print(line)
    return 0


def main(argv=None):
    from dotenv import load_dotenv

    load_dotenv()
    parser = argparse.ArgumentParser(description="Markwise marking agent")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build-rubric", help="draft rubric.json")
    build.add_argument("assessment_dir")
    build.add_argument("--force", action="store_true",
                       help="overwrite an existing rubric.json")
    build.add_argument("--ignore-scheme", action="store_true",
                       help="draft from notes only, ignoring any scheme")
    build.add_argument("--out",
                       help="write the rubric here instead of rubric.json")
    build.set_defaults(func=cmd_build_rubric)

    one = sub.add_parser("mark-one", help="mark one submission")
    one.add_argument("assessment_dir")
    one.add_argument("submission")
    one.add_argument("--runs-dir", default=str(Path("worker") / "runs"))
    one.set_defaults(func=cmd_mark_one)

    all_cmd = sub.add_parser("mark-all", help="mark every submission")
    all_cmd.add_argument("assessment_dir")
    all_cmd.add_argument("--runs-dir", default=str(Path("worker") / "runs"))
    all_cmd.add_argument("--workers", type=int, default=4,
                         help="parallel marking threads (default 4)")
    all_cmd.add_argument("--rubric",
                         help="use this rubric file instead of rubric.json")
    all_cmd.set_defaults(func=cmd_mark_all)

    check = sub.add_parser("check-consistency",
                           help="consistency check over latest runs")
    check.add_argument("assessment_dir")
    check.add_argument("--runs-dir", default=str(Path("worker") / "runs"))
    check.add_argument("--rubric",
                       help="use this rubric file instead of rubric.json")
    check.set_defaults(func=cmd_check_consistency)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
