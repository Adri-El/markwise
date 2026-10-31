"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { createClient } from "../supabase/server";
import type { ResultOverrides, PointOverride } from "../scoring";
import type { RubricPoint } from "../types";

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
    .select("overrides, published")
    .eq("submission_id", submissionId)
    .limit(1);
  const row = (resultRows ?? [])[0] as
    | { overrides: unknown; published: boolean }
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
  const overrides =
    row.overrides !== null && typeof row.overrides === "object"
      ? (row.overrides as ResultOverrides)
      : {};
  return { assessmentId, overrides, published: row.published, points };
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
  const supabase = await createClient();
  const { error } = await supabase
    .from("results")
    .update({ approved: true })
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
    .update({ approved: false })
    .eq("submission_id", submissionId);
  if (error) {
    console.error("unapproveResult failed:", error.message);
    return { ok: false, error: "Could not unapprove. Try again." };
  }
  revalidateReview(loaded.assessmentId, submissionId);
  return { ok: true };
}
