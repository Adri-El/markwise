import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { highlightQuotes } from "@/lib/highlight-quotes";
import { effectiveScores } from "@/lib/scoring";
import type { Award, ResultOverrides } from "@/lib/scoring";
import { createClient } from "@/lib/supabase/server";
import type { Question, RubricPoint } from "@/lib/types";
import LocalDateTime from "@/components/LocalDateTime";
import PointOverride from "@/components/PointOverride";
import { sortResultRows } from "@/components/ResultsTable";
import ReviewFooter from "@/components/ReviewFooter";
import Alert from "@/components/ui/Alert";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";

interface ResultFlag {
  question_id?: string;
  target?: string;
  reason: string;
  note?: string;
  detail?: string;
}

interface Segment {
  found: boolean;
  start_quote: string | null;
  page: number | null;
  text: string;
}

const FLAG_LABELS: Record<string, string> = {
  illegible: "Illegible",
  missing: "Missing answer",
  ambiguous: "Ambiguous",
  unusual_method: "Unusual method",
  instruction_in_answer: "Instruction in answer",
  other: "Other",
};

function flagLabel(reason: string): string {
  return FLAG_LABELS[reason] ?? reason;
}

function flagText(flag: ResultFlag): string {
  return flag.note ?? flag.detail ?? "";
}

function flagTarget(flag: ResultFlag): string | null {
  return flag.question_id ?? flag.target ?? null;
}

