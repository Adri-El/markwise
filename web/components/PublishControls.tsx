"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { publishResults, unpublishResults } from "@/lib/actions/results";
import Button from "./ui/Button";
import FieldError from "./ui/FieldError";

export default function PublishControls({
  assessmentId,
  publishable,
  published,
}: {
  assessmentId: string;
  publishable: number;
  published: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"publish" | "unpublish" | null>(null);
  const [error, setError] = useState("");

  async function onPublish() {
    if (!window.confirm("Students will see their marks and comments."))
      return;
    setError("");
    setBusy("publish");
    try {
      const result = await publishResults(assessmentId);
      if (!result.ok) {
        setError(result.error ?? "Could not publish.");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function onUnpublish() {
    if (
      !window.confirm(
        "Students will no longer see their results. Unpublish everything?",
      )
    )
      return;
    setError("");
    setBusy("unpublish");
    try {
      const result = await unpublishResults(assessmentId);
      if (!result.ok) {
        setError(result.error ?? "Could not unpublish.");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          loading={busy === "publish"}
          disabled={publishable === 0}
          onClick={() => onPublish()}
        >
          Publish approved results ({publishable})
        </Button>
        <Button
          variant="secondary"
          loading={busy === "unpublish"}
          disabled={published === 0}
          onClick={() => onUnpublish()}
        >
          Unpublish all
        </Button>
      </div>
      <FieldError message={error} />
    </div>
  );
}
