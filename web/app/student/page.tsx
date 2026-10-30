import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Assessment } from "@/lib/types";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import JoinCodeForm from "@/components/JoinCodeForm";
import LocalDateTime from "@/components/LocalDateTime";
import StatusBadge from "@/components/StatusBadge";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export default async function StudentDashboard() {
  const profile = await requireRole("student");
  const supabase = await createClient();
  const { data } = await supabase
    .from("enrollments")
    .select("assessment:assessments(id, title, kind, opens_at, closes_at)")
    .eq("student_id", profile.id);
  const assessments = ((data ?? []) as unknown as {
    assessment: Assessment | Assessment[];
  }[]).map((row) =>
    Array.isArray(row.assessment) ? row.assessment[0] : row.assessment,
  );

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
          {assessments.map((a) => (
            <Card key={a.id}>
              <div className="space-y-2">
                <p className="font-medium text-slate-900">{a.title}</p>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="info">{capitalize(a.kind)}</Badge>
                  <StatusBadge opensAt={a.opens_at} closesAt={a.closes_at} />
                </div>
                <p className="text-sm text-slate-600">
                  {a.kind === "assignment" ? "Due " : "Closes "}
                  <LocalDateTime value={a.closes_at} />
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
