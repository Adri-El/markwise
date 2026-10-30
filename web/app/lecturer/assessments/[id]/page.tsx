import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Assessment, MarkingScheme, Question } from "@/lib/types";
import LocalDateTime from "@/components/LocalDateTime";

export default async function AssessmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole("lecturer");
  const { id } = await params;
  const supabase = await createClient();
  const { data: assessment } = await supabase
    .from("assessments")
    .select("*")
    .eq("id", id)
    .single();
  if (!assessment) notFound();
  const a = assessment as Assessment;
  const { data: questions } = await supabase
    .from("questions")
    .select("*")
    .eq("assessment_id", id)
    .order("position");
  const { data: schemes } = await supabase
    .from("marking_schemes")
    .select("*")
    .in("question_id", ((questions ?? []) as Question[]).map((q) => q.id));
  const schemeByQuestion = new Map(
    ((schemes ?? []) as MarkingScheme[]).map((s) => [s.question_id, s.scheme]),
  );

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <a href="/lecturer" className="underline">
          ← All assessments
        </a>
      </p>
      <div>
        <h1 className="text-xl font-semibold">{a.title}</h1>
        <p className="text-sm text-neutral-600">
          {a.kind} · {a.answer_mode === "pdf" ? "PDF answers" : "Typed answers"}{" "}
          · join code <strong>{a.join_code}</strong>
        </p>
        <p className="text-sm text-neutral-600">
          Opens <LocalDateTime value={a.opens_at} /> · closes{" "}
          <LocalDateTime value={a.closes_at} />
        </p>
      </div>
      {a.instructions && (
        <div>
          <h2 className="text-sm font-semibold mb-1">Instructions</h2>
          <p className="text-sm whitespace-pre-wrap">{a.instructions}</p>
        </div>
      )}
      <div>
        <h2 className="text-sm font-semibold mb-2">Questions</h2>
        <ol className="space-y-4">
          {((questions ?? []) as Question[]).map((q) => (
            <li key={q.id} className="border border-neutral-200 rounded p-4">
              <p className="text-sm font-medium">
                {q.code} · {q.max_marks} marks
              </p>
              <p className="text-sm mt-1 whitespace-pre-wrap">{q.prompt}</p>
              {q.subparts.length > 0 && (
                <p className="text-sm text-neutral-600 mt-1">
                  Sub-parts:{" "}
                  {q.subparts.map((s) => `${s.id} (${s.max_marks})`).join(", ")}
                </p>
              )}
              <p className="text-sm text-neutral-600 mt-2 whitespace-pre-wrap">
                Scheme: {schemeByQuestion.get(q.id) ?? "—"}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
