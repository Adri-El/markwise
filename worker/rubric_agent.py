"""Tool-using agent that drafts rubric.json from course notes + scheme.

Mirrors the marking loop in agent.py: the model chooses every tool call;
code verifies source quotes, mark steps, and per-question coverage.
"""

import json
from pathlib import Path

from .agent import (
    _client_from_env,
    _model_from_env,
    _output_items_for_input,
    _parse_response,
    _responses_create,
    _usage_of,
)
from .notes import search_notes
from .tools import check_rubric, is_half_mark, quote_in_text

BUILDER_SYSTEM = """You draft a marking rubric: one set of marking points per question.

Rules:
- Use search_notes and read_notes_page to find what the course notes say.
- Add every point with add_point: a short description and max marks
  (a positive multiple of 0.5).
- When a question HAS a lecturer marking scheme, the scheme is authoritative:
  it sets the points and the mark split. Use the notes only for source quotes
  and accept/reject notes.
- Without a scheme, derive points and marks from the notes and the question.
- Every source_quote must appear word-for-word on the cited file and page;
  the tool rejects invented or misplaced quotes.
- If a point cannot be supported by the notes or the scheme, still add it
  with needs_lecturer true and a reason saying what is missing.
- Each question's point maxima must sum to at least the question's max marks.
- Call finish when every question is covered. Fix any errors it reports.
"""


def question_has_scheme(assessment, question_id):
    """True when the lecturer wrote a marking scheme for one question."""
    scheme = assessment.get("marking_scheme")
    if not isinstance(scheme, dict):
        return False
    return bool(str(scheme.get(question_id) or "").strip())


def build_builder_context(assessment, notes_entries, ignore_scheme):
    """Lecturer content for the first message. No student text exists yet."""
    lines = [
        "Assessment: %s (%s)"
        % (assessment.get("title", ""), assessment.get("id", "")),
    ]
    for q in assessment.get("questions", []):
        lines.append(
            "Question %s (max %s): %s"
            % (q.get("id"), q.get("max_marks"), q.get("prompt", ""))
        )
        if ignore_scheme:
            lines.append("  (drafting from notes only: no marking scheme shown)")
        elif question_has_scheme(assessment, q.get("id")):
            lines.append("  Scheme (authoritative): %s"
                         % assessment["marking_scheme"][q["id"]])
        else:
            lines.append("  (no marking scheme: derive points from notes)")
    if assessment.get("reference_note"):
        lines.append("Reference note (lecturer rules, applies to the whole "
                     "assessment): %s" % assessment["reference_note"])
    files = {}
    for entry in notes_entries:
        files.setdefault(entry["file"], {"pages": 0, "unreadable": 0})
        files[entry["file"]]["pages"] += 1
        if entry.get("unreadable"):
            files[entry["file"]]["unreadable"] += 1
    lines.append("Notes files (search these, quote file and page):")
    for fname in sorted(files):
        info = files[fname]
        note = "" if not info["unreadable"] else \
            " (%d unreadable)" % info["unreadable"]
        lines.append("  - %s (%d pages%s)" % (fname, info["pages"], note))
    return "\n".join(lines)


