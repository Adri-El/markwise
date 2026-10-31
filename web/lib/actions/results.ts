"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { effectiveScores } from "../scoring";
import type {
  Award,
  ResultFinal,
  ResultOverrides,
  PointOverride,
} from "../scoring";
import { createClient } from "../supabase/server";
import type { Question, RubricPoint } from "../types";

export interface OverrideResult {
  ok: boolean;
  error?: string;
}

const UNPUBLISH_MARKS = "Unpublish before changing marks.";

interface OwnedResult {
  assessmentId: string;
  overrides: ResultOverrides;
  published: boolean;
  points: RubricPoint[];
  questions: Question[];
  scores: Record<string, { marks: number; max: number; comment: string }>;
  awards: Award[];
}

async function loadOwnedResult(
  submissionId: string,
): Promise<OwnedResult | { error: string }> {
  const supabase = await createClient();
  const { data: submission } = await supabase
    .from("submissions")
    .select("id, assessment_id")
    .eq("id", submissionId)
    .single();
  if (!submission) return { error: "Submission not found." };
  const assessmentId = (submission as { assessment_id: string }).assessment_id;
  const { data: assessment } = await supabase
    .from("assessments")
    .select("id")
    .eq("id", assessmentId)
    .single();
  if (!assessment) return { error: "Submission not found." };
  const { data: resultRows } = await supabase
    .from("results")
    .select("overrides, published, scores, awards")
    .eq("submission_id", submissionId)
    .limit(1);
  const row = (resultRows ?? [])[0] as
    | {
        overrides: unknown;
        published: boolean;
        scores: unknown;
        awards: unknown;
      }
    | undefined;
  if (!row) return { error: "No result to change yet." };
  const { data: rubricRows } = await supabase
    .from("rubrics")
    .select("points")
    .eq("assessment_id", assessmentId)
    .limit(1);
  const saved = (rubricRows ?? [])[0] as { points?: unknown } | undefined;
  const points = Array.isArray(saved?.points)
    ? (saved.points as RubricPoint[])
    : [];
  const { data: questionRows } = await supabase
    .from("questions")
    .select("*")
    .eq("assessment_id", assessmentId)
    .order("position");
  const overrides =
    row.overrides !== null && typeof row.overrides === "object"
      ? (row.overrides as ResultOverrides)
      : {};
  const scores =
    row.scores !== null && typeof row.scores === "object"
      ? (row.scores as OwnedResult["scores"])
      : {};
  const awards = Array.isArray(row.awards) ? (row.awards as Award[]) : [];
  return {
    assessmentId,
    overrides,
    published: row.published,
    points,
    questions: (questionRows ?? []) as Question[],
    scores,
    awards,
  };
}

function validMarks(marks: number, max: number): boolean {
  return (
    Number.isFinite(marks) &&
    marks >= 0 &&
    marks <= max &&
    Math.abs(marks * 2 - Math.round(marks * 2)) < 1e-9
  );
}

function revalidateReview(assessmentId: string, submissionId: string) {
  revalidatePath(
    `/lecturer/assessments/${assessmentId}/results/${submissionId}`,
  );
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
}

