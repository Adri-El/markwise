"""Locate each question's answer inside a single-PDF exam script.

One model call finds the opening words of every answer; each quote is
verified against the script text, mapped back to an offset, and the
script is sliced into per-question answers.
"""

import json

from .agent import (
    _client_from_env,
    _model_from_env,
    _parse_response,
    _responses_create,
    _usage_of,
)
from .tools import quote_in_text

SEGMENT_SYSTEM = """You locate answers inside one student's exam script.
The script is plain text with [page n] markers. Students usually label
answers (Q1, 1., (a)) but may answer out of order or skip labels.
For each question code below, reply with the first 5-15 words of that
answer copied EXACTLY from the script, or null when the script has no
answer for it. Copy text exactly as written: never paraphrase, reorder
words, or invent text.
Reply with strict JSON only: an object mapping each question code to
its opening quote or null, e.g. {"q1": "Q1 osmosis is the movement",
"q2": null}. No other text."""


def build_script_text(pages):
    """Join pages into "[page n]\\n<text>" blocks.

    Returns (script_text, page_starts) where page_starts is a sorted
    list of (offset, page number) block starts.
    """
    blocks = []
    starts = []
    offset = 0
    for num, text in enumerate(pages, start=1):
        block = "[page %d]\n%s" % (num, text or "")
        if blocks:
            offset += 2  # "\n\n" separator
        starts.append((offset, num))
        blocks.append(block)
        offset += len(block)
    return "\n\n".join(blocks), starts


def _normalize_with_map(text):
    """Lowercase + collapse whitespace like tools.normalize.

    Returns (normalized, index) where index[i] is the original offset
    of normalized[i].
    """
    text = str(text).lower()
    chars = []
    index = []
    pending = False
    pending_at = 0
    for i, ch in enumerate(text):
        if ch.isspace():
            if chars and not pending:
                pending = True
                pending_at = i
            continue
        if pending:
            chars.append(" ")
            index.append(pending_at)
            pending = False
        chars.append(ch)
        index.append(i)
    return "".join(chars), index


def find_quote_start(script_text, quote):
    """Offset where quote starts in script_text, or None.

    Matching is normalised (case/whitespace-insensitive) and mapped
    back onto the original text; the first occurrence wins.
    """
    norm_script, index = _normalize_with_map(script_text)
    norm_quote, _ = _normalize_with_map(quote)
    if len(norm_quote) < 3:
        return None
    pos = norm_script.find(norm_quote)
    if pos < 0:
        return None
    return index[pos]


def slice_segments(script_text, starts):
    """Slice the script at answer starts (out of order is fine).

    starts is [(code, offset)]; each answer runs from its start to
    the next start, the last one to the end. Returns {code: text}.
    """
    ordered = sorted(starts, key=lambda item: item[1])
    segments = {}
    for i, (code, start) in enumerate(ordered):
        end = ordered[i + 1][1] if i + 1 < len(ordered) else len(script_text)
        segments[code] = script_text[start:end].strip()
    return segments


def page_at_offset(page_starts, offset):
    """1-based page number containing offset, or None."""
    page = None
    for start, num in page_starts:
        if start <= offset:
            page = num
        else:
            break
    return page


def _strip_fences(text):
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = "\n".join(cleaned.splitlines()[1:])
        if cleaned.rstrip().endswith("```"):
            cleaned = "\n".join(cleaned.splitlines()[:-1])
    return cleaned


def _parse_quotes(text, codes):
    """{code: quote or None}. Unparseable or invalid JSON: all None."""
    result = {code: None for code in codes}
    try:
        data = json.loads(_strip_fences(text))
    except ValueError:
        return result
    if not isinstance(data, dict):
        return result
    for code in codes:
        value = data.get(code)
        if isinstance(value, str) and value.strip():
            result[code] = value
    return result


def locate_answers(questions, pages, client=None, model=None):
    """Split a script into per-question answers.

    questions carry worker ids (codes). Returns {segments, usage} with
    segments {code: {found, start_quote, page, text}}. Parse failures
    leave every question not found; API errors propagate.
    """
    codes = [q["id"] for q in questions if q.get("id")]
    script_text, page_starts = build_script_text(pages)
    client = client or _client_from_env()
    model = model or _model_from_env()
    user_content = "Questions: %s\n\nScript:\n%s" % (
        json.dumps([{"code": q["id"],
                     "prompt": q.get("prompt", "")} for q in questions
                    if q.get("id")]),
        script_text,
    )
    response = _responses_create(
        client, model, [], SEGMENT_SYSTEM,
        [{"role": "user", "content": user_content}],
    )
    in_tok, out_tok = _usage_of(response)
    usage = {"input_tokens": in_tok, "output_tokens": out_tok}
    text, _ = _parse_response(response)
    quotes = _parse_quotes(text, codes)
    verified = {}
    for code in codes:
        quote = quotes[code]
        if not quote or not quote_in_text(quote, script_text):
            continue
        offset = find_quote_start(script_text, quote)
        if offset is not None:
            verified[code] = (quote, offset)
    by_offset = {}
    for code, (quote, offset) in verified.items():
        if offset not in by_offset or len(quote) > len(by_offset[offset][0]):
            by_offset[offset] = (quote, code)
    located = {code: (quote, offset)
               for offset, (quote, code) in by_offset.items()}
    slices = slice_segments(
        script_text, [(code, offset) for code, (_, offset)
                      in located.items()])
    segments = {}
    for code in codes:
        if code in located:
            quote, offset = located[code]
            segments[code] = {
                "found": True,
                "start_quote": quote,
                "page": page_at_offset(page_starts, offset),
                "text": slices[code],
            }
        else:
            segments[code] = {
                "found": False,
                "start_quote": None,
                "page": None,
                "text": "",
            }
    return {"segments": segments, "usage": usage}
