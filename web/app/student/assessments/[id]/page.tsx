import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { isPast } from "@/lib/schedule";
import type { Answer, Assessment, Question, Submission } from "@/lib/types";
import AnswerEditor from "@/components/AnswerEditor";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import LocalDateTime from "@/components/LocalDateTime";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function ReadonlyAnswers({
  questions,
  answersByQuestion,
}: {
  questions: Question[];
  answersByQuestion: Map<string, Answer>;
}) {
  return (
    <div className="space-y-4">
      {questions.map((q) => {
        const answer = answersByQuestion.get(q.id);
        return (
          <Card key={q.id} title={`${q.code} · ${q.max_marks} marks`}>
            <div className="space-y-2">
              <p className="whitespace-pre-wrap text-sm text-slate-700">
                {q.prompt}
              </p>
              {answer && answer.text.trim() !== "" ? (
                <p className="whitespace-pre-wrap text-sm text-slate-900">
                  {answer.text}
                </p>
              ) : (
                <p className="text-sm text-slate-500">No answer.</p>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function ScriptLink({ url }: { url: string | null }) {
  return (
    <Card title="Your script">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-indigo-600 hover:underline"
        >
          View your script
        </a>
      ) : (
        <p className="text-sm text-slate-500">
          The script link expired. Reload the page.
        </p>
      )}
    </Card>
  );
}

export default async function StudentAssessmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await requireRole("student");
  const { id } = await params;
  const supabase = await createClient();
  const { data: assessment } = await supabase
    .from("assessments")
    .select("*")
    .eq("id", id)
    .single();
  if (!assessment) notFound();
  const a = assessment as Assessment;
  const { data: enrollment } = await supabase
    .from("enrollments")
    .select("assessment_id")
    .eq("assessment_id", id)
    .eq("student_id", profile.id)
    .single();
  if (!enrollment) notFound();

  const now = Date.now();
  const opened =
    a.opens_at === null || new Date(a.opens_at).getTime() <= now;
  const closed = a.closes_at !== null && isPast(a.closes_at);

  let { data: submissionRow } = await supabase
    .from("submissions")
    .select("*")
    .eq("assessment_id", id)
    .eq("student_id", profile.id)
    .single();
  if (!submissionRow && opened && !closed) {
    const { data: inserted, error: insertError } = await supabase
      .from("submissions")
      .insert({ assessment_id: id, student_id: profile.id })
      .select("*")
      .single();
    if (insertError) {
      // Unique violation: the row appeared concurrently; re-select it.
      const { data: reselected } = await supabase
        .from("submissions")
        .select("*")
        .eq("assessment_id", id)
        .eq("student_id", profile.id)
        .single();
      submissionRow = reselected;
    } else {
      submissionRow = inserted;
    }
  }
  const submission = submissionRow as Submission | null;
  const submitted = submission?.status === "submitted";

  let questionList: Question[] = [];
  if (opened) {
    const { data: questions } = await supabase
      .from("questions")
      .select("*")
      .eq("assessment_id", id)
      .order("position");
    questionList = (questions ?? []) as Question[];
  }
  let answerList: Answer[] = [];
  if (submission) {
    const { data: answers } = await supabase
      .from("answers")
      .select("*")
      .eq("submission_id", submission.id);
    answerList = (answers ?? []) as Answer[];
  }
  const answersByQuestion = new Map(answerList.map((x) => [x.question_id, x]));

  const isPdf = a.answer_mode === "pdf";
  const scriptAttached = !!submission?.script_path;
  let scriptUploadedAt: string | null = null;
  let scriptUrl: string | null = null;
  if (isPdf && submission?.script_path) {
    const { data: files } = await supabase.storage
      .from("answer-pdfs")
      .list(`${id}/${profile.id}`);
    scriptUploadedAt =
      (files ?? []).find((f) => f.name === "script.pdf")?.updated_at ?? null;
    if (submitted || closed) {
      const { data } = await supabase.storage
        .from("answer-pdfs")
        .createSignedUrl(submission.script_path, 600);
      scriptUrl = data?.signedUrl ?? null;
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <a
          href="/student"
          className="font-medium text-indigo-600 hover:underline"
        >
          ← All assessments
        </a>
      </p>
      <Card>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-slate-900">{a.title}</h1>
          <div className="flex flex-wrap gap-2">
            <Badge tone="info">{capitalize(a.kind)}</Badge>
            {submitted && <Badge tone="success">Submitted</Badge>}
          </div>
          {a.instructions && (
            <p className="whitespace-pre-wrap text-sm text-slate-700">
              {a.instructions}
            </p>
          )}
        </div>
      </Card>

      {submitted ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Submitted <LocalDateTime value={submission.submitted_at} />
          </p>
          {isPdf ? (
            <ScriptLink url={scriptUrl} />
          ) : (
            <ReadonlyAnswers
              questions={questionList}
              answersByQuestion={answersByQuestion}
            />
          )}
        </div>
      ) : !opened ? (
        <Card title="Not open yet">
          <p className="text-sm text-slate-600">
            This {a.kind} opens <LocalDateTime value={a.opens_at} />.
          </p>
        </Card>
      ) : closed ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            This assessment closed on <LocalDateTime value={a.closes_at} />.
            No submission was made.
          </p>
          {isPdf ? (
            scriptAttached && <ScriptLink url={scriptUrl} />
          ) : (
            answerList.length > 0 && (
              <ReadonlyAnswers
                questions={questionList}
                answersByQuestion={answersByQuestion}
              />
            )
          )}
        </div>
      ) : submission ? (
        <AnswerEditor
          assessmentId={id}
          studentId={profile.id}
          answerMode={a.answer_mode}
          questions={questionList.map((q) => ({
            id: q.id,
            code: q.code,
            prompt: q.prompt,
            max_marks: q.max_marks,
          }))}
          initial={Object.fromEntries(
            questionList.map((q) => [
              q.id,
              {
                text: answersByQuestion.get(q.id)?.text ?? "",
                pdfPath: answersByQuestion.get(q.id)?.pdf_path ?? null,
              },
            ]),
          )}
          scriptAttached={scriptAttached}
          scriptUploadedAt={scriptUploadedAt}
        />
      ) : (
        <Card title="Something went wrong">
          <p className="text-sm text-slate-600">
            Could not open your submission. Reload the page and try again.
          </p>
        </Card>
      )}
    </div>
  );
}
