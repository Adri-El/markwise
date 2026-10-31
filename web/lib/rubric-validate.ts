import type { Question, RubricPoint } from "./types";

// Pure client/server validation mirroring worker/tools.py check_rubric:
// unique ids, known question codes, descriptions, half-mark maxima,
// accept/reject lists, complete source trios, decision reasons, and
// per-question sums at or above the question max.
export function validateRubric(
  points: RubricPoint[],
  questions: Question[],
): string[] {
  if (!Array.isArray(points) || points.length === 0) {
    return ["The rubric has no points yet."];
  }
  const maxByCode = new Map(questions.map((q) => [q.code, q.max_marks]));
  const errors: string[] = [];
  const seen = new Set<string>();
  const totals = new Map<string, number>();

  points.forEach((point, index) => {
    const where = label(point, index);
    if (typeof point.id !== "string" || !point.id) {
      errors.push(`${where}: it is missing an id.`);
      return;
    }
    if (seen.has(point.id)) {
      errors.push(`${where}: this id is used more than once.`);
    }
    seen.add(point.id);
    if (
      typeof point.question_id !== "string" ||
      !maxByCode.has(point.question_id)
    ) {
      errors.push(
        `${where}: question ${JSON.stringify(point.question_id)} is not part of this assessment.`,
      );
      return;
    }
    if (
      typeof point.description !== "string" ||
      !point.description.trim()
    ) {
      errors.push(`${where}: add a description.`);
    }
    for (const key of ["accept", "reject"] as const) {
      const notes = point[key];
      if (
        notes != null &&
        (!Array.isArray(notes) || notes.some((n) => typeof n !== "string"))
      ) {
        errors.push(`${where}: ${key} notes must be a list of text.`);
      }
    }
    const { source_quote, source_file, source_page } = point;
    if (source_quote != null || source_file != null || source_page != null) {
      if (typeof source_quote !== "string" || !source_quote.trim()) {
        errors.push(`${where}: the source quote must not be empty.`);
      }
      if (typeof source_file !== "string" || !source_file.trim()) {
        errors.push(`${where}: the source file must not be empty.`);
      }
      if (
        typeof source_page !== "number" ||
        !Number.isInteger(source_page) ||
        source_page < 1
      ) {
        errors.push(
          `${where}: the source page must be a positive whole number.`,
        );
      }
    }
    if (
      point.needs_lecturer === true &&
      (typeof point.reason !== "string" || !point.reason.trim())
    ) {
      errors.push(
        `${where}: add a reason while it still needs your decision.`,
      );
    }
    if (!isHalfMarks(point.max_marks) || point.max_marks <= 0) {
      errors.push(`${where}: marks must be a positive multiple of 0.5.`);
      return;
    }
    totals.set(
      point.question_id,
      (totals.get(point.question_id) ?? 0) + point.max_marks,
    );
  });

  for (const q of questions) {
    if (!totals.has(q.code)) {
      errors.push(`Question ${q.code} has no points yet.`);
      continue;
    }
    const total = totals.get(q.code) ?? 0;
    if (typeof q.max_marks === "number" && q.max_marks - total > 1e-9) {
      errors.push(
        `Question ${q.code}: points add up to ${total}, below the question max of ${q.max_marks}.`,
      );
    }
  }
  return errors;
}

function label(
  point: { id?: unknown; question_id?: unknown },
  index: number,
): string {
  const name =
    typeof point.id === "string" && point.id ? point.id : `#${index + 1}`;
  const code =
    typeof point.question_id === "string" && point.question_id
      ? ` (${point.question_id})`
      : "";
  return `Point ${name}${code}`;
}

function isHalfMarks(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value * 2 - Math.round(value * 2)) < 1e-9
  );
}
