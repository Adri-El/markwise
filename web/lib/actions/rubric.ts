"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { validateRubric } from "../rubric-validate";
import { createClient } from "../supabase/server";
import { DRAFT_BLOCK_REASON } from "../types";
import type { Question, RubricPoint } from "../types";

export interface QueueResult {
  ok: boolean;
  error?: string;
}

export async function queueRubricDraft(
  assessmentId: string,
): Promise<QueueResult> {
  await requireRole("lecturer");
  const supabase = await createClient();
  const { data: assessment } = await supabase
    .from("assessments")
    .select("id")
    .eq("id", assessmentId)
    .single();
  if (!assessment) return { ok: false, error: "Assessment not found." };

  const { data: markJobs } = await supabase
    .from("marking_jobs")
    .select("id")
    .eq("assessment_id", assessmentId)
    .eq("type", "mark_all")
    .limit(1);
  if ((markJobs ?? []).length > 0)
    return {
      ok: false,
      error: "Marking has started; the rubric can't be redrafted.",
    };

  const { data: notes } = await supabase
    .from("course_notes")
    .select("id")
    .eq("assessment_id", assessmentId)
    .limit(1);
  const { data: questions } = await supabase
    .from("questions")
    .select("id")
    .eq("assessment_id", assessmentId);
  const questionIds = ((questions ?? []) as { id: string }[]).map((q) => q.id);
  let schemeIds = new Set<string>();
  if (questionIds.length > 0) {
    const { data: schemes } = await supabase
      .from("marking_schemes")
      .select("question_id")
      .in("question_id", questionIds);
    schemeIds = new Set(
      ((schemes ?? []) as { question_id: string }[]).map(
        (s) => s.question_id,
      ),
    );
  }
  const hasNotes = (notes ?? []).length > 0;
  const allSchemed =
    questionIds.length > 0 && questionIds.every((id) => schemeIds.has(id));
  if (!hasNotes && !allSchemed)
    return { ok: false, error: DRAFT_BLOCK_REASON };

  const { error } = await supabase.from("marking_jobs").insert({
    assessment_id: assessmentId,
    type: "build_rubric",
  });
  if (error) {
    if (error.code === "23505")
      return { ok: false, error: "A draft is already in progress." };
    console.error("queueRubricDraft insert failed:", error.message);
    return { ok: false, error: "Could not queue the draft. Try again." };
  }
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
  return { ok: true };
}

export interface SaveResult {
  ok: boolean;
  error?: string;
}

const MARKING_STARTED = "Marking has started; the rubric can't be changed.";

async function ownedAssessmentId(assessmentId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("assessments")
    .select("id")
    .eq("id", assessmentId)
    .single();
  return !!data;
}

async function markingStarted(assessmentId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("marking_jobs")
    .select("id")
    .eq("assessment_id", assessmentId)
    .eq("type", "mark_all")
    .limit(1);
  return (data ?? []).length > 0;
}

async function loadQuestions(assessmentId: string): Promise<Question[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("questions")
    .select("*")
    .eq("assessment_id", assessmentId)
    .order("position");
  return (data ?? []) as Question[];
}

async function loadSavedPoints(assessmentId: string): Promise<RubricPoint[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("rubrics")
    .select("points")
    .eq("assessment_id", assessmentId)
    .limit(1);
  const saved = (data ?? [])[0] as { points?: unknown } | undefined;
  return Array.isArray(saved?.points)
    ? (saved.points as RubricPoint[])
    : [];
}

export async function saveRubric(
  assessmentId: string,
  points: RubricPoint[],
): Promise<SaveResult> {
  await requireRole("lecturer");
  if (!(await ownedAssessmentId(assessmentId)))
    return { ok: false, error: "Assessment not found." };
  if (await markingStarted(assessmentId))
    return { ok: false, error: MARKING_STARTED };
  const errors = validateRubric(points, await loadQuestions(assessmentId));
  if (errors.length > 0) return { ok: false, error: errors.join(" ") };
  const supabase = await createClient();
  const { error } = await supabase
    .from("rubrics")
    .update({
      points,
      approved: false,
      updated_at: new Date().toISOString(),
    })
    .eq("assessment_id", assessmentId);
  if (error) {
    console.error("saveRubric failed:", error.message);
    return { ok: false, error: "Could not save the rubric. Try again." };
  }
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
  return { ok: true };
}

export async function approveRubric(
  assessmentId: string,
): Promise<SaveResult> {
  await requireRole("lecturer");
  if (!(await ownedAssessmentId(assessmentId)))
    return { ok: false, error: "Assessment not found." };
  if (await markingStarted(assessmentId))
    return { ok: false, error: MARKING_STARTED };
  const saved = await loadSavedPoints(assessmentId);
  const errors = validateRubric(saved, await loadQuestions(assessmentId));
  if (errors.length > 0) return { ok: false, error: errors.join(" ") };
  if (saved.some((p) => p.needs_lecturer === true))
    return {
      ok: false,
      error: "Resolve every point marked 'Needs your decision' first.",
    };
  const supabase = await createClient();
  const { error } = await supabase
    .from("rubrics")
    .update({ approved: true, updated_at: new Date().toISOString() })
    .eq("assessment_id", assessmentId);
  if (error) {
    console.error("approveRubric failed:", error.message);
    return { ok: false, error: "Could not approve the rubric. Try again." };
  }
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
  return { ok: true };
}

export async function unapproveRubric(
  assessmentId: string,
): Promise<SaveResult> {
  await requireRole("lecturer");
  if (!(await ownedAssessmentId(assessmentId)))
    return { ok: false, error: "Assessment not found." };
  if (await markingStarted(assessmentId))
    return { ok: false, error: MARKING_STARTED };
  const supabase = await createClient();
  const { error } = await supabase
    .from("rubrics")
    .update({ approved: false, updated_at: new Date().toISOString() })
    .eq("assessment_id", assessmentId);
  if (error) {
    console.error("unapproveRubric failed:", error.message);
    return { ok: false, error: "Could not edit the rubric. Try again." };
  }
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
  return { ok: true };
}
