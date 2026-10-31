"""Offline tests for notes extraction/search and the rubric builder.

No API calls: RubricBuilderState is driven directly, never the agent loop.
"""

import json
import tempfile
import unittest
from pathlib import Path

from worker.agent import build_context
from worker.notes import extract_notes, has_notes, load_notes_entries, search_notes
from worker.rubric_agent import (
    RubricBuilderState,
    any_n_requirement,
    build_builder_context,
    check_any_n_warnings,
    flag_uneven_splits,
    n_items_requirement,
    question_has_scheme,
)
from worker.tools import check_rubric

ASSESSMENT = {
    "id": "demo",
    "title": "Demo",
    "questions": [
        {"id": "q1", "prompt": "Define osmosis.", "max_marks": 2},
        {"id": "q2", "prompt": "Describe enzymes.", "max_marks": 2},
    ],
    "marking_scheme": {"q1": "water across a membrane (2).", "q2": ""},
}

ENTRIES = [
    {"file": "notes.md", "page": 1,
     "text": "Osmosis is the movement of water across a partially permeable membrane."},
    {"file": "notes.md", "page": 2,
     "text": "Enzymes are proteins. The active site changes shape around the substrate."},
]


def fresh_builder(entries=None):
    return RubricBuilderState(ASSESSMENT, entries if entries is not None else ENTRIES)


class ExtractionTests(unittest.TestCase):
    def test_extract_md_and_txt(self):
        with tempfile.TemporaryDirectory() as tmp:
            notes = Path(tmp) / "notes"
            notes.mkdir()
            (notes / "a.md").write_text("# Cells\nMitochondria make energy.")
            (notes / "b.txt").write_text("Water boils.")
            (notes / "skip.docx").write_text("not a notes file")
            out = Path(tmp) / "notes_text.json"
            entries, unreadable = extract_notes(notes, out)
            self.assertEqual(len(entries), 2)
            self.assertEqual(entries[0]["file"], "a.md")
            self.assertEqual(entries[0]["page"], 1)
            self.assertIn("Mitochondria", entries[0]["text"])
            self.assertEqual(entries[1]["file"], "b.txt")
            self.assertEqual(unreadable, [])
            self.assertTrue(has_notes(notes))
            self.assertEqual(load_notes_entries(out), entries)

    def test_empty_file_is_unreadable(self):
        with tempfile.TemporaryDirectory() as tmp:
            notes = Path(tmp) / "notes"
            notes.mkdir()
            (notes / "blank.md").write_text("   \n")
            entries, unreadable = extract_notes(notes, Path(tmp) / "out.json")
            self.assertEqual(len(entries), 1)
            self.assertTrue(entries[0].get("unreadable"))
            self.assertEqual(unreadable, [{"file": "blank.md", "page": 1}])

    def test_no_notes_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertFalse(has_notes(Path(tmp) / "nothing"))

    def test_bad_notes_file_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.json"
            out.write_text(json.dumps({"not": "a list"}))
            with self.assertRaises(ValueError):
                load_notes_entries(out)


class SearchTests(unittest.TestCase):
    def test_best_match_first(self):
        hits = search_notes(ENTRIES, "active site substrate shape")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["page"], 2)
        self.assertEqual(hits[0]["file"], "notes.md")

    def test_no_match_is_empty(self):
        self.assertEqual(search_notes(ENTRIES, "chloroplasts"), [])

    def test_empty_query_is_empty(self):
        self.assertEqual(search_notes(ENTRIES, "   "), [])

    def test_unreadable_pages_skipped(self):
        entries = ENTRIES + [{"file": "scan.pdf", "page": 1, "text": "",
                              "unreadable": True}]
        hits = search_notes(entries, "osmosis water membrane")
        self.assertEqual([h["page"] for h in hits], [1])

    def test_top_k_limits_results(self):
        entries = ENTRIES + [
            {"file": "notes.md", "page": 3, "text": "Water moves by osmosis."}]
        hits = search_notes(entries, "osmosis", top_k=1)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["page"], 1)