class RubricBuilderState:
    """Mutable draft: notes index plus the points added so far."""

    def __init__(self, assessment, notes_entries, ignore_scheme=False):
        self.assessment = assessment
        self.notes = {(e["file"], e["page"]): e for e in notes_entries}
        self.entries = notes_entries
        self.ignore_scheme = ignore_scheme
        self.questions = {q["id"]: q for q in assessment.get("questions", [])}
        self.points = []
        self._next_id = 1

    # -- tools --

    def search_notes(self, query, top_k=5):
        if not query or not str(query).strip():
            return {"ok": False, "error": "a query is required"}
        return {"ok": True,
                "passages": search_notes(self.entries, query, top_k)}

    def read_notes_page(self, file, page):
        try:
            page = int(page)
        except (TypeError, ValueError):
            return {"ok": False, "error": "page must be an integer"}
        if (file, page) not in self.notes:
            return {"ok": False, "error": "unknown file/page %r p.%s"
                    % (file, page)}
        entry = self.notes[(file, page)]
        result = {"ok": True, "file": file, "page": page,
                  "text": entry.get("text", "")}
        if entry.get("section"):
            result["section"] = entry["section"]
        return result

    def add_point(self, question_id, description, max_marks, subpart=None,
                  source_quote=None, source_file=None, source_page=None,
                  accept=None, reject=None, needs_lecturer=False, reason=None):
        if question_id not in self.questions:
            return {"ok": False, "error": "unknown question_id %r"
                    % question_id}
        if not description or not str(description).strip():
            return {"ok": False, "error": "a description is required"}
        if not is_half_mark(max_marks) or max_marks <= 0:
            return {"ok": False,
                    "error": "max_marks must be a positive multiple of 0.5"}
        if subpart is not None and not str(subpart).strip():
            return {"ok": False, "error": "subpart must be non-empty or omitted"}
        for key, notes in (("accept", accept), ("reject", reject)):
            if notes is not None and (
                    not isinstance(notes, list)
                    or not all(isinstance(n, str) for n in notes)):
                return {"ok": False,
                        "error": "%s must be a list of strings" % key}
        if not isinstance(needs_lecturer, bool):
            return {"ok": False,
                    "error": "needs_lecturer must be true or false"}
        if needs_lecturer and not (reason and str(reason).strip()):
            return {"ok": False,
                    "error": "a reason is required when needs_lecturer is true"}
        trio = (source_quote, source_file, source_page)
        if any(v is not None for v in trio):
            if not (source_quote and str(source_quote).strip()
                    and source_file and str(source_file).strip()
                    and source_page is not None):
                return {"ok": False, "error":
                        "source needs quote, file and page together"}
            try:
                source_page = int(source_page)
            except (TypeError, ValueError):
                return {"ok": False,
                        "error": "source_page must be an integer"}
            entry = self.notes.get((str(source_file), source_page))
            if entry is None:
                return {"ok": False, "error": "unknown file/page %r p.%s"
                        % (source_file, source_page)}
            if not quote_in_text(source_quote, entry.get("text", "")):
                return {"ok": False, "error":
                        "source quote not found on that file/page"}
        point = {"id": "p%d" % self._next_id, "question_id": question_id,
                 "description": str(description),
                 "max_marks": float(max_marks)}
        self._next_id += 1
        if subpart is not None:
            point["subpart"] = str(subpart)
        if source_quote is not None:
            point["source_quote"] = str(source_quote)
            point["source_file"] = str(source_file)
            point["source_page"] = int(source_page)
            if entry.get("section"):
                point["source_section"] = entry["section"]
        if accept is not None:
            point["accept"] = list(accept)
        if reject is not None:
            point["reject"] = list(reject)
        if needs_lecturer:
            point["needs_lecturer"] = True
            point["reason"] = str(reason)
        self.points.append(point)
        return {"ok": True, "point_id": point["id"]}

    def finish(self):
        rubric = {"assessment_id": self.assessment.get("id"),
                  "points": self.points}
        errors = check_rubric(rubric, self.assessment)
        if errors:
            return {"ok": False, "error": "; ".join(errors), "errors": errors}
        return {"ok": True, "points": self.points}


def get_builder_tool_schemas():
    """Function-tool schemas for the rubric builder agent."""
    return [
        {
            "type": "function",
            "name": "search_notes",
            "description": "Keyword-search the course notes; returns file, page and text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "top_k": {"type": "integer"},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "read_notes_page",
            "description": "Read one full notes page by file and page number.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "page": {"type": "integer"},
                },
                "required": ["file", "page"],
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "add_point",
            "description": (
                "Add one rubric point. Source quotes must appear word-for-word "
                "on the cited file/page. Points without notes or scheme support "
                "need needs_lecturer true plus a reason."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question_id": {"type": "string"},
                    "subpart": {"type": "string"},
                    "description": {"type": "string"},
                    "max_marks": {"type": "number"},
                    "source_quote": {"type": "string"},
                    "source_file": {"type": "string"},
                    "source_page": {"type": "integer"},
                    "accept": {"type": "array", "items": {"type": "string"}},
                    "reject": {"type": "array", "items": {"type": "string"}},
                    "needs_lecturer": {"type": "boolean"},
                    "reason": {"type": "string"},
                },
                "required": ["question_id", "description", "max_marks"],
                "additionalProperties": False,
            },
        },
        {
            "type": "function",
            "name": "finish",
            "description": "Finish drafting. Refused until the rubric validates.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
    ]