export async function setPointOverride(
  submissionId: string,
  pointId: string,
  marks: number,
  note: string,
): Promise<OverrideResult> {
  await requireRole("lecturer");
  const loaded = await loadOwnedResult(submissionId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  if (loaded.published) return { ok: false, error: UNPUBLISH_MARKS };
  const point = loaded.points.find((p) => p.id === pointId);
  if (!point) return { ok: false, error: "Unknown rubric point." };
  if (!validMarks(marks, point.max_marks))
    return {
      ok: false,
      error: `Marks must be a multiple of 0.5 between 0 and ${point.max_marks}.`,
    };
  if (!note.trim())
    return { ok: false, error: "Add a short note explaining the change." };
  if (note.length > 300)
    return { ok: false, error: "Keep the note under 300 characters." };
  const entry: PointOverride = {
    marks,
    note: note.trim(),
    at: new Date().toISOString(),
  };
  const supabase = await createClient();
  const { error } = await supabase
    .from("results")
    .update({
      overrides: {
        ...loaded.overrides,
        points: { ...(loaded.overrides.points ?? {}), [pointId]: entry },
      },
      approved: false,
    })
    .eq("submission_id", submissionId);
  if (error) {
    console.error("setPointOverride failed:", error.message);
    return { ok: false, error: "Could not save the change. Try again." };
  }
  revalidateReview(loaded.assessmentId, submissionId);
  return { ok: true };
}

export async function clearPointOverride(
  submissionId: string,
  pointId: string,
): Promise<OverrideResult> {
  await requireRole("lecturer");
  const loaded = await loadOwnedResult(submissionId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  if (loaded.published) return { ok: false, error: UNPUBLISH_MARKS };
  const remaining = { ...(loaded.overrides.points ?? {}) };
  delete remaining[pointId];
  const supabase = await createClient();
  const { error } = await supabase
    .from("results")
    .update({
      overrides: { ...loaded.overrides, points: remaining },
      approved: false,
    })
    .eq("submission_id", submissionId);
  if (error) {
    console.error("clearPointOverride failed:", error.message);
    return { ok: false, error: "Could not undo the change. Try again." };
  }
  revalidateReview(loaded.assessmentId, submissionId);
  return { ok: true };
}

export async function approveResult(
  submissionId: string,
): Promise<OverrideResult> {
  await requireRole("lecturer");
  const loaded = await loadOwnedResult(submissionId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const effective = effectiveScores(
    loaded.questions,
    loaded.points,
    loaded.awards,
    loaded.overrides,
  );
  const final: ResultFinal = {
    questions: Object.fromEntries(
      Object.entries(effective.perQuestion).map(([code, s]) => [
        code,
        {
          marks: s.final,
          max: s.max,
          comment: loaded.scores[code]?.comment ?? "",
        },
      ]),
    ),
    total: effective.total,
    max: effective.max,
    approved_at: new Date().toISOString(),
  };
  const supabase = await createClient();
  const { error } = await supabase
    .from("results")
    .update({ approved: true, final })
    .eq("submission_id", submissionId);
  if (error) {
    console.error("approveResult failed:", error.message);
    return { ok: false, error: "Could not approve. Try again." };
  }
  revalidateReview(loaded.assessmentId, submissionId);
  return { ok: true };
}

export async function unapproveResult(
  submissionId: string,
): Promise<OverrideResult> {
  await requireRole("lecturer");
  const loaded = await loadOwnedResult(submissionId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  if (loaded.published)
    return { ok: false, error: "Unpublish before changing approval." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("results")
    .update({ approved: false, final: null })
    .eq("submission_id", submissionId);
  if (error) {
    console.error("unapproveResult failed:", error.message);
    return { ok: false, error: "Could not unapprove. Try again." };
  }
  revalidateReview(loaded.assessmentId, submissionId);
  return { ok: true };
}

export interface PublishResult {
  ok: boolean;
  count?: number;
  error?: string;
}

async function ownedSubmissionIds(
  assessmentId: string,
): Promise<string[] | { error: string }> {
  const supabase = await createClient();
  const { data: assessment } = await supabase
    .from("assessments")
    .select("id")
    .eq("id", assessmentId)
    .single();
  if (!assessment) return { error: "Assessment not found." };
  const { data: subs } = await supabase
    .from("submissions")
    .select("id")
    .eq("assessment_id", assessmentId);
  return ((subs ?? []) as { id: string }[]).map((s) => s.id);
}

export async function publishResults(
  assessmentId: string,
): Promise<PublishResult> {
  await requireRole("lecturer");
  const ids = await ownedSubmissionIds(assessmentId);
  if (!Array.isArray(ids)) return { ok: false, error: ids.error };
  let count = 0;
  if (ids.length > 0) {
    const supabase = await createClient();
    const { count: updated, error } = await supabase
      .from("results")
      .update({ published: true }, { count: "exact" })
      .in("submission_id", ids)
      .eq("approved", true);
    if (error) {
      console.error("publishResults failed:", error.message);
      return { ok: false, error: "Could not publish. Try again." };
    }
    count = updated ?? 0;
  }
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
  revalidatePath("/student");
  return { ok: true, count };
}

export async function unpublishResults(
  assessmentId: string,
): Promise<PublishResult> {
  await requireRole("lecturer");
  const ids = await ownedSubmissionIds(assessmentId);
  if (!Array.isArray(ids)) return { ok: false, error: ids.error };
  let count = 0;
  if (ids.length > 0) {
    const supabase = await createClient();
    const { count: updated, error } = await supabase
      .from("results")
      .update({ published: false }, { count: "exact" })
      .in("submission_id", ids);
    if (error) {
      console.error("unpublishResults failed:", error.message);
      return { ok: false, error: "Could not unpublish. Try again." };
    }
    count = updated ?? 0;
  }
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
  revalidatePath("/student");
  return { ok: true, count };
}