class AddPointTests(unittest.TestCase):
    def test_real_quote_accepted(self):
        state = fresh_builder()
        result = state.add_point(
            "q1", "water movement", 2,
            source_quote="movement of water across",
            source_file="notes.md", source_page=1)
        self.assertTrue(result["ok"])
        self.assertEqual(result["point_id"], "p1")
        self.assertEqual(state.points[0]["source_page"], 1)

    def test_wrong_page_rejected(self):
        state = fresh_builder()
        result = state.add_point(
            "q1", "water movement", 2,
            source_quote="movement of water across",
            source_file="notes.md", source_page=2)
        self.assertFalse(result["ok"])

    def test_invented_quote_rejected(self):
        state = fresh_builder()
        result = state.add_point(
            "q1", "water movement", 2,
            source_quote="osmosis was invented in 1901",
            source_file="notes.md", source_page=1)
        self.assertFalse(result["ok"])

    def test_quote_needs_file_and_page(self):
        state = fresh_builder()
        self.assertFalse(state.add_point(
            "q1", "water movement", 2,
            source_quote="movement of water")["ok"])
        self.assertFalse(state.add_point(
            "q1", "water movement", 2, source_file="notes.md",
            source_page=1)["ok"])

    def test_unknown_file_rejected(self):
        state = fresh_builder()
        self.assertFalse(state.add_point(
            "q1", "water movement", 2, source_quote="movement of water",
            source_file="missing.md", source_page=1)["ok"])

    def test_point_without_source_allowed(self):
        state = fresh_builder()
        result = state.add_point("q1", "water movement", 2)
        self.assertTrue(result["ok"])
        self.assertNotIn("source_quote", state.points[0])

    def test_needs_lecturer_requires_reason(self):
        state = fresh_builder()
        self.assertFalse(
            state.add_point("q2", "application", 2, needs_lecturer=True)["ok"])
        ok = state.add_point("q2", "application", 2, needs_lecturer=True,
                             reason="judgement call, not in notes")
        self.assertTrue(ok["ok"])

    def test_bad_question_and_marks_rejected(self):
        state = fresh_builder()
        self.assertFalse(state.add_point("q9", "x", 1)["ok"])
        self.assertFalse(state.add_point("q1", "x", 0.3)["ok"])
        self.assertFalse(state.add_point("q1", "x", 0)["ok"])
        self.assertFalse(state.add_point("q1", "  ", 1)["ok"])

    def test_accept_reject_lists(self):
        state = fresh_builder()
        ok = state.add_point("q1", "water movement", 2,
                             accept=["water", "H2O"], reject=["salt"])
        self.assertTrue(ok["ok"])
        self.assertFalse(state.add_point(
            "q1", "water movement", 2, accept="water")["ok"])


class SchemeHelperTests(unittest.TestCase):
    def test_scheme_present_and_missing(self):
        self.assertTrue(question_has_scheme(ASSESSMENT, "q1"))
        self.assertFalse(question_has_scheme(ASSESSMENT, "q2"))
        self.assertFalse(question_has_scheme(ASSESSMENT, "q9"))
        self.assertFalse(question_has_scheme({"questions": []}, "q1"))
        self.assertFalse(
            question_has_scheme({"marking_scheme": "free text"}, "q1"))


class FinishTests(unittest.TestCase):
    def test_finish_refuses_below_sum(self):
        state = fresh_builder()
        state.add_point("q1", "water movement", 1)
        refused = state.finish()
        self.assertFalse(refused["ok"])

    def test_finish_accepts_valid_draft(self):
        state = fresh_builder()
        state.add_point("q1", "water movement", 2)
        state.add_point("q2", "active site", 2, needs_lecturer=True,
                        reason="wording unclear")
        done = state.finish()
        self.assertTrue(done["ok"])
        self.assertEqual(len(done["points"]), 2)


