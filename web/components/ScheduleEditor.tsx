"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateSchedule } from "@/lib/actions/assessments";
import { isoToLocal, localToIso } from "@/lib/schedule";
import type { AssessmentKind } from "@/lib/types";
import Button from "./ui/Button";
import FieldError from "./ui/FieldError";
import Input from "./ui/Input";
import Label from "./ui/Label";
import LocalDateTime from "./LocalDateTime";

const QUICK_SHIFTS = [
  { label: "+30 min", ms: 30 * 60_000 },
  { label: "+1 hour", ms: 60 * 60_000 },
  { label: "+1 day", ms: 24 * 60 * 60_000 },
];

export default function ScheduleEditor({
  assessmentId,
  kind,
  opensAt,
  closesAt,
}: {
  assessmentId: string;
  kind: AssessmentKind;
  opensAt: string | null;
  closesAt: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [opens, setOpens] = useState(opensAt ? isoToLocal(opensAt) : "");
  const [closes, setCloses] = useState(closesAt ? isoToLocal(closesAt) : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const alreadyOpen =
    kind !== "assignment" &&
    opensAt !== null &&
    new Date(opensAt).getTime() < Date.now();
  const dueLabel = kind === "assignment" ? "Due" : "Closes";

  if (!open) {
    return (
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Edit schedule
        </Button>
      </div>
    );
  }

  function shiftDue(ms: number) {
    const current = new Date(closes).getTime();
    const base =
      Number.isNaN(current) || current < Date.now() ? Date.now() : current;
    setCloses(isoToLocal(new Date(base + ms).toISOString()));
  }

  async function onSave() {
    setError("");
    if (!closes) {
      setError(
        kind === "assignment"
          ? "A due date and time is required."
          : "Opens and Closes are both required.",
      );
      return;
    }
    let opensIso: string | null = null;
    if (kind !== "assignment") {
      if (!alreadyOpen && !opens) {
        setError("Opens and Closes are both required.");
        return;
      }
      opensIso = alreadyOpen && opensAt ? opensAt : localToIso(opens);
    }
    setSaving(true);
    try {
      const result = await updateSchedule({
        assessmentId,
        opensAt: opensIso,
        closesAt: localToIso(closes),
      });
      if (!result.ok) {
        setError(result.error ?? "Could not save the schedule.");
      } else {
        setOpen(false);
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  function onCancel() {
    setOpen(false);
    setError("");
    setOpens(opensAt ? isoToLocal(opensAt) : "");
    setCloses(closesAt ? isoToLocal(closesAt) : "");
  }

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4">
      {kind !== "assignment" && (
        <div>
          <Label htmlFor="schedule-opens">Opens</Label>
          {alreadyOpen ? (
            <p className="text-sm text-slate-700">
              <LocalDateTime value={opensAt} /> (already open)
            </p>
          ) : (
            <Input
              id="schedule-opens"
              type="datetime-local"
              value={opens}
              onChange={(e) => setOpens(e.target.value)}
            />
          )}
        </div>
      )}
      <div>
        <Label htmlFor="schedule-closes">{dueLabel}</Label>
        <Input
          id="schedule-closes"
          type="datetime-local"
          value={closes}
          onChange={(e) => setCloses(e.target.value)}
        />
        <div className="mt-2 flex gap-2">
          {QUICK_SHIFTS.map((shift) => (
            <Button
              key={shift.label}
              type="button"
              variant="secondary"
              onClick={() => shiftDue(shift.ms)}
            >
              {shift.label}
            </Button>
          ))}
        </div>
      </div>
      <FieldError message={error} />
      <div className="flex gap-2">
        <Button loading={saving} onClick={onSave}>
          Save
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
