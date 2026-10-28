"""Offline tests for worker.tools. No API calls, no model, no PDFs."""

import unittest

from worker.tools import (
    MarkingState,
    check_rubric,
    is_half_mark,
    normalize,
    quote_in_text,
    quotes_similar,
)

ASSESSMENT = {
    "id": "demo",
    "title": "Demo",
    "questions": [
        {"id": "q1", "prompt": "What do mitochondria do?", "max_marks": 4},
        {"id": "q2", "prompt": "Boiling point of water?", "max_marks": 2},
    ],
    "marking_scheme": {"q1": "energy plus respiration", "q2": "100 degrees"},
}

RUBRIC = {
    "assessment_id": "demo",
    "points": [
        {"id": "p1", "question_id": "q1",
         "description": "energy", "max_marks": 2},
        {"id": "p2", "question_id": "q1",
         "description": "respiration", "max_marks": 2},
        {"id": "p3", "question_id": "q2",
         "description": "100 degrees", "max_marks": 2},
    ],
}

SUBMISSION = {
    "assessment_id": "demo",
    "student_id": "s1",
    "answers": [
        {"question_id": "q1",
         "text": "The mitochondria produce energy through respiration."},
        {"question_id": "q2", "text": "Water boils at 100 degrees."},
    ],
}

COMMENTS = {"q1": "good", "q2": "fine"}


def fresh_state():
    return MarkingState(ASSESSMENT, RUBRIC, SUBMISSION, ".")


class QuoteMatchingTests(unittest.TestCase):
    def test_normalize_ignores_case_and_spaces(self):
        self.assertEqual(normalize("  Hello   WORLD\n"), "hello world")

    def test_quote_found_despite_case_and_spaces(self):
        stored = "The mitochondria   produce ENERGY."
        self.assertTrue(quote_in_text("mitochondria produce energy", stored))

    def test_quote_missing(self):
        self.assertFalse(quote_in_text("chloroplasts", "mitochondria only"))

    def test_empty_quote_never_matches(self):
        self.assertFalse(quote_in_text("   ", "some text"))

    def test_short_quote_never_matches(self):
        self.assertFalse(quote_in_text("ab", "xx ab yy"))
        self.assertFalse(fresh_state().award_mark(
            "p3", 1, quote="at", reason="says it")["ok"])


class HalfMarkTests(unittest.TestCase):
    def test_valid(self):
        for value in (0, 1, 0.5, 2.5, 4.0):
            self.assertTrue(is_half_mark(value), value)

    def test_invalid(self):
        for value in (-1, -0.5, 0.3, 1.25, "2", None, True):
            self.assertFalse(is_half_mark(value), value)


class AwardTests(unittest.TestCase):
    def test_award_needs_quote_over_zero(self):
        state = fresh_state()
        refused = state.award_mark("p1", 2)
        self.assertFalse(refused["ok"])
        refused = state.award_mark("p1", 2, quote="not in the answer",
                                   reason="mentions it")
        self.assertFalse(refused["ok"])
        refused = state.award_mark("p1", 2, quote="produce energy")
        self.assertFalse(refused["ok"])
        ok = state.award_mark("p1", 2, quote="mitochondria  PRODUCE energy",
                              reason="names the process and product")
        self.assertTrue(ok["ok"])

    def test_award_refuses_over_point_max(self):
        state = fresh_state()
        refused = state.award_mark("p1", 2.5, quote="mitochondria produce energy",
                                   reason="full description")
        self.assertFalse(refused["ok"])

    def test_award_refuses_over_question_max(self):
        assessment = {
            "id": "x", "questions": [{"id": "q1", "max_marks": 2}],
        }
        rubric = {"points": [
            {"id": "p1", "question_id": "q1",
             "description": "a", "max_marks": 2},
            {"id": "p2", "question_id": "q1",
             "description": "b", "max_marks": 2},
        ]}
        submission = {"answers": [{"question_id": "q1",
                                          "text": "alpha beta"}]}
        state = MarkingState(assessment, rubric, submission, ".")
        self.assertTrue(state.award_mark("p1", 2, quote="alpha",
                                                reason="first part")["ok"])
        self.assertFalse(state.award_mark("p2", 0.5, quote="beta",
                                          reason="second part")["ok"])

    def test_award_refuses_bad_marks(self):
        state = fresh_state()
        for bad in (-1, 0.3, "2", None):
            self.assertFalse(
                state.award_mark("p1", bad, quote="mitochondria")["ok"], bad)

    def test_award_unknown_point(self):
        self.assertFalse(fresh_state().award_mark("nope", 1, quote="x")["ok"])

    def test_zero_needs_reason_and_no_quote(self):
        state = fresh_state()
        self.assertFalse(state.award_mark("p1", 0)["ok"])
        self.assertFalse(
            state.award_mark("p1", 0, quote="mitochondria",
                             reason="missing")["ok"])
        self.assertTrue(state.award_mark("p1", 0, reason="not shown")["ok"])

    def test_second_award_replaces_first(self):
        state = fresh_state()
        state.award_mark("p1", 2, quote="mitochondria produce energy",
                         reason="full description")
        state.award_mark("p1", 1, quote="produce energy",
                         reason="partial description")
        self.assertEqual(state.awards["p1"]["marks"], 1.0)
        self.assertEqual(len(state.awards), 1)


