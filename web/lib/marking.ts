import type { createClient } from "./supabase/server";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

// Marking has started once any script has a results row, or a mark_all
// job is still queued or working. A finished job alone doesn't count:
// extending the deadline after marking stays allowed.
export async function markingStarted(
  supabase: ServerClient,
  assessmentId: string,
): Promise<boolean> {
  const { data: jobs } = await supabase
    .from("marking_jobs")
    .select("id")
    .eq("assessment_id", assessmentId)
    .eq("type", "mark_all")
    .in("status", ["queued", "working"])
    .limit(1);
  if ((jobs ?? []).length > 0) return true;
  const { data: subs } = await supabase
    .from("submissions")
    .select("id")
    .eq("assessment_id", assessmentId)
    .eq("status", "submitted");
  const ids = ((subs ?? []) as { id: string }[]).map((s) => s.id);
  if (ids.length === 0) return false;
  const { data: results } = await supabase
    .from("results")
    .select("submission_id")
    .in("submission_id", ids)
    .limit(1);
  return (results ?? []).length > 0;
}
