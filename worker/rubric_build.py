"""Draft a rubric from an assessment plus optional course notes.

Shared by the build-rubric CLI and the Supabase job runner: with notes the
tool-using agent drafts the points, otherwise one model call converts the
lecturer's marking scheme. Callers validate with tools.check_rubric.
"""

import json
from pathlib import Path

from .agent import (
    _client_from_env,
    _model_from_env,
    _responses_create,
    _usage_of,
)
from .notes import extract_notes, has_notes

RUBRIC_SYSTEM = """You convert a lecturer's marking scheme into marking points.
Output JSON only: an object {"points": [...]} where each point has
id (p1, p2, ...), question_id, optional subpart, description, and
max_marks (a positive multiple of 0.5). Cover every question, and make
each question's maxima sum to at least its max_marks (above is fine for
'any N of' schemes). No other text."""


def _extract_points(text):
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(cleaned.splitlines()[1:])
        if cleaned.rstrip().endswith("```"):
            cleaned = "\n".join(cleaned.splitlines()[:-1])
    try:
        data = json.loads(cleaned)
    except ValueError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        data = json.loads(cleaned[start:end + 1])
    if isinstance(data, list):
        return data
    return data.get("points", [])


def _single_call_points(assessment):
    """One model call over the scheme. Returns (points, usage)."""
    user_content = "Questions: %s\nMarking scheme: %s" % (
        json.dumps(assessment.get("questions", [])),
        json.dumps(assessment.get("marking_scheme", "")),
    )
    client = _client_from_env()
    model = _model_from_env()
    response = _responses_create(
        client, model, [], RUBRIC_SYSTEM,
        [{"role": "user", "content": user_content}],
    )
    texts = []
    for item in getattr(response, "output", []) or []:
        content = getattr(item, "content", None)
        if content is None and isinstance(item, dict):
            content = item.get("content", [])
        for part in content or []:
            text = part.get("text", "") if isinstance(part, dict) \
                else getattr(part, "text", "") or ""
            if text:
                texts.append(text)
    points = _extract_points("\n".join(texts))
    in_tok, out_tok = _usage_of(response)
    return points, {"input_tokens": in_tok, "output_tokens": out_tok}


def draft_rubric(assessment, notes_dir, run_dir, ignore_scheme=False,
                 on_progress=None):
    """Draft rubric points. Returns {points, warnings, unreadable, usage}.

    notes_dir is a directory of course notes or None; run_dir is the run
    folder for the agent transcript (unused without notes). on_progress,
    when given, is called after each successful add_point with the
    running point count.
    """
    from .rubric_agent import build_rubric_with_agent

    if notes_dir is not None and has_notes(notes_dir):
        notes_dir = Path(notes_dir)
        run_dir = Path(run_dir)
        entries, unreadable = extract_notes(
            notes_dir, notes_dir.parent / "notes_text.json")
        files = sorted({entry["file"] for entry in entries})
        print("notes: %d page(s) from %d file(s)" % (len(entries), len(files)))
        for page in unreadable:
            print("warning: no extractable text (scanned?): %s p.%s"
                  % (page["file"], page["page"]))
        result = build_rubric_with_agent(
            assessment, entries, run_dir, ignore_scheme=ignore_scheme,
            on_progress=on_progress)
        return {"points": result["points"],
                "warnings": result.get("warnings", []),
                "unreadable": unreadable,
                "usage": result["usage"]}
    points, usage = _single_call_points(assessment)
    return {"points": points, "warnings": [], "unreadable": [],
            "usage": usage}
