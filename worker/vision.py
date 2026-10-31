"""Transcribe handwritten/scanned PDF pages with vision before marking.

Pages with almost no extractable text are rendered to JPEG and sent to
the model; failures are recorded per page and never raise.
"""

import base64
import io
import os

from .agent import (
    _client_from_env,
    _model_from_env,
    _parse_response,
    _responses_create,
    _usage_of,
)

TRANSCRIBE_PROMPT = """Transcribe exactly what the student wrote, line by line.
Keep question labels (Q1, 1., (a), (ii)). Write [illegible] for any word
you can't read. Never correct spelling, never add, summarise or complete
anything. Ignore printed headers only if they are clearly not the
student's writing. Output plain text only."""

MIN_TEXT_CHARS = 20
DEFAULT_MAX_VISION_PAGES = 20
RENDER_LONG_SIDE = 1600
JPEG_QUALITY = 80


def _vision_model():
    return os.environ.get("VISION_MODEL") or _model_from_env()


def _max_vision_pages():
    try:
        return int(os.environ.get("MAX_VISION_PAGES", "") or
                   DEFAULT_MAX_VISION_PAGES)
    except ValueError:
        return DEFAULT_MAX_VISION_PAGES


def render_page_jpeg(pdf_path, page_number):
    """Render one 1-based PDF page to JPEG bytes (~1600px long side)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page = pdf[page_number - 1]
        width, height = page.get_size()
        scale = RENDER_LONG_SIDE / max(width, height)
        image = page.render(scale=scale).to_pil().convert("RGB")
    finally:
        pdf.close()
    buf = io.BytesIO()
    image.save(buf, "JPEG", quality=JPEG_QUALITY)
    return buf.getvalue()


def transcribe_page(image_bytes, client=None, model=None):
    """Transcribe one page image. Returns {text, usage}."""
    client = client or _client_from_env()
    model = model or _vision_model()
    data_url = "data:image/jpeg;base64,%s" % base64.b64encode(
        image_bytes).decode("ascii")
    response = _responses_create(
        client, model, [],
        "You transcribe handwriting exactly.",
        [{"role": "user", "content": [
            {"type": "input_text", "text": TRANSCRIBE_PROMPT},
            {"type": "input_image", "image_url": data_url},
        ]}],
    )
    text, _ = _parse_response(response)
    in_tok, out_tok = _usage_of(response)
    return {"text": text.strip(),
            "usage": {"input_tokens": in_tok, "output_tokens": out_tok}}


def pages_needing_vision(pages):
    """1-based numbers of pages with < 20 non-space characters."""
    return [n for n, text in enumerate(pages, start=1)
            if len("".join((text or "").split())) < MIN_TEXT_CHARS]


def _short_note(exc):
    note = str(exc).strip() or exc.__class__.__name__
    return note[:200]


def transcribe_script(pdf_path, pages, client=None, model=None,
                      max_pages=None):
    """Fill text-sparse pages with vision transcriptions.

    Returns {pages, transcript, usage}. Only pages needing vision are
    sent; pages past the cap and any per-page failure become "failed".
    Never raises.
    """
    if max_pages is None:
        max_pages = _max_vision_pages()
    try:
        max_pages = max(0, int(max_pages))
    except (TypeError, ValueError):
        max_pages = DEFAULT_MAX_VISION_PAGES
    needed = pages_needing_vision(pages)
    if not needed:
        return {
            "pages": list(pages),
            "transcript": [{"page": n, "source": "text", "text": text or ""}
                           for n, text in enumerate(pages, start=1)],
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }
    allowed = set(needed[:max_pages])
    client_note = None
    if client is None:
        try:
            client = _client_from_env()
        except Exception as exc:
            client_note = _short_note(exc)
    if model is None:
        model = _vision_model()
    final = list(pages)
    transcript = []
    usage_in, usage_out = 0, 0
    for n, text in enumerate(pages, start=1):
        if n not in needed:
            transcript.append({"page": n, "source": "text",
                               "text": text or ""})
            continue
        note = None
        if client_note is not None:
            note = client_note
        elif n not in allowed:
            note = "vision page limit reached"
        else:
            try:
                image = render_page_jpeg(pdf_path, n)
                result = transcribe_page(image, client=client, model=model)
            except Exception as exc:
                note = _short_note(exc)
            else:
                final[n - 1] = result["text"]
                transcript.append({"page": n, "source": "vision",
                                   "text": result["text"]})
                usage_in += result["usage"].get("input_tokens", 0)
                usage_out += result["usage"].get("output_tokens", 0)
                continue
        final[n - 1] = ""
        transcript.append({"page": n, "source": "failed", "text": "",
                           "note": note})
    return {"pages": final, "transcript": transcript,
            "usage": {"input_tokens": usage_in,
                     "output_tokens": usage_out}}


def main(argv=None):
    """Probe: render one PDF page and print its transcription + usage."""
    import argparse
    from dotenv import load_dotenv

    parser = argparse.ArgumentParser(
        description="Transcribe one PDF page with vision")
    parser.add_argument("--probe", required=True, metavar="PDF",
                        help="PDF file to transcribe a page from")
    parser.add_argument("--page", type=int, default=1,
                        help="1-based page number (default 1)")
    args = parser.parse_args(argv)
    load_dotenv()
    image = render_page_jpeg(args.probe, args.page)
    result = transcribe_page(image)
    print(result["text"])
    print("usage: input_tokens=%d output_tokens=%d"
          % (result["usage"]["input_tokens"],
             result["usage"]["output_tokens"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
