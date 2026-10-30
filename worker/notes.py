"""Course-notes extraction and keyword search for rubric drafting.

An assessment directory may contain notes/ with .pdf, .md or .txt files.
extract_notes() reads them once into notes_text.json; the rubric builder
agent searches that file and never touches the originals.

Entries are {file, page, text} with one entry per PDF page, one per
markdown section, and one per ~1500-character text block. Titled markdown
sections also carry "section". "page" is the 1-based entry number within
the file. Pages with no extractable text are kept with empty text plus
"unreadable": true.
"""

import json
import re
from pathlib import Path

from .tools import normalize

NOTE_EXTENSIONS = {".pdf", ".md", ".txt"}
SNIPPET_WIDTH = 400


def has_notes(notes_dir):
    """True when the directory holds at least one readable notes file."""
    notes_dir = Path(notes_dir)
    if not notes_dir.is_dir():
        return False
    return any(
        p.is_file() and p.suffix.lower() in NOTE_EXTENSIONS
        for p in notes_dir.iterdir()
    )


def _split_markdown(text):
    """Split markdown into (title_or_None, body) at #, ##, ### headings."""
    sections = []
    title, buf = None, []
    for line in text.splitlines():
        match = re.match(r"#{1,3}\s+(.+?)\s*#*\s*$", line)
        if match:
            sections.append((title, "\n".join(buf)))
            title, buf = match.group(1).strip(), []
        else:
            buf.append(line)
    sections.append((title, "\n".join(buf)))
    return [(title, body.strip()) for title, body in sections if body.strip()]


def _split_text_blocks(text, width=1500):
    """Split plain text into ~width-character blocks at blank lines."""
    paras = [p.strip() for p in re.split(r"\n[ \t]*\n", text)]
    paras = [p for p in paras if p]
    blocks, current = [], []
    for para in paras:
        candidate = current + [para]
        if current and len("\n\n".join(candidate)) > width:
            blocks.append("\n\n".join(current))
            current = [para]
        else:
            current = candidate
    if current:
        blocks.append("\n\n".join(current))
    return blocks


def extract_notes(notes_dir, out_path):
    """Extract notes/ files into notes_text.json.

    Returns (entries, unreadable). Unreadable pages (e.g. scanned PDFs)
    are kept with empty text plus "unreadable": true and also listed in
    unreadable.
    """
    from .tools import extract_pdf_pages

    notes_dir = Path(notes_dir)
    entries = []
    unreadable = []

    def add_entry(fname, page, text, section=None):
        text = text or ""
        entry = {"file": fname, "page": page, "text": text}
        if section:
            entry["section"] = section
        if not text.strip():
            entry["unreadable"] = True
            unreadable.append({"file": fname, "page": page})
        entries.append(entry)

    for path in sorted(notes_dir.iterdir(), key=lambda p: p.name):
        if not path.is_file() or path.suffix.lower() not in NOTE_EXTENSIONS:
            continue
        if path.suffix.lower() == ".pdf":
            try:
                page_texts = extract_pdf_pages(path)
            except Exception:
                page_texts = []
            if not page_texts:
                page_texts = [""]
            for i, text in enumerate(page_texts, start=1):
                add_entry(path.name, i, text)
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = ""
        if path.suffix.lower() == ".md":
            parts = [(title, body) for title, body in _split_markdown(text)]
        else:
            parts = [(None, block) for block in _split_text_blocks(text)]
        if not parts:
            add_entry(path.name, 1, "")
            continue
        for i, (title, body) in enumerate(parts, start=1):
            add_entry(path.name, i, body, section=title)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(entries, indent=2))
    return entries, unreadable


def load_notes_entries(path):
    """Load a notes_text.json file back into entries."""
    entries = json.loads(Path(path).read_text())
    if not isinstance(entries, list):
        raise ValueError("notes_text.json must hold a list of pages")
    return entries


def _snippet(original, terms, width=SNIPPET_WIDTH, lead=50):
    """~width characters around the densest cluster of query terms."""
    lowered = original.lower()
    positions = []
    for term in terms:
        start = 0
        while True:
            found = lowered.find(term, start)
            if found < 0:
                break
            positions.append(found)
            start = found + 1
    if not positions:
        flat = " ".join(original.split())
        return flat[:width] + ("..." if len(flat) > width else "")
    best = max(
        positions,
        key=lambda s: sum(1 for p in positions if s <= p < s + width),
    )
    start = max(0, best - lead)
    end = min(len(original), start + width)
    snippet = original[start:end]
    if start > 0:
        snippet = "..." + snippet
    if end < len(original):
        snippet = snippet + "..."
    return " ".join(snippet.split())


def search_notes(entries, query, top_k=5):
    """Keyword search over extracted notes; best snippets first.

    Returns at most top_k (max 5) hits shaped {file, page, section, text,
    score}, where text is a ~400-character snippet. Unreadable and empty
    pages are skipped.
    """
    terms = [t for t in normalize(query).split() if len(t) >= 3]
    if not terms:
        terms = normalize(query).split()
    if not terms:
        return []
    try:
        top_k = min(max(int(top_k), 1), 5)
    except (TypeError, ValueError):
        top_k = 5
    scored = []
    for entry in entries:
        if entry.get("unreadable"):
            continue
        text = normalize(entry.get("text", ""))
        if not text:
            continue
        score = sum(text.count(term) for term in terms)
        if score > 0:
            scored.append((score, entry))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        {"file": entry["file"], "page": entry["page"],
         "section": entry.get("section"),
         "text": _snippet(entry.get("text", ""), terms), "score": score}
        for score, entry in scored[:top_k]
    ]
