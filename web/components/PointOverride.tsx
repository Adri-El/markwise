"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearPointOverride,
  setPointOverride,
} from "@/lib/actions/results";
import Button from "./ui/Button";
import FieldError from "./ui/FieldError";
import Input from "./ui/Input";
import Label from "./ui/Label";
import Textarea from "./ui/Textarea";

export default function PointOverride({
  submissionId,
  pointId,
  aiMarks,
  pointMax,
  override,
  published,
}: {
  submissionId: string;
  pointId: string;
  aiMarks: number;
  pointMax: number;
  override: { marks: number; note: string } | null;
  published: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [marks, setMarks] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function validMarks(value: number): boolean {
    return (
      Number.isFinite(value) &&
      value >= 0 &&
      value <= pointMax &&
      Math.abs(value * 2 - Math.round(value * 2)) < 1e-9
    );
  }

  async function onSave() {
    const value = marks.trim() === "" ? NaN : Number(marks);
    if (!validMarks(value)) {
      setError(`Marks must be a multiple of 0.5 between 0 and ${pointMax}.`);
      return;
    }
    if (!note.trim()) {
      setError("Add a short note explaining the change.");
      return;
    }
    if (note.length > 300) {
      setError("Keep the note under 300 characters.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const result = await setPointOverride(
        submissionId,
        pointId,
        value,
        note,
      );
      if (!result.ok) {
        setError(result.error ?? "Could not save the change.");
      } else {
        setOpen(false);
        setMarks("");
        setNote("");
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function onUndo() {
    setError("");
    setBusy(true);
    try {
      const result = await clearPointOverride(submissionId, pointId);
      if (!result.ok) {
        setError(result.error ?? "Could not undo the change.");
      } else {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  function onOpen() {
    setError("");
    setMarks(String(override?.marks ?? aiMarks));
    setNote(override?.note ?? "");
    setOpen(true);
  }

  if (open) {
    return (
      <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-start gap-3">
          <div className="w-24 shrink-0">
            <Label htmlFor={`ov-marks-${pointId}`}>Marks</Label>
            <Input
              id={`ov-marks-${pointId}`}
              type="number"
              step="0.5"
              value={marks}
              onChange={(e) => setMarks(e.target.value)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Label htmlFor={`ov-note-${pointId}`}>Note</Label>
            <Textarea
              id={`ov-note-${pointId}`}
              rows={2}
              value={note}
              maxLength={300}
              placeholder="Why is the AI's mark wrong?"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <FieldError message={error} />
        <div className="flex gap-2">
          <Button loading={busy} onClick={() => onSave()}>
            Save
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              setError("");
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Button variant="ghost" disabled={published} onClick={onOpen}>
          Change
        </Button>
        {override && (
          <Button
            variant="ghost"
            loading={busy}
            disabled={published}
            onClick={() => onUndo()}
          >
            Undo
          </Button>
        )}
      </div>
      <FieldError message={error} />
    </div>
  );
}