class RubricSourceValidationTests(unittest.TestCase):
    def _rubric_with(self, **extra):
        point = {"id": "p1", "question_id": "q1",
                 "description": "x", "max_marks": 2}
        point.update(extra)
        points = [point, {"id": "p2", "question_id": "q2",
                          "description": "y", "max_marks": 2}]
        return {"assessment_id": "demo", "points": points}

    def test_valid_source_trio(self):
        rubric = self._rubric_with(source_quote="movement of water",
                                   source_file="notes.md", source_page=1)
        self.assertEqual(check_rubric(rubric, ASSESSMENT), [])

    def test_partial_trio_rejected(self):
        rubric = self._rubric_with(source_quote="movement of water")
        self.assertTrue(check_rubric(rubric, ASSESSMENT))

    def test_bad_source_types_rejected(self):
        rubric = self._rubric_with(source_quote="  ",
                                   source_file="notes.md", source_page=1)
        self.assertTrue(check_rubric(rubric, ASSESSMENT))
        rubric = self._rubric_with(source_quote="movement of water",
                                   source_file="notes.md", source_page="1")
        self.assertTrue(check_rubric(rubric, ASSESSMENT))
        rubric = self._rubric_with(source_quote="movement of water",
                                   source_file="notes.md", source_page=True)
        self.assertTrue(check_rubric(rubric, ASSESSMENT))

    def test_needs_lecturer_rules(self):
        rubric = self._rubric_with(needs_lecturer=True)
        self.assertTrue(check_rubric(rubric, ASSESSMENT))
        rubric = self._rubric_with(needs_lecturer=True, reason="check this")
        self.assertEqual(check_rubric(rubric, ASSESSMENT), [])
        rubric = self._rubric_with(needs_lecturer="yes")
        self.assertTrue(check_rubric(rubric, ASSESSMENT))


class SectionSplittingTests(unittest.TestCase):
    def _extract_one(self, name, content):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        notes = Path(tmp.name) / "notes"
        notes.mkdir()
        (notes / name).write_text(content)
        entries, unreadable = extract_notes(notes, Path(tmp.name) / "out.json")
        return entries, unreadable

    def test_markdown_splits_at_headings(self):
        entries, unreadable = self._extract_one(
            "a.md", "Intro line.\n\n# Transport\nDiffusion text.\n\n"
                    "## Osmosis\nWater text.\n")
        self.assertEqual(unreadable, [])
        self.assertEqual(
            [(e["page"], e.get("section"), e["text"]) for e in entries],
            [(1, None, "Intro line."),
             (2, "Transport", "Diffusion text."),
             (3, "Osmosis", "Water text.")])

    def test_empty_markdown_sections_skipped(self):
        entries, _ = self._extract_one("a.md", "# Empty\n\n# Full\nText.\n")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["section"], "Full")

    def test_text_splits_into_blocks(self):
        paras = ["x" * 600, "y" * 600, "z" * 600]
        entries, _ = self._extract_one("b.txt", "\n\n".join(paras))
        self.assertEqual(len(entries), 2)
        self.assertEqual([e["page"] for e in entries], [1, 2])
        for entry in entries:
            self.assertLess(len(entry["text"]), 1700)

    def test_short_text_is_one_entry(self):
        entries, _ = self._extract_one("b.txt", "Water boils.\n\nAt 100C.")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["page"], 1)


class SnippetTests(unittest.TestCase):
    def test_long_page_returns_snippet(self):
        text = "filler " * 150 + "mitochondria powerhouse"
        hits = search_notes(
            [{"file": "n.md", "page": 1, "text": text}], "mitochondria")
        self.assertEqual(len(hits), 1)
        snippet = hits[0]["text"]
        self.assertIn("mitochondria", snippet)
        self.assertTrue(snippet.startswith("..."))
        self.assertLess(len(snippet), 200)

    def test_short_page_returns_full_text(self):
        hits = search_notes(ENTRIES, "active site shapes")
        self.assertEqual(hits[0]["text"], ENTRIES[1]["text"])

    def test_section_carried_on_hits(self):
        entries = [{"file": "n.md", "page": 2, "section": "Enzymes",
                    "text": ENTRIES[1]["text"]}]
        hits = search_notes(entries, "active site")
        self.assertEqual(hits[0]["section"], "Enzymes")
        plain = search_notes(ENTRIES, "osmosis")
        self.assertIsNone(plain[0]["section"])

    def test_top_k_clamped_to_five(self):
        entries = [{"file": "n.md", "page": i, "text": "osmosis water"}
                   for i in range(1, 8)]
        self.assertEqual(len(search_notes(entries, "osmosis", top_k=99)), 5)
        self.assertEqual(len(search_notes(entries, "osmosis", top_k=0)), 1)


