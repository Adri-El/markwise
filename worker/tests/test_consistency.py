"""Offline tests for worker.consistency. No API calls."""

import unittest

from worker.consistency import find_conflicts, quote_in_answer, quotes_match

RUBRIC = {"points": [{"id": "p1", "question_id": "q1",
                       "description": "x", "max_marks": 2}]}


def run(student, marks, quote="", reason="", stored=""):
    return {"student_id": student, "status": "marked",
            "awards": {"p1": {"point_id": "p1", "marks": marks,
                              "quote": quote, "reason": reason}},
            "stored": {"q1": stored}}


class QuoteInAnswerTests(unittest.TestCase):
    def test_exact_match_ignores_case_and_spaces(self):
        self.assertTrue(quote_in_answer(
            "Produce  ENERGY", "mitochondria produce energy daily"))

    def test_overlap_without_containment_is_not_a_match(self):
        self.assertFalse(quote_in_answer(
            "water boils at 100 degrees",
            "the water no longer boils and degrees fall from 100"))

    def test_empty_never_matches(self):
        self.assertFalse(quote_in_answer("", "something"))


class QuotesMatchTests(unittest.TestCase):
    def test_similar_long_quotes(self):
        self.assertTrue(quotes_match("water boils at 100 degrees",
                                     "water boils at one hundred degrees"))

    def test_short_quotes_never_match(self):
        self.assertFalse(quotes_match("cell wall", "cell wall"))

    def test_dissimilar_long_quotes(self):
        self.assertFalse(quotes_match("mitochondria produce energy daily",
                                      "chloroplasts trap light for glucose"))


class FindConflictsTests(unittest.TestCase):
    def test_similar_quotes_conflict_includes_reasons(self):
        runs = [
            run("s03", 1, "water boils at 100 degrees",
                "correct value stated", "water boils at 100 degrees"),
            run("s08", 2, "water boils at one hundred degrees",
                "full credit", "water boils at one hundred degrees"),
        ]
        conflicts = find_conflicts(RUBRIC, runs)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["kind"], "similar_quotes")
        self.assertEqual(conflicts[0]["a"]["reason"], "correct value stated")
        self.assertEqual(conflicts[0]["b"]["reason"], "full credit")

    def test_quote_in_answer_conflict(self):
        runs = [
            run("s03", 1, "particles moving", "names the movement",
                "diffusion is particles moving"),
            run("s12", 0, "", "too vague",
                "diffusion is particles moving fast"),
        ]
        conflicts = find_conflicts(RUBRIC, runs)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]["kind"], "quote_in_answer")

    def test_overlap_only_answer_is_skipped(self):
        runs = [
            run("s03", 1, "water boils at 100 degrees", "correct",
                "water boils at 100 degrees"),
            run("s12", 0, "", "too vague",
                "the water no longer boils and degrees fall from 100"),
        ]
        self.assertEqual(find_conflicts(RUBRIC, runs), [])

    def test_scheme_reasons_are_skipped(self):
        for reason in ("rejected per scheme note", "only the first two count"):
            with self.subTest(reason=reason):
                runs = [
                    run("s03", 1, "particles moving", "names the movement",
                        "diffusion is particles moving"),
                    run("s11", 0, "", reason,
                        "diffusion is particles moving"),
                ]
                self.assertEqual(find_conflicts(RUBRIC, runs), [])

    def test_same_marks_no_conflict(self):
        runs = [
            run("s01", 2, "water boils at 100 degrees", "correct",
                "water boils at 100 degrees"),
            run("s02", 2, "water boils at 100 degrees", "correct",
                "water boils at 100 degrees"),
        ]
        self.assertEqual(find_conflicts(RUBRIC, runs), [])


if __name__ == "__main__":
    unittest.main()