def _dispatch(state, name, arguments):
    try:
        args = json.loads(arguments or "{}")
    except ValueError:
        return {"ok": False, "error": "tool arguments were not valid JSON"}
    if not isinstance(args, dict):
        return {"ok": False, "error": "tool arguments must be an object"}
    if name == "search_notes":
        return state.search_notes(args.get("query"), args.get("top_k", 5))
    if name == "read_notes_page":
        return state.read_notes_page(args.get("file"), args.get("page"))
    if name == "add_point":
        return state.add_point(
            args.get("question_id"), args.get("description"),
            args.get("max_marks"), subpart=args.get("subpart"),
            source_quote=args.get("source_quote"),
            source_file=args.get("source_file"),
            source_page=args.get("source_page"),
            accept=args.get("accept"), reject=args.get("reject"),
            needs_lecturer=args.get("needs_lecturer", False),
            reason=args.get("reason"))
    if name == "finish":
        return state.finish()
    return {"ok": False, "error": "unknown tool %r" % name}


def build_rubric_with_agent(assessment, notes_entries, run_dir,
                            ignore_scheme=False, client=None, model=None):
    """Draft rubric points with the tool-using agent. Returns points + usage."""
    state = RubricBuilderState(assessment, notes_entries, ignore_scheme)
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    client = client or _client_from_env()
    model = model or _model_from_env()
    tools = get_builder_tool_schemas()
    total_marks = sum(
        q.get("max_marks", 0) for q in assessment.get("questions", [])
        if isinstance(q.get("max_marks"), (int, float)))
    budget = 20 + 4 * total_marks

    context = build_builder_context(assessment, notes_entries, ignore_scheme)
    conversation = [
        {"role": "user", "content": "%s\n\nDraft the full rubric." % context},
    ]

    usage_in, usage_out = 0, 0
    calls_made, turns, empty_streak = 0, 0, 0
    transcript_path = run_dir / "transcript.jsonl"

    with transcript_path.open("w") as log:
        while True:
            turns += 1
            try:
                response = _responses_create(
                    client, model, tools, BUILDER_SYSTEM, conversation
                )
            except Exception as exc:
                log.write(json.dumps({"turn": turns, "api_error": str(exc)}) + "\n")
                raise RuntimeError("API error: %s" % exc)
            in_tok, out_tok = _usage_of(response)
            usage_in += in_tok
            usage_out += out_tok
            text, calls = _parse_response(response)
            entry = {
                "turn": turns,
                "model_text": text,
                "tool_calls": [
                    {"name": c["name"], "arguments": c["arguments"]} for c in calls
                ],
                "usage": {"input_tokens": in_tok, "output_tokens": out_tok},
                "tool_results": [],
            }
            conversation.extend(_output_items_for_input(response, text))

            if not calls:
                empty_streak += 1
                log.write(json.dumps(entry) + "\n")
                if empty_streak >= 3:
                    raise RuntimeError("model stopped calling tools")
                conversation.append({
                    "role": "user",
                    "content": "Continue: you must call a tool until finish succeeds.",
                })
                continue
            empty_streak = 0

            outputs = []
            for call in calls:
                calls_made += 1
                if calls_made > budget:
                    log.write(json.dumps(entry) + "\n")
                    counts = {}
                    for point in state.points:
                        qid = point["question_id"]
                        counts[qid] = counts.get(qid, 0) + 1
                    order = [q["id"]
                             for q in state.assessment.get("questions", [])]
                    per_question = ", ".join(
                        "%s: %d" % (qid, counts.get(qid, 0)) for qid in order)
                    raise RuntimeError(
                        "turn budget exceeded after %d tool calls "
                        "(points added: %s)" % (calls_made, per_question))
                tool_result = _dispatch(state, call["name"], call["arguments"])
                entry["tool_results"].append({
                    "call_id": call["call_id"], "name": call["name"],
                    "result": tool_result,
                })
                outputs.append({
                    "type": "function_call_output",
                    "call_id": call["call_id"],
                    "output": json.dumps(tool_result),
                })
                if call["name"] == "finish" and tool_result.get("ok"):
                    log.write(json.dumps(entry) + "\n")
                    return {
                        "points": tool_result["points"],
                        "usage": {"input_tokens": usage_in,
                                  "output_tokens": usage_out},
                        "turns": turns,
                        "tool_calls": calls_made,
                    }
            log.write(json.dumps(entry) + "\n")
            conversation.extend(outputs)
