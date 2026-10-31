"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { approveResult, unapproveResult } from "@/lib/actions/results";
import Button from "./ui/Button";
import FieldError from "./ui/FieldError";

export default function ReviewFooter({
  submissionId,
  approved,
  published,
  prevHref,
  nextHref,
}: {
  submissionId: string;
  approved: boolean;
  published: boolean;
  prevHref: string | null;
  nextHref: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "approve-next" | null>(null);
  const [error, setError] = useState("");

  async function run(
    kind: "approve" | "approve-next",
    action: () => Promise<{ ok: boolean; error?: string }>,
    then?: () => void,
  ) {
    setError("");
    setBusy(kind);
    try {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
      } else if (then) {
        then();
      } else {
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {prevHref && (
          <Button variant="secondary" href={prevHref}>
            ← Previous
          </Button>
        )}
        {approved ? (
          <Button
            variant="secondary"
            loading={busy === "approve"}
            disabled={published}
            onClick={() => run("approve", () => unapproveResult(submissionId))}
          >
            Unapprove
          </Button>
        ) : (
          <Button
            loading={busy === "approve"}
            onClick={() => run("approve", () => approveResult(submissionId))}
          >
            Approve
          </Button>
        )}
        {nextHref &&
          (approved ? (
            <Button variant="secondary" href={nextHref}>
              Next →
            </Button>
          ) : (
            <Button
              variant="secondary"
              loading={busy === "approve-next"}
              onClick={() =>
                run("approve-next", () => approveResult(submissionId), () =>
                  router.push(nextHref),
                )
              }
            >
              Approve and next
            </Button>
          ))}
      </div>
      <FieldError message={error} />
    </div>
  );
}
