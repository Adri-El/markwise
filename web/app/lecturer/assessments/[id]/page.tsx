import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { effectiveScores, hasOverrides } from "@/lib/scoring";
import type { Award, ResultOverrides } from "@/lib/scoring";
import { createClient } from "@/lib/supabase/server";
import { DRAFT_BLOCK_REASON } from "@/lib/types";
import type {
  Assessment,
  CourseNote,
  MarkingJob,
  MarkingScheme,
  Question,
  RubricPoint,
} from "@/lib/types";
import Alert from "@/components/ui/Alert";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CopyButton from "@/components/CopyButton";
import CourseNotesUpload from "@/components/CourseNotesUpload";
import LocalDateTime from "@/components/LocalDateTime";
import MarkAllStatus from "@/components/MarkAllStatus";
import PublishControls from "@/components/PublishControls";
import ResultsTable, {
  sortResultRows,
  type ResultRow,
} from "@/components/ResultsTable";
import RubricEditor from "@/components/RubricEditor";
import RubricStatus from "@/components/RubricStatus";
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
  const questionList = ((questions ?? []) as Question[]);
  const { data: rubricRows } = await supabase
    .from("rubrics")
    .select("points, approved")
    .eq("assessment_id", id)
    .limit(1);
  const rubricRow = (rubricRows ?? [])[0] as
    | { points: unknown; approved: boolean }
    | undefined;
  const rubricPoints = Array.isArray(rubricRow?.points)
    ? (rubricRow.points as RubricPoint[])
    : [];
  const rubricApproved = rubricRow?.approved ?? false;
  const { data: jobRows } = await supabase
    .from("marking_jobs")
    .select("*")
    .eq("assessment_id", id)
    .eq("type", "build_rubric")
    .order("created_at", { ascending: false })
    .limit(1);
  const latestJob = ((jobRows ?? [])[0] as MarkingJob | undefined) ?? null;
  const canDraft =
    noteList.length > 0 ||
    (questionList.length > 0 &&
      questionList.every((q) => schemeByQuestion.has(q.id)));
  const { count: enrolledCount } = await supabase
    .from("enrollments")
    .select("student_id", { count: "exact", head: true })
    .eq("assessment_id", id);
  const { data: submittedSubs } = await supabase
    .from("submissions")
    .select("id, student_id")
    .eq("assessment_id", id)
    .eq("status", "submitted");
  const submittedList = ((submittedSubs ?? []) as {
    id: string;
    student_id: string;
  }[]);
  const submittedCount = submittedList.length;
  const { data: markJobRows } = await supabase
    .from("marking_jobs")
    .select("*")
    .eq("assessment_id", id)
    .eq("type", "mark_all")
    .order("created_at", { ascending: false })
    .limit(1);
  const latestMarkJob =
    ((markJobRows ?? [])[0] as MarkingJob | undefined) ?? null;
  interface ResultShape {
    submission_id: string;
    status: "marked" | "needs_review" | "incomplete";
    awards: unknown;
    overrides: unknown;
    flags: unknown;
    marked_at: string | null;
    approved: boolean;
    published: boolean;
  }
  let resultShapes: ResultShape[] = [];
  let profileShapes: {
    id: string;
    full_name: string;
    matric_number: string | null;
  }[] = [];
  if (submittedList.length > 0) {
    const subIds = submittedList.map((s) => s.id);
    const { data: results } = await supabase
      .from("results")
      .select(
        "submission_id, status, awards, overrides, flags, marked_at, approved, published",
      )
      .in("submission_id", subIds);
    resultShapes = (results ?? []) as ResultShape[];
    const studentIds = [...new Set(submittedList.map((s) => s.student_id))];
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, matric_number")
      .in("id", studentIds);
    profileShapes = (profiles ?? []) as typeof profileShapes;
  }
  const resultBySub = new Map(
    resultShapes.map((r) => [r.submission_id, r]),
  );
  const profileById = new Map(profileShapes.map((p) => [p.id, p]));
  const markedCount = submittedList.filter((s) => {
    const status = resultBySub.get(s.id)?.status;
    return status === "marked" || status === "needs_review";
  }).length;
  const waitingCount = submittedList.filter((s) => {
    const result = resultBySub.get(s.id);
    return (
      !result || (result.status === "incomplete" && !result.approved)
    );
  }).length;
  const resultTableRows: ResultRow[] = sortResultRows(
    submittedList.map((s) => {
      const result = resultBySub.get(s.id);
      const profile = profileById.get(s.student_id);
      const awards = Array.isArray(result?.awards)
        ? (result.awards as Award[])
        : [];
      const overrides = (result?.overrides ?? {}) as ResultOverrides;
      const effective = result
        ? effectiveScores(questionList, rubricPoints, awards, overrides)
        : null;
      return {
        submissionId: s.id,
        studentName: profile?.full_name ?? "Unknown student",
        matric: profile?.matric_number ?? null,
        status: result?.status ?? null,
        total: effective?.total ?? null,
        max: effective?.max ?? null,
        flags: Array.isArray(result?.flags) ? result.flags.length : 0,
        markedAt: result?.marked_at ?? null,
        edited: result ? hasOverrides(overrides) : false,
        approved: result?.approved ?? false,
        published: result?.published ?? false,
      };
    }),
  );
  const approvedCount = resultTableRows.filter((r) => r.approved).length;
  const publishedCount = resultTableRows.filter((r) => r.published).length;
  const publishableCount = resultTableRows.filter(
    (r) => r.approved && !r.published,
  ).length;

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
            <dt className="text-sm font-medium text-slate-900">Submissions</dt>
            <dd className="text-sm text-slate-600">
              {submittedCount ?? 0} submitted of {enrolledCount ?? 0} enrolled
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2">
            <dt className="text-sm font-medium text-slate-900">Course notes</dt>
            <dd className="text-sm text-slate-600">
              {noteList.length} {noteList.length === 1 ? "file" : "files"}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 py-2">
            <dt className="shrink-0 pt-0.5 text-sm font-medium text-slate-900">
              Rubric
            </dt>
            <dd className="min-w-0 flex-1">
              <RubricStatus
                assessmentId={id}
                initialJob={latestJob}
                pointsCount={rubricPoints.length}
                approved={rubricApproved}
                canDraft={canDraft}
                draftBlockReason={canDraft ? null : DRAFT_BLOCK_REASON}
              />
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4 py-2">
            <dt className="shrink-0 pt-0.5 text-sm font-medium text-slate-900">
              Marking
            </dt>
            <dd className="min-w-0 flex-1">
              <MarkAllStatus
                assessmentId={id}
                initialJob={latestMarkJob}
                rubricApproved={rubricApproved}
                submitted={submittedCount}
                marked={markedCount}
                waiting={waitingCount}
                closesAt={a.closes_at}
              />
            </dd>
          </div>
        </dl>
      </Card>
      {submittedList.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {approvedCount} of {resultTableRows.length} approved ·{" "}
            {publishedCount} published
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <PublishControls
              assessmentId={id}
              publishable={publishableCount}
              published={publishedCount}
            />
            <Button
              variant="secondary"
              href={`/lecturer/assessments/${id}/export`}
            >
              Download Excel
            </Button>
          </div>
          <ResultsTable assessmentId={id} rows={resultTableRows} />
        </div>
      )}
      {rubricPoints.length > 0 && (
        <RubricEditor
          assessmentId={id}
          questions={questionList}
          initialPoints={rubricPoints}
          approved={rubricApproved}
        />
      )}
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
