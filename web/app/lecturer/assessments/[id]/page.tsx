import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type {
  Assessment,
  CourseNote,
  MarkingScheme,
  Question,
} from "@/lib/types";
import Alert from "@/components/ui/Alert";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CopyButton from "@/components/CopyButton";
import CourseNotesUpload from "@/components/CourseNotesUpload";
import LocalDateTime from "@/components/LocalDateTime";
import ScheduleEditor from "@/components/ScheduleEditor";
import StatusBadge from "@/components/StatusBadge";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export default async function AssessmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notes_failed?: string }>;
}) {
  await requireRole("lecturer");
  const { id } = await params;
  const { notes_failed } = await searchParams;
  const failedCount = Number(notes_failed);
  const showNotesAlert =
    notes_failed !== undefined &&
    Number.isInteger(failedCount) &&
    failedCount > 0;
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
  const { data: notes } = await supabase
    .from("course_notes")
    .select("*")
    .eq("assessment_id", id)
    .order("created_at");
  const noteList = (notes ?? []) as CourseNote[];

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
          <ScheduleEditor
            assessmentId={id}
            kind={a.kind}
            opensAt={a.opens_at}
            closesAt={a.closes_at}
          />
          {a.instructions && (
            <p className="whitespace-pre-wrap text-sm text-slate-700">
              {a.instructions}
            </p>
          )}
        </div>
      </Card>
      {showNotesAlert && (
        <Alert>
          {failedCount} note file(s) didn&apos;t upload. Add them again below.
        </Alert>
      )}
      <CourseNotesUpload assessmentId={id} notes={noteList} />
      <Card title="Marking setup">
        <dl className="divide-y divide-slate-200">
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="text-sm font-medium text-slate-900">Course notes</dt>
            <dd className="text-sm text-slate-600">
              {noteList.length} {noteList.length === 1 ? "file" : "files"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="text-sm font-medium text-slate-900">Rubric</dt>
            <dd className="flex items-center gap-3 text-sm text-slate-600">
              Not drafted
              <Button disabled>Draft rubric</Button>
              <span className="text-xs">Coming next</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="text-sm font-medium text-slate-900">Marking</dt>
            <dd className="text-sm text-slate-600">
              Available after the due date
            </dd>
          </div>
        </dl>
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
                {schemeByQuestion.has(q.id) ? (
                  <p className="whitespace-pre-wrap text-sm text-slate-700">
                    {schemeByQuestion.get(q.id)}
                  </p>
                ) : (
                  <p className="text-sm text-slate-500">
                    No scheme — rubric will come from course notes
                  </p>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
