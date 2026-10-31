"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { createClient } from "../supabase/server";
import { DRAFT_BLOCK_REASON } from "../types";

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
