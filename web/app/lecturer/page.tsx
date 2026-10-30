import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Assessment } from "@/lib/types";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import CopyButton from "@/components/CopyButton";
import LocalDateTime from "@/components/LocalDateTime";
import StatusBadge from "@/components/StatusBadge";

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export default async function LecturerDashboard() {
  const profile = await requireRole("lecturer");
  const supabase = await createClient();
  const { data } = await supabase
    .from("assessments")
    .select("id, title, kind, join_code, opens_at, closes_at, created_at")
    .eq("lecturer_id", profile.id)
    .order("created_at", { ascending: false });
  const assessments = (data ?? []) as Assessment[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-slate-900">
          Your assessments
        </h1>
        <Button href="/lecturer/assessments/new">New assessment</Button>
      </div>
      {assessments.length === 0 ? (
        <Card title="Nothing here yet">
          <p className="text-sm text-slate-600">
            Create your first assessment to get a join code for your students.
          </p>
          <div className="mt-4">
            <Button href="/lecturer/assessments/new">New assessment</Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {assessments.map((a) => (
            <Card key={a.id}>
              <div className="space-y-2">
                <a
                  href={`/lecturer/assessments/${a.id}`}
                  className="font-medium text-indigo-600 hover:underline"
                >
                  {a.title}
                </a>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="info">{capitalize(a.kind)}</Badge>
                  <StatusBadge opensAt={a.opens_at} closesAt={a.closes_at} />
                </div>
                <p className="text-sm text-slate-600">
                  {a.kind === "assignment" ? "Due " : "Closes "}
                  <LocalDateTime value={a.closes_at} />
                </p>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-slate-100 px-2 py-1 font-mono text-sm text-slate-900">
                    {a.join_code}
                  </code>
                  <CopyButton text={a.join_code} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