class SourceSectionTests(unittest.TestCase):
    def test_add_point_stores_section(self):
        entries = [{"file": "n.md", "page": 2, "section": "Transport",
                    "text": ENTRIES[0]["text"]}]
        state = RubricBuilderState(ASSESSMENT, entries)
        result = state.add_point(
            "q1", "water movement", 2,
            source_quote="movement of water across",
            source_file="n.md", source_page=2)
        self.assertTrue(result["ok"])
        self.assertEqual(state.points[0]["source_section"], "Transport")

    def test_add_point_omits_missing_section(self):
        state = fresh_builder()
        state.add_point("q1", "water movement", 2,
                        source_quote="movement of water across",
                        source_file="notes.md", source_page=1)
        self.assertNotIn("source_section", state.points[0])

    def test_check_rubric_section_rules(self):
        base = {"id": "p1", "question_id": "q1", "description": "x",
                "max_marks": 2, "source_quote": "movement of water",
                "source_file": "notes.md", "source_page": 1}
        good = dict(base, source_section="Transport")
        rubric = {"assessment_id": "demo",
                  "points": [good, {"id": "p2", "question_id": "q2",
                                     "description": "y", "max_marks": 2}]}
        self.assertEqual(check_rubric(rubric, ASSESSMENT), [])
        bad = dict(base, source_section="  ")
        rubric["points"][0] = bad
        self.assertTrue(check_rubric(rubric, ASSESSMENT))

    def test_marking_context_shows_section(self):
        rubric = {"assessment_id": "demo", "points": [
            {"id": "p1", "question_id": "q1", "description": "water",
             "max_marks": 2, "source_quote": "movement of water across",
             "source_file": "notes.md", "source_page": 1,
             "source_section": "Transport"},
            {"id": "p2", "question_id": "q1", "description": "membrane",
             "max_marks": 2, "source_quote": "partially permeable membrane",
             "source_file": "notes.md", "source_page": 1},
        ]}
        context = build_context(ASSESSMENT, rubric)
        self.assertIn('Notes notes.md p.1 [Transport]: "movement of water across"',
                      context)
        self.assertIn('Notes notes.md p.1: "partially permeable membrane"',
                      context)


class BuilderReferenceNoteTests(unittest.TestCase):
    def test_reference_note_included(self):
        assessment = dict(ASSESSMENT, reference_note="Mark generously.")
        for ignore_scheme in (False, True):
            context = build_builder_context(assessment, ENTRIES, ignore_scheme)
            self.assertIn(
                "Reference note (lecturer rules, applies to the whole "
                "assessment): Mark generously.", context)

    def test_missing_reference_note_omitted(self):
        context = build_builder_context(ASSESSMENT, ENTRIES, False)
        self.assertNotIn("Reference note", context)


ANY_ASSESSMENT = {
    "id": "demo",
    "title": "Demo",
    "questions": [
        {"id": "q3", "prompt": "State any two differences.", "max_marks": 4},
    ],
    "marking_scheme": {},
}


class AnyNDetectionTests(unittest.TestCase):
    def test_word_and_digit_forms(self):
        self.assertEqual(
            any_n_requirement({"prompt": "State any two differences."}), 2)
        self.assertEqual(
            any_n_requirement({"prompt": "Name ANY 3 causes."}), 3)
        self.assertEqual(
            any_n_requirement({"prompt": "Give any five examples."}), 5)

    def test_no_requirement(self):
        self.assertIsNone(any_n_requirement({"prompt": "Define osmosis."}))
        self.assertIsNone(any_n_requirement({"prompt": "Do anyone differs?"}))
        self.assertIsNone(any_n_requirement({"prompt": "Name many parts."}))
        self.assertIsNone(any_n_requirement({}))


