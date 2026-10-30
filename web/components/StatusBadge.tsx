"use client";

import { useEffect, useState } from "react";
import Badge from "./ui/Badge";

type Status = "Scheduled" | "Open" | "Closed";

// Computed after mount so server HTML never disagrees with client time.
export default function StatusBadge({
  opensAt,
  closesAt,
}: {
  opensAt: string | null;
  closesAt: string | null;
}) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    const now = Date.now();
    if (closesAt && new Date(closesAt).getTime() <= now) setStatus("Closed");
    else if (opensAt && new Date(opensAt).getTime() > now)
      setStatus("Scheduled");
    else setStatus("Open");
  }, [opensAt, closesAt]);

  if (!status) return <Badge tone="neutral">…</Badge>;
  const tone =
    status === "Open" ? "success" : status === "Scheduled" ? "warning" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}
