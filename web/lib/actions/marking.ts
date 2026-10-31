"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { createClient } from "../supabase/server";

export interface QueueMarkAllResult {
  ok: boolean;
  error?: string;
}

export async function queueMarkAll(
  assessmentId: string,
): Promise<QueueMarkAllResult> {
  await requireRole("lecturer");
  const supabase = await createClient();
  const { data: assessment } = await supabase
    .from("assessments")
    .select("id")
    .eq("id", assessmentId)
    .single();
  if (!assessment) return { ok: false, error: "Assessment not found." };

  const { data: rubricRows } = await supabase
    .from("rubrics")
    .select("approved")
    .eq("assessment_id", assessmentId)
    .limit(1);
  const rubric = (rubricRows ?? [])[0] as { approved: boolean } | undefined;
  if (!rubric?.approved)
    return { ok: false, error: "Approve the rubric first." };

  const { data: subs } = await supabase
    .from("submissions")
    .select("id")
    .eq("assessment_id", assessmentId)
    .eq("status", "submitted");
  const subIds = ((subs ?? []) as { id: string }[]).map((s) => s.id);
  let waiting = subIds.length;
  if (subIds.length > 0) {
    const { data: results } = await supabase
      .from("results")
      .select("submission_id, status, approved")
      .in("submission_id", subIds);
    const finished = new Set(
      (
        (results ?? []) as {
          submission_id: string;
          status: string;
          approved: boolean;
        }[]
      )
        .filter((r) => r.status !== "incomplete" || r.approved)
        .map((r) => r.submission_id),
    );
    waiting = subIds.filter((id) => !finished.has(id)).length;
  }
  if (waiting === 0)
    return { ok: false, error: "No new submissions to mark." };

  const { error } = await supabase.from("marking_jobs").insert({
    assessment_id: assessmentId,
    type: "mark_all",
  });
  if (error) {
    if (error.code === "23505")
      return { ok: false, error: "Marking is already running." };
    console.error("queueMarkAll insert failed:", error.message);
    return { ok: false, error: "Could not start marking. Try again." };
  }
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
  return { ok: true };
}