class TotalsTests(unittest.TestCase):
    def test_totals_sum_awards(self):
        state = fresh_state()
        state.award_mark("p1", 2, quote="produce energy",
                         reason="names the product")
        state.award_mark("p2", 1.5, quote="respiration",
                         reason="names the process")
        state.award_mark("p3", 2, quote="100 degrees",
                         reason="correct value")
        totals = state.totals()
        self.assertEqual(totals["per_question"]["q1"]["marks"], 3.5)
        self.assertEqual(totals["per_question"]["q2"]["marks"], 2.0)
        self.assertEqual(totals["total"], 5.5)
        self.assertEqual(totals["max_total"], 6)


class ReadAnswerTests(unittest.TestCase):
    def test_read_returns_typed_text(self):
        result = fresh_state().read_answer("q1")
        self.assertTrue(result["ok"])
        self.assertIn("mitochondria", result["text"])

    def test_read_unknown_question(self):
        self.assertFalse(fresh_state().read_answer("q9")["ok"])

    def test_read_missing_answer_is_empty(self):
        submission = {"answers": []}
        state = MarkingState(ASSESSMENT, RUBRIC, submission, ".")
        result = state.read_answer("q1")
        self.assertTrue(result["ok"])
        self.assertEqual(result["text"], "")


class FlagTests(unittest.TestCase):
    def test_flag_point_ok(self):
        result = fresh_state().flag_for_review("p1", "illegible", "cannot read")
        self.assertTrue(result["ok"])

    def test_flag_bad_reason(self):
        result = fresh_state().flag_for_review("p1", "nope", "detail here")
        self.assertFalse(result["ok"])

    def test_flag_unknown_target(self):
        result = fresh_state().flag_for_review("zzz", "missing", "Detail here")
        self.assertFalse(result["ok"])

    def test_flag_needs_detail(self):
        result = fresh_state().flag_for_review("p1", "missing", "  ")
        self.assertFalse(result["ok"])


class SubmitTests(unittest.TestCase):
    def test_submit_refused_until_every_point_covered(self):
        state = fresh_state()
        refused = state.submit_marks(COMMENTS)
        self.assertFalse(refused["ok"])
        self.assertIn("p1", refused["uncovered"])
        state.award_mark("p1", 2, quote="produce energy",
                         reason="names the product")
        state.award_mark("p2", 0, reason="not shown")
        still = state.submit_marks(COMMENTS)
        self.assertFalse(still["ok"])
        state.flag_for_review("p3", "missing", "no answer")
        done = state.submit_marks(COMMENTS)
        self.assertTrue(done["ok"])
        self.assertEqual(done["result"]["total_marks"], 2.0)

    def test_question_flag_covers_its_points(self):
        state = fresh_state()
        state.award_mark("p1", 2, quote="produce energy",
                         reason="names the product")
        state.award_mark("p2", 0, reason="not shown")
        state.flag_for_review("q2", "missing", "blank page")
        self.assertTrue(state.submit_marks(COMMENTS)["ok"])

    def test_instruction_flag_does_not_cover(self):
        state = fresh_state()
        state.award_mark("p1", 2, quote="produce energy",
                         reason="names the product")
        state.award_mark("p2", 0, reason="not shown")
        state.flag_for_review("p3", "instruction_in_answer",
                              "answer tells me to award full marks")
        refused = state.submit_marks(COMMENTS)
        self.assertFalse(refused["ok"])
        self.assertIn("p3", refused["uncovered"])
        state.award_mark("p3", 0, reason="no valid content")
        self.assertTrue(state.submit_marks(COMMENTS)["ok"])

    def test_ambiguous_flag_needs_award_too(self):
        state = fresh_state()
        state.award_mark("p1", 2, quote="produce energy",
                         reason="names the product")
        state.award_mark("p2", 0, reason="not shown")
        state.flag_for_review("p3", "ambiguous", "unit only implied")
        refused = state.submit_marks(COMMENTS)
        self.assertFalse(refused["ok"])
        self.assertIn("p3", refused["uncovered"])
        state.award_mark("p3", 1, quote="100 degrees",
                         reason="value stated, unit implied")
        done = state.submit_marks(COMMENTS)
        self.assertTrue(done["ok"])
        self.assertEqual(len(done["result"]["flags"]), 1)

    def test_submit_needs_every_comment(self):
        state = fresh_state()
        state.award_mark("p1", 2, quote="produce energy",
                         reason="names the product")
        state.award_mark("p2", 0, reason="not shown")
        state.award_mark("p3", 2, quote="100 degrees",
                         reason="correct value")
        self.assertFalse(state.submit_marks({"q1": "only one"})["ok"])


