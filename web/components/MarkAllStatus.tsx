"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { queueMarkAll } from "@/lib/actions/marking";
import { createClient } from "@/lib/supabase/client";
import type { MarkingJob } from "@/lib/types";
import Alert from "./ui/Alert";
import Button from "./ui/Button";
import FieldError from "./ui/FieldError";

const POLL_MS = 3000;
const QUEUED_HINT_MS = 30_000;
const STILL_OPEN_CONFIRM =
  "This assessment is still open. Scripts submitted later can be marked with another run.";

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export default function MarkAllStatus({
  assessmentId,
  initialJob,
  rubricApproved,
  submitted,
  marked,
  waiting,
  closesAt,
}: {
  assessmentId: string;
  initialJob: MarkingJob | null;
  rubricApproved: boolean;
  submitted: number;
  marked: number;
  waiting: number;
  closesAt: string | null;
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
    if (
      closesAt !== null &&
      new Date(closesAt).getTime() > Date.now() &&
      !window.confirm(STILL_OPEN_CONFIRM)
    )
      return;
    setError("");
    setBusy(true);
    try {
      const result = await queueMarkAll(assessmentId);
      if (!result.ok) {
        setError(result.error ?? "Could not start marking.");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  if (active && job) {
    const progress = job.progress ?? {};
    const done = progress.done ?? 0;
    const total = progress.total ?? 0;
    const needsReview = progress.needs_review ?? 0;
    const incomplete = progress.incomplete ?? 0;
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
          {done} of {total} marked · {needsReview} need review ·{" "}
          {incomplete} incomplete
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
      </div>
    );
  }

  if (job?.status === "error") {
    return (
      <div className="space-y-2">
        <Alert>{job.error ?? "Marking failed."}</Alert>
        <div>
          <Button variant="secondary" loading={busy} onClick={() => onQueue()}>
            Try again
          </Button>
        </div>
        <FieldError message={error} />
      </div>
    );
  }

  if (job?.status === "done") {
    const progress = job.progress ?? {};
    const done = progress.done ?? 0;
    const needsReview = progress.needs_review ?? 0;
    const incomplete = progress.incomplete ?? 0;
    return (
      <div className="space-y-1.5">
        <p className="flex items-center gap-3 text-sm text-slate-700">
          {done - needsReview - incomplete} marked · {needsReview} need
          review · {incomplete} incomplete
          {waiting > 0 && (
            <Button variant="secondary" loading={busy} onClick={() => onQueue()}>
              Mark new submissions ({waiting})
            </Button>
          )}
        </p>
        <FieldError message={error} />
      </div>
    );
  }

  const blockReason = !rubricApproved
    ? "Approve the rubric first."
    : waiting === 0
      ? "No new submissions to mark."
      : null;
  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-3 text-sm text-slate-700">
        {marked > 0 ? `${marked} marked` : "Not started"}
        <Button
          loading={busy}
          disabled={blockReason !== null}
          onClick={() => onQueue()}
        >
          Mark all
        </Button>
        {blockReason && (
          <span className="text-xs text-slate-500">{blockReason}</span>
        )}
      </p>
      <FieldError message={error} />
    </div>
  );
}
