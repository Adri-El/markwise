"""Offline tests for worker.segment. The model call takes fakes."""

import json
import unittest
from types import SimpleNamespace

from worker.segment import (
    _normalize_with_map,
    build_script_text,
    find_quote_start,
    locate_answers,
    page_at_offset,
    slice_segments,
)
from worker.tools import normalize


class FakeResponses:
    def __init__(self, text, usage=None):
        self.text = text
        self.usage = usage or {"input_tokens": 11, "output_tokens": 7}
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            output=[{"type": "message",
                     "content": [{"text": self.text}]}],
            usage=dict(self.usage))


class FakeClient:
    def __init__(self, text, usage=None):
        self.responses = FakeResponses(text, usage)


QUESTIONS = [
    {"id": "q1", "prompt": "Define osmosis.", "max_marks": 2},
    {"id": "q2", "prompt": "Enzymes.", "max_marks": 4},
]


class BuildScriptTests(unittest.TestCase):
    def test_blocks_and_page_starts(self):
        text, starts = build_script_text(["hello", "", "bye"])
        self.assertEqual(
            text, "[page 1]\nhello\n\n[page 2]\n\n\n[page 3]\nbye")
        self.assertEqual([page for _, page in starts], [1, 2, 3])
        for offset, page in starts:
            self.assertTrue(text.startswith("[page %d]" % page, offset))

    def test_empty_pages(self):
        self.assertEqual(build_script_text([]), ("", []))


class NormalizeMapTests(unittest.TestCase):
    def test_matches_tools_normalize(self):
        raws = ["  Hello   WORLD\n", "a\tb\n\nc  ", "", "   ",
                "[page 1]\nQ1 x"]
        for raw in raws:
            normed, index = _normalize_with_map(raw)
            self.assertEqual(normed, normalize(raw))
            lowered = raw.lower()
            for i, ch in enumerate(normed):
                if ch == " ":
                    self.assertTrue(lowered[index[i]].isspace())
                else:
                    self.assertEqual(lowered[index[i]], ch)


class FindQuoteTests(unittest.TestCase):
    def test_exact_and_fuzzy_match(self):
        script = "[page 1]\nQ1  Osmosis IS water moving.\n\n[page 2]\nDone."
        self.assertEqual(find_quote_start(script, "Q1 Osmosis is water"),
                         script.index("Q1"))
        self.assertIsNone(find_quote_start(script, "chloroplasts here"))
        self.assertIsNone(find_quote_start(script, "ab"))


class SliceTests(unittest.TestCase):
    SCRIPT = "[page 1]\nQ1 alpha here.\n\n[page 2]\nQ2 beta here."

    def test_in_order(self):
        out = slice_segments(
            self.SCRIPT,
            [("q1", self.SCRIPT.index("Q1")),
             ("q2", self.SCRIPT.index("Q2"))])
        self.assertEqual(out["q1"], "Q1 alpha here.\n\n[page 2]")
        self.assertEqual(out["q2"], "Q2 beta here.")

    def test_out_of_order_sorted_by_position(self):
        out = slice_segments(
            self.SCRIPT,
            [("q2", self.SCRIPT.index("Q2")),
             ("q1", self.SCRIPT.index("Q1"))])
        self.assertEqual(out["q1"], "Q1 alpha here.\n\n[page 2]")
        self.assertEqual(out["q2"], "Q2 beta here.")

    def test_markers_kept_inside_slices(self):
        script = "[page 1]\nQ1 starts here\n\n[page 2]\nmore of q1"
        out = slice_segments(script, [("q1", script.index("Q1"))])
        self.assertEqual(out["q1"], "Q1 starts here\n\n[page 2]\nmore of q1")


class PageTests(unittest.TestCase):
    def test_page_at_offset(self):
        text, starts = build_script_text(["aa", "bb"])
        self.assertEqual(page_at_offset(starts, text.index("aa")), 1)
        self.assertEqual(page_at_offset(starts, text.index("bb")), 2)
        self.assertIsNone(page_at_offset([], 0))


class LocateTests(unittest.TestCase):
    def _locate(self, pages, payload):
        client = FakeClient(json.dumps(payload))
        result = locate_answers(QUESTIONS, pages, client=client,
                                model="fake")
        return client, result

    def test_found_in_order(self):
        pages = ["Q1 osmosis is water moving across.",
                 "Q2 enzymes are proteins here."]
        client, result = self._locate(
            pages, {"q1": "Q1 osmosis is water",
                    "q2": "Q2 enzymes are proteins"})
        self.assertEqual(len(client.responses.calls), 1)
        call = client.responses.calls[0]
        self.assertEqual(call["temperature"], 0)
        self.assertEqual(call["tools"], [])
        self.assertEqual(result["usage"],
                         {"input_tokens": 11, "output_tokens": 7})
        q1 = result["segments"]["q1"]
        self.assertTrue(q1["found"])
        self.assertEqual(q1["page"], 1)
        self.assertTrue(q1["text"].startswith("Q1 osmosis"))
        self.assertNotIn("Q2", q1["text"])
        q2 = result["segments"]["q2"]
        self.assertTrue(q2["found"])
        self.assertEqual(q2["page"], 2)
        self.assertEqual(set(result["segments"]), {"q1", "q2"})

    def test_out_of_order(self):
        pages = ["Q2 enzymes are proteins here.",
                 "Q1 osmosis is water moving across."]
        _, result = self._locate(
            pages, {"q1": "Q1 osmosis is water",
                    "q2": "Q2 enzymes are proteins"})
        q1 = result["segments"]["q1"]
        q2 = result["segments"]["q2"]
        self.assertTrue(q1["found"])
        self.assertTrue(q2["found"])
        self.assertEqual(q1["page"], 2)
        self.assertEqual(q2["page"], 1)
        self.assertNotIn("Q1", q2["text"])

    def test_missing_answer(self):
        pages = ["Q1 osmosis is water moving across.", "nothing else"]
        _, result = self._locate(
            pages, {"q1": "Q1 osmosis is water", "q2": None})
        self.assertTrue(result["segments"]["q1"]["found"])
        q2 = result["segments"]["q2"]
        self.assertEqual(q2, {"found": False, "start_quote": None,
                              "page": None, "text": ""})

    def test_quote_not_in_script(self):
        pages = ["Q1 osmosis is water moving across.",
                 "Q2 enzymes are proteins here."]
        _, result = self._locate(
            pages, {"q1": "invented words nowhere here",
                    "q2": "Q2 enzymes are proteins"})
        self.assertFalse(result["segments"]["q1"]["found"])
        self.assertEqual(result["segments"]["q1"]["text"], "")
        self.assertTrue(result["segments"]["q2"]["found"])

    def test_invalid_json_finds_nothing(self):
        client = FakeClient("not json at all {{{")
        result = locate_answers(QUESTIONS, ["Q1 text here"], client=client,
                                model="fake")
        for code in ("q1", "q2"):
            self.assertFalse(result["segments"][code]["found"])
        self.assertEqual(result["usage"],
                         {"input_tokens": 11, "output_tokens": 7})

    def test_non_dict_json_finds_nothing(self):
        client = FakeClient(json.dumps(["q1", "q2"]))
        result = locate_answers(QUESTIONS, ["Q1 text here"], client=client,
                                model="fake")
        for code in ("q1", "q2"):
            self.assertFalse(result["segments"][code]["found"])


if __name__ == "__main__":
    unittest.main()