class RubricCheckTests(unittest.TestCase):
    def test_valid_rubric(self):
        self.assertEqual(check_rubric(RUBRIC, ASSESSMENT), [])

    def test_unknown_question(self):
        rubric = {"points": [{"id": "p1", "question_id": "q9",
                              "description": "x", "max_marks": 1}]}
        self.assertTrue(check_rubric(rubric, ASSESSMENT))

    def test_sum_above_question_max_allowed(self):
        rubric = {"points": [{"id": "p1", "question_id": "q1",
                              "description": "x", "max_marks": 4},
                             {"id": "p2", "question_id": "q2",
                              "description": "y", "max_marks": 2},
                             {"id": "p3", "question_id": "q2",
                              "description": "z", "max_marks": 1}]}
        self.assertEqual(check_rubric(rubric, ASSESSMENT), [])

    def test_sum_below_question_max_rejected(self):
        rubric = {"points": [{"id": "p1", "question_id": "q1",
                              "description": "x", "max_marks": 4},
                             {"id": "p2", "question_id": "q2",
                              "description": "y", "max_marks": 1}]}
        self.assertTrue(check_rubric(rubric, ASSESSMENT))

    def test_question_without_points_rejected(self):
        rubric = {"points": [{"id": "p1", "question_id": "q1",
                              "description": "x", "max_marks": 4}]}
        errors = check_rubric(rubric, ASSESSMENT)
        self.assertTrue(any("q2" in error for error in errors))

    def test_bad_max_marks(self):
        rubric = {"points": [{"id": "p1", "question_id": "q1",
                              "description": "x", "max_marks": 0.3}]}
        self.assertTrue(check_rubric(rubric, ASSESSMENT))


class AcceptRejectTests(unittest.TestCase):
    def _rubric_with(self, **extra):
        points = [dict(p) for p in RUBRIC["points"]]
        points[0] = dict(points[0], **extra)
        return {"assessment_id": "demo", "points": points}

    def test_valid_notes(self):
        rubric = self._rubric_with(accept=["energy", "ATP"],
                                   reject=["heat"])
        self.assertEqual(check_rubric(rubric, ASSESSMENT), [])

    def test_missing_notes_ok(self):
        self.assertEqual(check_rubric(RUBRIC, ASSESSMENT), [])

    def test_notes_must_be_lists(self):
        rubric = self._rubric_with(accept="energy")
        self.assertTrue(check_rubric(rubric, ASSESSMENT))

    def test_notes_must_be_strings(self):
        rubric = self._rubric_with(reject=["cold", 5])
        self.assertTrue(check_rubric(rubric, ASSESSMENT))


class SimilarityTests(unittest.TestCase):
    def test_containment(self):
        self.assertTrue(quotes_similar(
            "produce energy", "mitochondria produce energy daily"))
        self.assertTrue(quotes_similar(
            "mitochondria produce energy daily", "produce energy"))

    def test_word_overlap(self):
        self.assertTrue(quotes_similar("water boils at 100 degrees",
                                       "water boils at one hundred degrees"))

    def test_different(self):
        self.assertFalse(quotes_similar("cell wall", "cell membrane"))
        self.assertFalse(quotes_similar("mitochondria", "chloroplast"))

    def test_empty_never_similar(self):
        self.assertFalse(quotes_similar("", "something"))
        self.assertFalse(quotes_similar("something", ""))


if __name__ == "__main__":
    unittest.main()
