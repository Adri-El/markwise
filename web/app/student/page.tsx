import { requireRole } from "@/lib/auth";
import type { ResultFinal } from "@/lib/scoring";
import { createClient } from "@/lib/supabase/server";
import { isPast } from "@/lib/schedule";
import type { Assessment, Submission } from "@/lib/types";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import JoinCodeForm from "@/components/JoinCodeForm";
import LocalDateTime from "@/components/LocalDateTime";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function isOpen(a: Assessment, now: number): boolean {
  const opened = a.opens_at === null || new Date(a.opens_at).getTime() <= now;
  const notClosed =
    a.closes_at === null || new Date(a.closes_at).getTime() >= now;
  return opened && notClosed;
}

function isClosed(a: Assessment): boolean {
  return a.closes_at !== null && isPast(a.closes_at);
}

export default async function StudentDashboard() {
  const profile = await requireRole("student");
  const supabase = await createClient();
  const { data } = await supabase
    .from("enrollments")
    .select(
      "assessment:assessments(id, title, kind, opens_at, closes_at, answer_mode)",
    )
    .eq("student_id", profile.id);
  const assessments = ((data ?? []) as unknown as {
    assessment: Assessment | Assessment[];
  }[]).map((row) =>
    Array.isArray(row.assessment) ? row.assessment[0] : row.assessment,
  );
  const { data: submissions } = await supabase
    .from("submissions")
    .select("id, assessment_id, status")
    .eq("student_id", profile.id);
  const submissionList = ((submissions ?? []) as Pick<
    Submission,
    "id" | "assessment_id" | "status"
  >[]);
  const statusByAssessment = new Map(
    submissionList.map((s) => [s.assessment_id, s.status]),
  );
  const assessmentBySubmission = new Map(
    submissionList.map((s) => [s.id, s.assessment_id]),
  );
  const finalByAssessment = new Map<string, ResultFinal>();
  if (submissionList.length > 0) {
    const { data: results } = await supabase
      .from("results")
      .select("submission_id, final")
      .in(
        "submission_id",
        submissionList.map((s) => s.id),
      );
    for (const row of (results ?? []) as {
      submission_id: string;
      final: unknown;
    }[]) {
      const assessmentId = assessmentBySubmission.get(row.submission_id);
      if (
        assessmentId &&
        row.final !== null &&
        typeof row.final === "object"
      ) {
        finalByAssessment.set(assessmentId, row.final as ResultFinal);
      }
    }
  }
  const lecturerNames = await Promise.all(
    assessments.map(async (a) => {
      const { data } = await supabase.rpc("lecturer_name", {
        p_assessment_id: a.id,
      });
      const name =
        typeof data === "string" && data.trim() !== "" ? data : null;
      return [a.id, name] as const;
    }),
  );
  const lecturerByAssessment = new Map(lecturerNames);
  const now = Date.now();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-900">Your assessments</h1>
      <Card title="Join with a code">
        <JoinCodeForm />
      </Card>
      {assessments.length === 0 ? (
        <p className="text-sm text-slate-600">
          You haven&apos;t joined anything yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {assessments.map((a) => {
            const submitted =
              statusByAssessment.get(a.id) === "submitted";
            const published = finalByAssessment.get(a.id);
            return (
              <Card key={a.id}>
                <div className="space-y-2">
                  <a
                    href={`/student/assessments/${a.id}`}
                    className="font-medium text-indigo-600 hover:underline"
                  >
                    {a.title}
                  </a>
                  {lecturerByAssessment.get(a.id) && (
                    <p className="text-sm text-slate-600">
                      Set by {lecturerByAssessment.get(a.id)}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="info">{capitalize(a.kind)}</Badge>
                    {submitted && (
                      <Badge tone="success">Submitted</Badge>
                    )}
                    {published && (
                      <Badge tone="success">
                        Result: {published.total}/{published.max}
                      </Badge>
                    )}
                  </div>
                  {!submitted &&
                    (isClosed(a) ? (
                      <p className="text-sm text-slate-600">
                        Closed – not submitted
                      </p>
                    ) : isOpen(a, now) ? (
                      <p className="text-sm text-slate-600">
                        Due <LocalDateTime value={a.closes_at} />
                      </p>
                    ) : (
                      <p className="text-sm text-slate-600">
                        Opens <LocalDateTime value={a.opens_at} />
                      </p>
                    ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