class AnyNCheckTests(unittest.TestCase):
    def test_even_split_has_no_warnings(self):
        points = [
            {"id": "p1", "question_id": "q3", "max_marks": 2.0},
            {"id": "p2", "question_id": "q3", "max_marks": 2.0},
        ]
        self.assertEqual(check_any_n_warnings(ANY_ASSESSMENT, points), [])

    def test_uneven_split_warns_per_point(self):
        points = [
            {"id": "p1", "question_id": "q3", "max_marks": 2.0},
            {"id": "p2", "question_id": "q3", "max_marks": 1.0},
            {"id": "p3", "question_id": "q3", "max_marks": 1.0},
        ]
        warnings = check_any_n_warnings(ANY_ASSESSMENT, points)
        self.assertEqual(len(warnings), 2)
        self.assertIn("p2", warnings[0])
        self.assertIn("p3", warnings[1])

    def test_plain_question_has_no_warnings(self):
        points = [{"id": "p1", "question_id": "q1", "max_marks": 2.0}]
        self.assertEqual(check_any_n_warnings(ASSESSMENT, points), [])


class FinishWarningsTests(unittest.TestCase):
    def test_finish_succeeds_with_warnings(self):
        state = RubricBuilderState(ANY_ASSESSMENT, ENTRIES)
        state.add_point("q3", "cell wall", 2)
        state.add_point("q3", "chloroplasts", 1)
        state.add_point("q3", "vacuole", 1)
        done = state.finish()
        self.assertTrue(done["ok"])
        self.assertEqual(len(done["warnings"]), 2)

    def test_finish_omits_warnings_when_even(self):
        state = RubricBuilderState(ANY_ASSESSMENT, ENTRIES)
        state.add_point("q3", "cell wall", 2)
        state.add_point("q3", "chloroplasts", 2)
        done = state.finish()
        self.assertTrue(done["ok"])
        self.assertNotIn("warnings", done)


ITEMS_ASSESSMENT = {
    "id": "demo",
    "title": "Demo",
    "questions": [
        {"id": "q2",
         "prompt": "Give 4 reasons why Java is a popular language.",
         "max_marks": 4},
    ],
    "marking_scheme": {},
}

UNEVEN_ASSESSMENT = {
    "id": "demo",
    "title": "Demo",
    "questions": [
        {"id": "q2",
         "prompt": "Give 4 reasons why Java is a popular language.",
         "max_marks": 5},
    ],
    "marking_scheme": {},
}


class NItemsDetectionTests(unittest.TestCase):
    def test_verb_count_forms(self):
        cases = [
            ("Give 4 reasons why Java is popular.", 4),
            ("State two advantages of tests.", 2),
            ("List three uses of dictionaries.", 3),
            ("GIVE 5 EXAMPLES OF EACH.", 5),
            ("Mention seven risk factors.", 7),
            ("Identify ten parts of the cell.", 10),
            ("Explain three causes of war.", 3),
            ("Describe 2 processes in detail.", 2),
            ("Outline four steps of mitosis.", 4),
        ]
        for prompt, expected in cases:
            with self.subTest(prompt=prompt):
                self.assertEqual(
                    n_items_requirement({"prompt": prompt}), expected)

    def test_any_n_still_matches(self):
        self.assertEqual(
            n_items_requirement({"prompt": "State any two differences."}), 2)
        self.assertEqual(
            n_items_requirement({"prompt": "Name any seven wonders."}), 7)

    def test_bare_numbers_do_not_match(self):
        prompts = [
            "What is Java 8?",
            "Answer in 2 marks.",
            "Enzymes. (a) 4 marks",
            "Discuss programming since 1999.",
            "Part (a): define osmosis.",
            "Describe enzymes.",
            "Name many parts.",
            "Do anyone differs?",
            "Give 4 marks for effort.",
            "Define osmosis.",
        ]
        for prompt in prompts:
            with self.subTest(prompt=prompt):
                self.assertIsNone(n_items_requirement({"prompt": prompt}))
        self.assertIsNone(n_items_requirement({}))