export default async function ResultReviewPage({
  params,
}: {
  params: Promise<{ id: string; submissionId: string }>;
}) {
  await requireRole("lecturer");
  const { id, submissionId } = await params;
  const supabase = await createClient();
  const { data: assessment } = await supabase
    .from("assessments")
    .select("id, title, answer_mode")
    .eq("id", id)
    .single();
  if (!assessment) notFound();
  const a = assessment as {
    id: string;
    title: string;
    answer_mode: "typed" | "pdf";
  };
  const { data: submission } = await supabase
    .from("submissions")
    .select("id, assessment_id, student_id, script_path")
    .eq("id", submissionId)
    .single();
  if (!submission) notFound();
  const sub = submission as {
    id: string;
    assessment_id: string;
    student_id: string;
    script_path: string | null;
  };
  if (sub.assessment_id !== a.id) notFound();
  const { data: resultRows } = await supabase
    .from("results")
    .select("*")
    .eq("submission_id", submissionId)
    .limit(1);
  const result = (resultRows ?? [])[0] as
    | {
        status: "marked" | "needs_review" | "incomplete";
        scores: Record<string, { marks: number; max: number; comment: string }>;
        awards: Award[];
        flags: ResultFlag[];
        segments: Record<string, Segment>;
        overrides: ResultOverrides | null;
        approved: boolean;
        published: boolean;
        marked_at: string | null;
      }
    | undefined;
  if (!result) notFound();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, matric_number")
    .eq("id", sub.student_id)
    .single();
  const student = (profile ?? {}) as {
    full_name?: string;
    matric_number?: string | null;
  };
  const { data: questions } = await supabase
    .from("questions")
    .select("*")
    .eq("assessment_id", id)
    .order("position");
  const questionList = (questions ?? []) as Question[];
  const { data: rubricRows } = await supabase
    .from("rubrics")
    .select("points")
    .eq("assessment_id", id)
    .limit(1);
  const saved = (rubricRows ?? [])[0] as { points?: unknown } | undefined;
  const points: RubricPoint[] = Array.isArray(saved?.points)
    ? (saved.points as RubricPoint[])
    : [];
  const { data: answerRows } = await supabase
    .from("answers")
    .select("question_id, text")
    .eq("submission_id", submissionId);
  const answerByQuestion = new Map(
    ((answerRows ?? []) as { question_id: string; text: string }[]).map(
      (row) => [row.question_id, row.text],
    ),
  );

  const awards = Array.isArray(result.awards) ? result.awards : [];
  const flags = Array.isArray(result.flags) ? result.flags : [];
  const scores = result.scores ?? {};
  const segments = result.segments ?? {};
  const overrides = result.overrides ?? {};
  const effective = effectiveScores(questionList, points, awards, overrides);
  const aiTotal = Object.values(effective.perQuestion).reduce(
    (t, s) => t + s.ai,
    0,
  );
  const awardByPoint = new Map(awards.map((aw) => [aw.point_id, aw]));
  const pointById = new Map(points.map((p) => [p.id, p]));
  const codes = new Set(questionList.map((q) => q.code));

  let scriptUrl: string | null = null;
  if (a.answer_mode === "pdf" && sub.script_path) {
    const { data: signed } = await supabase.storage
      .from("answer-pdfs")
      .createSignedUrl(sub.script_path, 600);
    scriptUrl = signed?.signedUrl ?? null;
  }

  const { data: allSubs } = await supabase
    .from("submissions")
    .select("id, student_id")
    .eq("assessment_id", id)
    .eq("status", "submitted");
  const allSubmitted = ((allSubs ?? []) as {
    id: string;
    student_id: string;
  }[]);
  const { data: allResults } = await supabase
    .from("results")
    .select("submission_id, status")
    .in(
      "submission_id",
      allSubmitted.map((s) => s.id),
    );
  const statusBySub = new Map(
    ((allResults ?? []) as { submission_id: string; status: string }[]).map(
      (r) => [r.submission_id, r.status],
    ),
  );
  const { data: allProfiles } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in(
      "id",
      [...new Set(allSubmitted.map((s) => s.student_id))],
    );
  const nameById = new Map(
    ((allProfiles ?? []) as { id: string; full_name: string }[]).map((p) => [
      p.id,
      p.full_name,
    ]),
  );
  const ordered = sortResultRows(
    allSubmitted.map((s) => ({
      submissionId: s.id,
      studentName: nameById.get(s.student_id) ?? "Unknown student",
      matric: null,
      status: (statusBySub.get(s.id) ?? null) as
        | "marked"
        | "needs_review"
        | "incomplete"
        | null,
      total: null,
      max: null,
      flags: 0,
      markedAt: null,
      edited: false,
      approved: false,
      published: false,
    })),
  );
  const position = ordered.findIndex((row) => row.submissionId === submissionId);
  const prevHref =
    position > 0
      ? `/lecturer/assessments/${id}/results/${ordered[position - 1].submissionId}`
      : null;
  const nextHref =
    position >= 0 && position + 1 < ordered.length
      ? `/lecturer/assessments/${id}/results/${ordered[position + 1].submissionId}`
      : null;

  function questionOfTarget(target: string | null): string | null {
    if (!target) return null;
    if (codes.has(target)) return target;
    const point = pointById.get(target);
    return point?.question_id ?? null;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <a
          href={`/lecturer/assessments/${id}`}
          className="font-medium text-indigo-600 hover:underline"
        >
          ← Back to assessment
        </a>
      </p>
      <Card>
        <div className="space-y-3">
          <h1 className="text-xl font-semibold text-slate-900">
            {student.full_name ?? "Unknown student"}
            {student.matric_number && (
              <span className="ml-2 font-mono text-base font-normal text-slate-600">
                Matric: {student.matric_number}
              </span>
            )}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            {result.status === "marked" && (
              <Badge tone="success">Marked</Badge>
            )}
            {result.status === "needs_review" && (
              <Badge tone="warning">Needs review</Badge>
            )}
            {result.status === "incomplete" && (
              <Badge tone="danger">Incomplete</Badge>
            )}
            {result.approved ? (
              <Badge tone="success">Approved</Badge>
            ) : (
              <Badge tone="neutral">Not approved</Badge>
            )}
            {result.published && <Badge tone="info">Published</Badge>}
          </div>
          <p className="text-sm text-slate-700">
            <span className="font-medium">
              {effective.total} / {effective.max}
            </span>
            {aiTotal !== effective.total && (
              <span className="text-slate-500"> (AI: {aiTotal})</span>
            )}
            {" · "}marked <LocalDateTime value={result.marked_at} />
          </p>
          {scriptUrl && (
            <p className="text-sm">
              <a
                href={scriptUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-indigo-600 hover:underline"
              >
                View script
              </a>
            </p>
          )}
        </div>
      </Card>

      {flags.length > 0 && (
        <Alert>
          {flags.map((flag, i) => {
            const code = questionOfTarget(flagTarget(flag));
            return (
              <span key={i}>
                {i > 0 && <br />}
                <span className="font-medium">{flagLabel(flag.reason)}</span>
                {flagText(flag) && <>: {flagText(flag)}</>}
                {code && (
                  <>
                    {" — "}
                    <a
                      href={`#question-${code}`}
                      className="font-medium underline"
                    >
                      {code.toUpperCase()}
                    </a>
                  </>
                )}
              </span>
            );
          })}
        </Alert>
      )}

      {questionList.map((q) => {
        const per = effective.perQuestion[q.code];
        const comment = scores[q.code]?.comment;
        const segment = segments[q.code];
        const answerText =
          a.answer_mode === "pdf" ? (segment?.text ?? "") : (
            (answerByQuestion.get(q.id) ?? "")
          );
        const found =
          a.answer_mode === "pdf" ? (segment?.found ?? false) : true;
        const qpoints = points.filter((p) => p.question_id === q.code);
        const quotes = qpoints.flatMap((p) => {
          const award = awardByPoint.get(p.id);
          return award && award.marks > 0 && award.quote.trim()
            ? [award.quote]
            : [];
        });
        return (
          <div
            key={q.id}
            id={`question-${q.code}`}
            className="scroll-mt-4"
          >
            <Card
              title={`${q.code.toUpperCase()} · ${per.final} / ${per.max} marks`}
            >
              <div className="space-y-3">
                <p className="whitespace-pre-wrap text-sm text-slate-700">
                  {q.prompt}
                </p>
                {per.ai !== per.final && (
                  <p className="text-sm text-slate-500">
                    AI score: {per.ai} / {per.max}
                  </p>
                )}
                {comment && (
                  <p className="text-sm text-slate-600">
                    <span className="font-medium text-slate-700">
                      AI comment:{" "}
                    </span>
                    {comment}
                  </p>
                )}
                {a.answer_mode === "pdf" && segment?.found && (
                  <p className="text-xs text-slate-500">
                    Found on page {segment.page}
                  </p>
                )}
                <div className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3">
                  {!found || !answerText.trim() ? (
                    <p className="text-sm text-slate-500 italic">
                      {a.answer_mode === "pdf" && !found
                        ? "This answer wasn&apos;t found in the script."
                        : "No answer submitted."}
                    </p>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-slate-800">
                      {highlightQuotes(answerText, quotes)}
                    </p>
                  )}
                </div>
                <ul className="divide-y divide-slate-200">
                  {qpoints.map((p) => {
                    const award = awardByPoint.get(p.id);
                    const ai = award?.marks ?? 0;
                    const savedMarks = overrides.points?.[p.id];
                    const pointEffective =
                      savedMarks && typeof savedMarks.marks === "number"
                        ? savedMarks.marks
                        : ai;
                    return (
                      <li key={p.id} className="space-y-1.5 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm text-slate-800">
                            {p.description}
                          </p>
                          <p className="shrink-0 text-sm font-medium text-slate-900">
                            {pointEffective} / {p.max_marks}
                          </p>
                        </div>
                        {award && award.quote.trim() && (
                          <p className="text-sm text-slate-700 italic">
                            &ldquo;{award.quote}&rdquo;
                          </p>
                        )}
                        {award && (
                          <p className="text-sm text-slate-600">
                            <span className="font-medium text-slate-700">
                              AI reason:{" "}
                            </span>
                            {award.reason}
                          </p>
                        )}
                        {savedMarks && (
                          <p className="text-sm text-slate-700">
                            Changed from {ai} to {savedMarks.marks}:{" "}
                            {savedMarks.note}
                          </p>
                        )}
                        <PointOverride
                          submissionId={submissionId}
                          pointId={p.id}
                          aiMarks={ai}
                          pointMax={p.max_marks}
                          override={
                            savedMarks
                              ? { marks: savedMarks.marks, note: savedMarks.note }
                              : null
                          }
                          published={result.published}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            </Card>
          </div>
        );
      })}

      <ReviewFooter
        submissionId={submissionId}
        approved={result.approved}
        published={result.published}
        prevHref={prevHref}
        nextHref={nextHref}
      />
    </div>
  );
}
