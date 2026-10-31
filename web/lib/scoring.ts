import type { Question, RubricPoint } from "./types";

export interface Award {
  point_id: string;
  marks: number;
  quote: string;
  reason: string;
}

export interface PointOverride {
  marks: number;
  note: string;
  at: string;
}

export interface ResultOverrides {
  points?: Record<string, PointOverride>;
}

export interface EffectiveQuestionScore {
  ai: number;
  final: number;
  max: number;
}

// A point's effective marks come from the lecturer's override when one
// exists, else the AI's award (0 when undecided). Each question is
// capped at its max, matching the worker's totals.
export function effectiveScores(
  questions: Question[],
  points: RubricPoint[],
  awards: Award[],
  overrides: ResultOverrides | null,
): {
  perQuestion: Record<string, EffectiveQuestionScore>;
  total: number;
  max: number;
} {
  const awardByPoint = new Map(awards.map((a) => [a.point_id, a.marks]));
  const saved = overrides?.points ?? {};
  const perQuestion: Record<string, EffectiveQuestionScore> = {};
  for (const q of questions) {
    let aiSum = 0;
    let finalSum = 0;
    for (const p of points.filter((pt) => pt.question_id === q.code)) {
      const ai = awardByPoint.get(p.id) ?? 0;
      const savedMarks = saved[p.id]?.marks;
      const final = typeof savedMarks === "number" ? savedMarks : ai;
      aiSum += ai;
      finalSum += final;
    }
    perQuestion[q.code] = {
      ai: Math.min(q.max_marks, aiSum),
      final: Math.min(q.max_marks, finalSum),
      max: q.max_marks,
    };
  }
  return {
    perQuestion,
    total: Object.values(perQuestion).reduce((t, s) => t + s.final, 0),
    max: Object.values(perQuestion).reduce((t, s) => t + s.max, 0),
  };
}

export function hasOverrides(overrides: ResultOverrides | null): boolean {
  return Object.keys(overrides?.points ?? {}).length > 0;
}

export interface ResultFinal {
  questions: Record<string, { marks: number; max: number; comment: string }>;
  total: number;
  max: number;
  approved_at: string;
}
