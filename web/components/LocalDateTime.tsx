"use client";

import { useEffect, useState } from "react";

// Renders in the viewer's local time zone. Formatted after mount so the
// server HTML never disagrees with the client's time zone (no hydration gap).
export default function LocalDateTime({ value }: { value: string | null }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(value ? new Date(value).toLocaleString() : "—");
  }, [value]);
  return <>{text ?? "—"}</>;
}
