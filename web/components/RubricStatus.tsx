"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { queueRubricDraft } from "@/lib/actions/rubric";
import { createClient } from "@/lib/supabase/client";
import type { MarkingJob } from "@/lib/types";
import Alert from "./ui/Alert";
import Badge from "./ui/Badge";
import Button from "./ui/Button";
import FieldError from "./ui/FieldError";

const POLL_MS = 3000;
const QUEUED_HINT_MS = 30_000;
const REDRAFT_CONFIRM =
  "This replaces the current draft and clears any approval.";

function stageLabel(job: MarkingJob): string {
  const progress = job.progress ?? {};
  if (progress.stage === "reading_notes") return "Reading notes";
  if (progress.stage === "drafting")
    return `Drafting points: ${progress.points ?? 0} so far`;
  if (progress.stage === "saving") return "Saving";
  return job.status === "queued" ? "Queued" : "Working";
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function Notices({ job }: { job: MarkingJob }) {
  const warnings = job.progress?.warnings ?? [];
  const unreadable = job.progress?.unreadable_pages ?? [];
  if (warnings.length === 0 && unreadable.length === 0) return null;
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-800">
      {warnings.map((warning, i) => (
        <li key={`warning-${i}`}>{warning}</li>
      ))}
      {unreadable.map((page, i) => (
        <li key={`unreadable-${i}`}>
          No readable text: {page.file}, p. {page.page}
        </li>
      ))}
    </ul>
  );
}

export default function RubricStatus({
  assessmentId,
  initialJob,
  pointsCount,
  approved,
  canDraft,
  draftBlockReason,
}: {
  assessmentId: string;
  initialJob: MarkingJob | null;
  pointsCount: number;
  approved: boolean;
  canDraft: boolean;
  draftBlockReason: string | null;
}) {
  const router = useRouter();
  const [job, setJob] = useState<MarkingJob | null>(initialJob);
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setJob(initialJob);
  }, [initialJob?.id, initialJob?.updated_at]);

  const active =
    job !== null && (job.status === "queued" || job.status === "working");

  useEffect(() => {
    if (!active || !job) return;
    const jobId = job.id;
    const supabase = createClient();
    const timer = setInterval(async () => {
      const { data } = await supabase
        .from("marking_jobs")
        .select("*")
        .eq("id", jobId)
        .single();
      if (!data) return;
      const next = data as MarkingJob;
      if (next.status === "done" || next.status === "error") {
        clearInterval(timer);
        router.refresh();
      } else {
        setJob(next);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, job?.id, router]);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  async function onQueue() {
    setError("");
    setBusy(true);
    try {
      const result = await queueRubricDraft(assessmentId);
      if (!result.ok) {
        setError(result.error ?? "Could not queue the draft.");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  function onRedraft() {
    if (!window.confirm(REDRAFT_CONFIRM)) return;
    void onQueue();
  }

  if (active && job) {
    const queuedTooLong =
      job.status === "queued" &&
      now !== null &&
      now - new Date(job.created_at).getTime() > QUEUED_HINT_MS;
    return (
      <div className="space-y-1.5">
        <p className="flex items-center gap-2 text-sm text-slate-700">
          <span
            aria-hidden
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600"
          />
          {stageLabel(job)}
          {now !== null && (
            <span className="text-slate-500">
              · {formatElapsed(now - new Date(job.created_at).getTime())}{" "}
              elapsed
            </span>
          )}
        </p>
        {queuedTooLong && (
          <p className="text-xs text-slate-600">
            Waiting for the marking worker to start.
          </p>
        )}
        <Notices job={job} />
      </div>
    );
  }

  if (job?.status === "error") {
    return (
      <div className="space-y-2">
        <Alert>{job.error ?? "The draft failed."}</Alert>
        <div>
          <Button variant="secondary" loading={busy} onClick={() => onQueue()}>
            Try again
          </Button>
        </div>
        <Notices job={job} />
        <FieldError message={error} />
      </div>
    );
  }

  if (approved) {
    return (
      <div className="space-y-1.5">
        <p className="flex items-center gap-3 text-sm text-slate-700">
          <Badge tone="success">Approved</Badge>
          <Button variant="secondary" loading={busy} onClick={onRedraft}>
            Redraft
          </Button>
        </p>
        {job && <Notices job={job} />}
        <FieldError message={error} />
      </div>
    );
  }

  if (pointsCount > 0) {
    return (
      <div className="space-y-1.5">
        <p className="flex items-center gap-3 text-sm text-slate-700">
          {pointsCount} point{pointsCount === 1 ? "" : "s"} drafted, not yet
          approved
          <Button variant="secondary" loading={busy} onClick={onRedraft}>
            Redraft
          </Button>
        </p>
        {job && <Notices job={job} />}
        <FieldError message={error} />
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-3 text-sm text-slate-700">
        Not drafted
        <Button loading={busy} disabled={!canDraft} onClick={() => onQueue()}>
          Draft rubric
        </Button>
        {!canDraft && draftBlockReason && (
          <span className="text-xs text-slate-500">{draftBlockReason}</span>
        )}
      </p>
      <FieldError message={error} />
    </div>
  );
}
