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
  if (message.includes("no script uploaded"))
    return "Upload your answer script (PDF) before submitting.";
  if (message.includes("choose a department"))
    return "Select your department before submitting.";
  return "Could not submit. Try again.";
}

function friendlyAttachError(message: string): string {
  if (message.includes("no submission found"))
    return "No draft submission was found.";
  if (message.includes("already submitted"))
    return "This submission was already submitted.";
  if (message.includes("not a pdf assessment"))
    return "This assessment does not take an answer script.";
  if (message.includes("assessment is closed"))
    return "This assessment is closed. The script can no longer be saved.";
  if (message.includes("script not uploaded"))
    return "Upload your script PDF first.";
  return "Could not save the script. Try again.";
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
    if (a.pdfPath !== null)
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

export async function attachScript(
  assessmentId: string,
): Promise<SubmissionResult> {
  await requireRole("student");
  const supabase = await createClient();
  const { error } = await supabase.rpc("attach_script", {
    p_assessment_id: assessmentId,
  });
  if (error) {
    console.error("attachScript failed:", error.message);
    return { ok: false, error: friendlyAttachError(error.message) };
  }
  revalidatePath(`/student/assessments/${assessmentId}`);
  revalidatePath("/student");
  return { ok: true };
}

export async function setSubmissionDepartment(
  assessmentId: string,
  department: string,
): Promise<SubmissionResult> {
  await requireRole("student");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_submission_department", {
    p_assessment_id: assessmentId,
    p_department: department,
  });
  if (error) {
    console.error("setSubmissionDepartment failed:", error.message);
    return { ok: false, error: friendlySubmitError(error.message) };
  }
  revalidatePath(`/student/assessments/${assessmentId}`);
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
