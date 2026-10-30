import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Assessment, MarkingScheme, Question } from "@/lib/types";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import CopyButton from "@/components/CopyButton";
import LocalDateTime from "@/components/LocalDateTime";
import StatusBadge from "@/components/StatusBadge";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

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
        <a
          href="/lecturer"
          className="font-medium text-indigo-600 hover:underline"
        >
          ← All assessments
        </a>
      </p>
      <Card>
        <div className="space-y-3">
          <h1 className="text-xl font-semibold text-slate-900">{a.title}</h1>
          <div className="flex flex-wrap gap-2">
            <Badge tone="info">{capitalize(a.kind)}</Badge>
            <StatusBadge opensAt={a.opens_at} closesAt={a.closes_at} />
            <Badge tone="neutral">
              {a.answer_mode === "pdf" ? "PDF answers" : "Typed answers"}
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <code className="rounded bg-slate-100 px-3 py-1.5 font-mono text-lg text-slate-900">
              {a.join_code}
            </code>
            <CopyButton text={a.join_code} />
          </div>
          <p className="text-sm text-slate-600">
            Opens <LocalDateTime value={a.opens_at} /> · closes{" "}
            <LocalDateTime value={a.closes_at} />
          </p>
          {a.instructions && (
            <p className="whitespace-pre-wrap text-sm text-slate-700">
              {a.instructions}
            </p>
          )}
        </div>
      </Card>
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Questions</h2>
        {((questions ?? []) as Question[]).map((q) => (
          <Card key={q.id} title={`${q.code} · ${q.max_marks} marks`}>
            <div className="space-y-3">
              <p className="whitespace-pre-wrap text-sm text-slate-700">
                {q.prompt}
              </p>
              {q.subparts.length > 0 && (
                <p className="text-sm text-slate-600">
                  Sub-parts:{" "}
                  {q.subparts.map((s) => `${s.id} (${s.max_marks})`).join(", ")}
                </p>
              )}
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="mb-1 text-xs font-semibold text-amber-800">
                  Lecturer only
                </p>
                <p className="whitespace-pre-wrap text-sm text-slate-700">
                  {schemeByQuestion.get(q.id) ?? "—"}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
