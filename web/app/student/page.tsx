import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Assessment } from "@/lib/types";
import JoinCodeForm from "@/components/JoinCodeForm";
import SignOutButton from "@/components/SignOutButton";

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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Your assessments</h1>
        <SignOutButton />
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Join with a code</h2>
        <JoinCodeForm />
      </div>
      {assessments.length === 0 ? (
        <p className="text-neutral-700 text-sm">
          You haven&apos;t joined anything yet.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 border-y border-neutral-200">
          {assessments.map((a) => (
            <li key={a.id} className="py-3">
              <p className="font-medium">{a.title}</p>
              <p className="text-sm text-neutral-600">{a.kind}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
