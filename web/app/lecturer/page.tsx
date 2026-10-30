import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { Assessment } from "@/lib/types";
import SignOutButton from "@/components/SignOutButton";

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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Your assessments</h1>
        <SignOutButton />
      </div>
      <p>
        <a
          href="/lecturer/assessments/new"
          className="bg-neutral-900 text-white text-sm rounded px-4 py-2 inline-block"
        >
          New assessment
        </a>
      </p>
      {assessments.length === 0 ? (
        <p className="text-neutral-700 text-sm">
          Nothing here yet. Create your first assessment above.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 border-y border-neutral-200">
          {assessments.map((a) => (
            <li
              key={a.id}
              className="py-3 flex items-center justify-between gap-4"
            >
              <div>
                <a
                  href={`/lecturer/assessments/${a.id}`}
                  className="font-medium underline"
                >
                  {a.title}
                </a>
                <p className="text-sm text-neutral-600">
                  {a.kind} · code {a.join_code}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
