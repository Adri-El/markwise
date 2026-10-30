"use client";

import { useState } from "react";
import Button from "./ui/Button";

export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <Button type="button" variant="secondary" onClick={copy}>
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
