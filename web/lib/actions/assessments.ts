"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { createClient } from "../supabase/server";
import { isPast, isValidDate } from "../schedule";
import type { AnswerMode, Assessment, AssessmentKind } from "../types";

export interface QuestionInput {
  prompt: string;
  maxMarks: number;
  scheme: string;
  subparts: { id: string; maxMarks: number }[];
}

export interface CreateAssessmentInput {
  title: string;
  kind: AssessmentKind;
  instructions: string;
  opensAt: string | null;
  closesAt: string | null;
  answerMode: AnswerMode;
  referenceNote: string;
  questions: QuestionInput[];
}

export interface CreateResult {
  ok: boolean;
  id?: string;
  error?: string;
}

function validMarks(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    Math.abs(value * 2 - Math.round(value * 2)) < 1e-9
  );
}

export async function createAssessment(
  input: CreateAssessmentInput,
): Promise<CreateResult> {
  await requireRole("lecturer");
  if (!input.title.trim()) return { ok: false, error: "Title is required." };
  if (input.kind !== "assignment" && input.kind !== "test" && input.kind !== "exam")
    return { ok: false, error: "Kind must be assignment, test or exam." };
  if (input.answerMode !== "typed" && input.answerMode !== "pdf")
    return { ok: false, error: "Answer mode must be typed or PDF." };

  let opensAt: string | null = null;
  let closesAt: string | null = null;
  if (input.kind === "assignment") {
    if (!isValidDate(input.closesAt))
      return { ok: false, error: "A due date and time is required." };
    closesAt = input.closesAt;
    if (isPast(closesAt)) return { ok: false, error: "Due must not be in the past." };
  } else {
    if (!isValidDate(input.opensAt) || !isValidDate(input.closesAt))
      return { ok: false, error: "Opens and Closes are both required." };
    opensAt = input.opensAt;
    closesAt = input.closesAt;
    if (isPast(opensAt)) return { ok: false, error: "Opens must not be in the past." };
    if (isPast(closesAt)) return { ok: false, error: "Closes must not be in the past." };
    if (new Date(closesAt).getTime() <= new Date(opensAt).getTime())
      return { ok: false, error: "Closes must be after Opens." };
  }

  if (input.questions.length === 0)
    return { ok: false, error: "Add at least one question." };
  for (const [i, q] of input.questions.entries()) {
    const n = i + 1;
    if (!q.prompt.trim())
      return { ok: false, error: `Question ${n}: prompt is required.` };
    if (!validMarks(q.maxMarks))
      return {
        ok: false,
        error: `Question ${n}: max marks must be a positive multiple of 0.5.`,
      };
    if (q.subparts.length > 0) {
      const ids = q.subparts.map((s) => s.id);
      if (ids.some((id) => !/^[a-z]$/.test(id)))
        return {
          ok: false,
          error: `Question ${n}: sub-part ids must be single lowercase letters (a, b, c…).`,
        };
      if (new Set(ids).size !== ids.length)
        return {
          ok: false,
          error: `Question ${n}: sub-part ids must be unique.`,
        };
      for (const s of q.subparts) {
        if (!validMarks(s.maxMarks))
          return {
            ok: false,
            error: `Question ${n}: each sub-part max must be a positive multiple of 0.5.`,
          };
      }
      const sum = q.subparts.reduce((total, s) => total + s.maxMarks, 0);
      if (Math.abs(sum - q.maxMarks) > 1e-9)
        return {
          ok: false,
          error: `Question ${n}: sub-part marks must sum exactly to the question max (${q.maxMarks}).`,
        };
    }
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_assessment", {
    p: {
      title: input.title.trim(),
      kind: input.kind,
      instructions: input.instructions,
      opens_at: opensAt,
      closes_at: closesAt,
      answer_mode: input.answerMode,
      reference_note: input.referenceNote,
      questions: input.questions.map((q) => ({
        prompt: q.prompt.trim(),
        max_marks: q.maxMarks,
        scheme: q.scheme.trim(),
        subparts: q.subparts.map((s) => ({ id: s.id, max_marks: s.maxMarks })),
      })),
    },
  });
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save." };
  }
  revalidatePath("/lecturer");
  return { ok: true, id: data as string };
}

export interface UpdateScheduleInput {
  assessmentId: string;
  opensAt: string | null;
  closesAt: string | null;
}

export interface UpdateResult {
  ok: boolean;
  error?: string;
}

export async function updateSchedule(
  input: UpdateScheduleInput,
): Promise<UpdateResult> {
  await requireRole("lecturer");
  const supabase = await createClient();
  const { data: row } = await supabase
    .from("assessments")
    .select("id, kind, opens_at, closes_at")
    .eq("id", input.assessmentId)
    .single();
  if (!row) return { ok: false, error: "Assessment not found." };
  const current = row as Pick<
    Assessment,
    "id" | "kind" | "opens_at" | "closes_at"
  >;

  let opensAt: string | null;
  let closesAt: string;
  if (current.kind === "assignment") {
    if (input.opensAt !== null)
      return { ok: false, error: "Assignments have a due time only." };
    if (!isValidDate(input.closesAt))
      return { ok: false, error: "A due date and time is required." };
    if (isPast(input.closesAt))
      return { ok: false, error: "Due must not be in the past." };
    opensAt = null;
    closesAt = input.closesAt;
  } else {
    if (!isValidDate(input.opensAt) || !isValidDate(input.closesAt))
      return { ok: false, error: "Opens and Closes are both required." };
    if (isPast(input.closesAt))
      return { ok: false, error: "Closes must not be in the past." };
    if (
      new Date(input.closesAt).getTime() <= new Date(input.opensAt).getTime()
    )
      return { ok: false, error: "Closes must be after Opens." };
    if (
      current.opens_at !== null &&
      isPast(current.opens_at) &&
      new Date(input.opensAt).getTime() !==
        new Date(current.opens_at).getTime()
    )
      return {
        ok: false,
        error:
          "This assessment has already opened; only the due time can change.",
      };
    opensAt = input.opensAt;
    closesAt = input.closesAt;
  }

  const { error } = await supabase
    .from("assessments")
    .update({ opens_at: opensAt, closes_at: closesAt })
    .eq("id", input.assessmentId);
  if (error) {
    console.error("updateSchedule failed:", error.message);
    return { ok: false, error: "Could not save the schedule." };
  }
  revalidatePath("/lecturer");
  revalidatePath(`/lecturer/assessments/${input.assessmentId}`);
  revalidatePath("/student");
  return { ok: true };
}
