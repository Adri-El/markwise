"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { createClient } from "../supabase/server";
import { isPast } from "../schedule";
import { MAX_ANSWER_CHARS } from "../types";

export interface SaveAnswersInput {
  assessmentId: string;
  answers: { questionId: string; text: string; pdfPath: string | null }[];
}

export interface SubmissionResult {
  ok: boolean;
  error?: string;
}

function friendlySubmitError(message: string): string {
  if (message.includes("already submitted"))
    return "This submission was already submitted.";
  if (message.includes("assessment is closed"))
    return "This assessment is closed. Submissions are no longer accepted.";
  if (message.includes("no submission found"))
    return "No draft submission was found. Save a draft first.";
  return "Could not submit. Try again.";
}

export async function saveDraft(
  input: SaveAnswersInput,
): Promise<SubmissionResult> {
  const profile = await requireRole("student");
  for (const a of input.answers) {
    if (a.text.length > MAX_ANSWER_CHARS)
      return { ok: false, error: "One answer is over the 20,000 character limit." };
  }
  const supabase = await createClient();
  const { data: submission } = await supabase
    .from("submissions")
    .select("id, status")
    .eq("assessment_id", input.assessmentId)
    .eq("student_id", profile.id)
    .single();
  if (!submission) return { ok: false, error: "No draft submission was found." };
  if ((submission as { status: string }).status !== "draft")
    return { ok: false, error: "This submission was already submitted." };
  const submissionId = (submission as { id: string }).id;
  const { data: questions } = await supabase
    .from("questions")
    .select("id")
    .eq("assessment_id", input.assessmentId);
  const validIds = new Set(
    ((questions ?? []) as { id: string }[]).map((q) => q.id),
  );
  for (const a of input.answers) {
    if (!validIds.has(a.questionId))
      return { ok: false, error: "Unknown question." };
    if (
      a.pdfPath !== null &&
      a.pdfPath !== `${input.assessmentId}/${profile.id}/${a.questionId}.pdf`
    )
      return { ok: false, error: "Invalid file path." };
  }
  const { data: assessment } = await supabase
    .from("assessments")
    .select("opens_at, closes_at")
    .eq("id", input.assessmentId)
    .single();
  const times = assessment as {
    opens_at: string | null;
    closes_at: string | null;
  } | null;
  const notOpen =
    !times ||
    (times.opens_at !== null &&
      new Date(times.opens_at).getTime() > Date.now()) ||
    (times.closes_at !== null && isPast(times.closes_at));
  if (notOpen)
    return {
      ok: false,
      error: "This assessment is closed. Answers can no longer be saved.",
    };
  const { error } = await supabase.from("answers").upsert(
    input.answers.map((a) => ({
      submission_id: submissionId,
      question_id: a.questionId,
      text: a.text,
      pdf_path: a.pdfPath,
    })),
    { onConflict: "submission_id,question_id" },
  );
  if (error) {
    console.error("saveDraft failed:", error.message);
    return { ok: false, error: "Could not save the draft. Try again." };
  }
  revalidatePath(`/student/assessments/${input.assessmentId}`);
  revalidatePath("/student");
  return { ok: true };
}

export async function submitWork(
  assessmentId: string,
): Promise<SubmissionResult> {
  await requireRole("student");
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_submission", {
    p_assessment_id: assessmentId,
  });
  if (error) {
    console.error("submitWork failed:", error.message);
    return { ok: false, error: friendlySubmitError(error.message) };
  }
  revalidatePath(`/student/assessments/${assessmentId}`);
  revalidatePath("/student");
  return { ok: true };
}