class NItemsCheckTests(unittest.TestCase):
    def test_even_split_deviation_warns(self):
        points = [
            {"id": "p1", "question_id": "q2", "max_marks": 1.0},
            {"id": "p2", "question_id": "q2", "max_marks": 1.0},
            {"id": "p3", "question_id": "q2", "max_marks": 1.0},
            {"id": "p4", "question_id": "q2", "max_marks": 1.5},
        ]
        warnings = check_any_n_warnings(ITEMS_ASSESSMENT, points)
        self.assertEqual(
            warnings,
            ["Q2 asks for 4 items worth 1 each, but point p4 is worth 1.5"])

    def test_even_split_clean_has_no_warnings(self):
        points = [
            {"id": "p%d" % n, "question_id": "q2", "max_marks": 1.0}
            for n in range(1, 5)
        ]
        self.assertEqual(check_any_n_warnings(ITEMS_ASSESSMENT, points), [])

    def test_uneven_split_flags_first_point(self):
        state = RubricBuilderState(UNEVEN_ASSESSMENT, ENTRIES)
        state.add_point("q2", "portable", 1)
        state.add_point("q2", "object oriented", 1)
        state.add_point("q2", "libraries", 1)
        state.add_point("q2", "community", 2)
        done = state.finish()
        self.assertTrue(done["ok"])
        first = done["points"][0]
        self.assertTrue(first.get("needs_lecturer"))
        self.assertEqual(
            first["reason"],
            "Q2 asks for 4 items for 5 marks, which doesn't split into "
            "half marks. Decide how to award the marks (e.g. 1 mark per "
            "item plus 1 for explaining one).")
        self.assertFalse(any(p.get("needs_lecturer")
                             for p in done["points"][1:]))
        self.assertEqual(
            check_rubric({"assessment_id": "demo",
                          "points": done["points"]}, UNEVEN_ASSESSMENT),
            [])
        self.assertEqual(len(done["warnings"]), 1)
        self.assertIn("Q2 asks for 4 items", done["warnings"][0])

    def test_uneven_split_keeps_existing_reason(self):
        state = RubricBuilderState(UNEVEN_ASSESSMENT, ENTRIES)
        state.add_point("q2", "portable", 2, needs_lecturer=True,
                        reason="no notes coverage")
        state.add_point("q2", "object oriented", 1)
        state.add_point("q2", "libraries", 1)
        state.add_point("q2", "community", 1)
        done = state.finish()
        self.assertTrue(done["ok"])
        self.assertEqual(done["points"][0]["reason"], "no notes coverage")
        self.assertEqual(len(done["warnings"]), 1)

    def test_flag_uneven_splits_is_idempotent(self):
        points = [
            {"id": "p1", "question_id": "q2", "max_marks": 1.0},
            {"id": "p2", "question_id": "q2", "max_marks": 2.0},
        ]
        first = flag_uneven_splits(UNEVEN_ASSESSMENT, points)
        second = flag_uneven_splits(UNEVEN_ASSESSMENT, points)
        self.assertEqual(len(first), 1)
        self.assertEqual(first, second)
        self.assertTrue(points[0].get("needs_lecturer"))

    def test_over_max_without_requirement_warns(self):
        assessment = {
            "id": "demo",
            "title": "Demo",
            "questions": [
                {"id": "q3", "prompt": "Explain osmosis in detail.",
                 "max_marks": 5},
            ],
            "marking_scheme": {},
        }
        points = [
            {"id": "p1", "question_id": "q3", "max_marks": 2.0},
            {"id": "p2", "question_id": "q3", "max_marks": 2.0},
            {"id": "p3", "question_id": "q3", "max_marks": 2.0},
        ]
        self.assertEqual(
            check_any_n_warnings(assessment, points),
            ["Q3: points add up to 6 but the question is worth 5. Check "
             "whether these are meant to be alternatives."])

    def test_at_max_without_requirement_is_quiet(self):
        assessment = {
            "id": "demo",
            "title": "Demo",
            "questions": [
                {"id": "q3", "prompt": "Explain osmosis in detail.",
                 "max_marks": 4},
            ],
            "marking_scheme": {},
        }
        points = [
            {"id": "p1", "question_id": "q3", "max_marks": 2.0},
            {"id": "p2", "question_id": "q3", "max_marks": 2.0},
        ]
        self.assertEqual(check_any_n_warnings(assessment, points), [])


if __name__ == "__main__":
    unittest.main()
