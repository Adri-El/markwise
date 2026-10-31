"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  approveRubric,
  saveRubric,
  unapproveRubric,
} from "@/lib/actions/rubric";
import { validateRubric } from "@/lib/rubric-validate";
import type { Question, RubricPoint } from "@/lib/types";
import RubricPreview from "./RubricPreview";
import Badge from "./ui/Badge";
import Button from "./ui/Button";
import Card from "./ui/Card";
import FieldError from "./ui/FieldError";
import Input from "./ui/Input";
import Label from "./ui/Label";
import Textarea from "./ui/Textarea";

const APPROVE_CONFIRM = "Marking will use this rubric exactly as approved.";
const EDIT_CONFIRM = "Editing removes approval until you approve again.";

interface DraftPoint {
  id: string;
  question_id: string;
  subpart?: string;
  description: string;
  marks: string;
  accept: string;
  reject: string;
  source: { quote: string; file: string; page: number; section?: string } | null;
  needs_lecturer: boolean;
  reason: string;
}

function stripPrefix(note: string): string {
  return note.replace(/^(Accept|Reject):\s*/, "");
}

function toDraft(points: RubricPoint[]): DraftPoint[] {
  return points.map((p) => ({
    id: p.id,
    question_id: p.question_id,
    subpart: p.subpart,
    description: p.description,
    marks: String(p.max_marks),
    accept: (p.accept ?? []).map(stripPrefix).join("\n"),
    reject: (p.reject ?? []).map(stripPrefix).join("\n"),
    source:
      p.source_quote != null &&
      p.source_file != null &&
      p.source_page != null
        ? {
            quote: p.source_quote,
            file: p.source_file,
            page: p.source_page,
            section: p.source_section,
          }
        : null,
    needs_lecturer: p.needs_lecturer === true,
    reason: p.reason ?? "",
  }));
}

function toPoints(draft: DraftPoint[]): RubricPoint[] {
  return draft.map((d) => {
    const accept = d.accept
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const reject = d.reject
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const point: RubricPoint = {
      id: d.id,
      question_id: d.question_id,
      description: d.description,
      max_marks: d.marks.trim() === "" ? NaN : Number(d.marks),
    };
    if (d.subpart !== undefined) point.subpart = d.subpart;
    if (accept.length > 0) point.accept = accept;
    if (reject.length > 0) point.reject = reject;
    if (d.source !== null) {
      point.source_quote = d.source.quote;
      point.source_file = d.source.file;
      point.source_page = d.source.page;
      if (d.source.section !== undefined)
        point.source_section = d.source.section;
    }
    if (d.needs_lecturer) {
      point.needs_lecturer = true;
      point.reason = d.reason;
    }
    return point;
  });
}

function parseMarks(marks: string): number {
  if (marks.trim() === "") return 0;
  const value = Number(marks);
  return Number.isFinite(value) ? value : 0;
}

export default function RubricEditor({
  assessmentId,
  questions,
  initialPoints,
  approved,
}: {
  assessmentId: string;
  questions: Question[];
  initialPoints: RubricPoint[];
  approved: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftPoint[]>(() =>
    toDraft(initialPoints),
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "approve" | "edit" | null>(null);
  const [error, setError] = useState("");

  const signature = JSON.stringify({ approved, points: initialPoints });
  useEffect(() => {
    setDraft(toDraft(initialPoints));
    setDirty(false);
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const points = useMemo(() => toPoints(draft), [draft]);
  const errors = useMemo(
    () => validateRubric(points, questions),
    [points, questions],
  );
  const unresolved = draft.some((p) => p.needs_lecturer);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function updatePoint(id: string, patch: Partial<DraftPoint>) {
    setDraft((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    );
    setDirty(true);
  }

  function deletePoint(id: string) {
    setDraft((prev) => prev.filter((p) => p.id !== id));
    setDirty(true);
  }

  function addPoint(code: string) {
    setDraft((prev) => {
      const numbers = prev.map((p) => {
        const match = /^p(\d+)$/.exec(p.id);
        return match ? Number(match[1]) : 0;
      });
      const next = Math.max(0, ...numbers) + 1;
      return [
        ...prev,
        {
          id: `p${next}`,
          question_id: code,
          description: "",
          marks: "1",
          accept: "",
          reject: "",
          source: null,
          needs_lecturer: false,
          reason: "",
        },
      ];
    });
    setDirty(true);
  }

  async function onSave(): Promise<boolean> {
    setError("");
    setBusy("save");
    try {
      const result = await saveRubric(assessmentId, toPoints(draft));
      if (!result.ok) {
        setError(result.error ?? "Could not save the rubric.");
        return false;
      }
      setDirty(false);
      router.refresh();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function onApprove() {
    if (!window.confirm(APPROVE_CONFIRM)) return;
    const saved = await onSave();
    if (!saved) return;
    setBusy("approve");
    try {
      const result = await approveRubric(assessmentId);
      if (!result.ok) {
        setError(result.error ?? "Could not approve the rubric.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function onEdit() {
    if (!window.confirm(EDIT_CONFIRM)) return;
    setError("");
    setBusy("edit");
    try {
      const result = await unapproveRubric(assessmentId);
      if (!result.ok) {
        setError(result.error ?? "Could not edit the rubric.");
        return;
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (approved) {
    return (
      <div className="space-y-4">
        <RubricPreview questions={questions} points={initialPoints} />
        <div>
          <Button
            variant="secondary"
            loading={busy === "edit"}
            onClick={() => onEdit()}
          >
            Edit rubric
          </Button>
        </div>
        <FieldError message={error} />
      </div>
    );
  }

  const byCode = new Map<string, DraftPoint[]>();
  for (const point of draft) {
    const list = byCode.get(point.question_id) ?? [];
    list.push(point);
    byCode.set(point.question_id, list);
  }

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-slate-900">Rubric draft</h2>
      {errors.length > 0 && (
        <div className="space-y-1">
          {errors.map((message, i) => (
            <FieldError key={i} message={message} />
          ))}
        </div>
      )}
      {questions.map((q) => {
        const list = byCode.get(q.code) ?? [];
        const sum = list.reduce((total, p) => total + parseMarks(p.marks), 0);
        return (
          <Card key={q.id} title={`${q.code} · ${sum} / ${q.max_marks} marks`}>
            <p className="whitespace-pre-wrap text-sm text-slate-700">
              {q.prompt}
            </p>
            {sum < q.max_marks && (
              <p className="mt-1 text-sm font-medium text-red-700">
                Points must add up to at least {q.max_marks}.
              </p>
            )}
            {sum > q.max_marks && (
              <p className="mt-1 text-sm text-slate-500">
                Students can earn up to {q.max_marks}; extra points are
                alternatives (e.g. &apos;any 3 of&apos;).
              </p>
            )}
            <ul className="mt-2 divide-y divide-slate-200">
              {list.map((p) => (
                <li key={p.id} className="space-y-2 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <Label htmlFor={`desc-${p.id}`}>Point {p.id}</Label>
                      <Input
                        id={`desc-${p.id}`}
                        value={p.description}
                        placeholder="What earns the mark"
                        onChange={(e) =>
                          updatePoint(p.id, { description: e.target.value })
                        }
                      />
                    </div>
                    <div className="w-24 shrink-0">
                      <Label htmlFor={`marks-${p.id}`}>Marks</Label>
                      <Input
                        id={`marks-${p.id}`}
                        type="number"
                        step="0.5"
                        value={p.marks}
                        onChange={(e) =>
                          updatePoint(p.id, { marks: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  {p.needs_lecturer && (
                    <div className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50 p-3">
                      <Badge tone="warning">Needs your decision</Badge>
                      <p className="text-sm text-slate-700">{p.reason}</p>
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={false}
                          onChange={() =>
                            updatePoint(p.id, {
                              needs_lecturer: false,
                              reason: "",
                            })
                          }
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        I&apos;ve decided
                      </label>
                    </div>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor={`accept-${p.id}`}>Accept</Label>
                      <Textarea
                        id={`accept-${p.id}`}
                        rows={2}
                        value={p.accept}
                        placeholder="One per line"
                        onChange={(e) =>
                          updatePoint(p.id, { accept: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor={`reject-${p.id}`}>Reject</Label>
                      <Textarea
                        id={`reject-${p.id}`}
                        rows={2}
                        value={p.reject}
                        placeholder="One per line"
                        onChange={(e) =>
                          updatePoint(p.id, { reject: e.target.value })
                        }
                      />
                    </div>
                  </div>
                  {p.source && (
                    <div>
                      <p className="text-sm text-slate-700 italic">
                        &ldquo;{p.source.quote}&rdquo;
                      </p>
                      <p className="text-xs text-slate-500">
                        {p.source.file}, p. {p.source.page}
                      </p>
                    </div>
                  )}
                  <div>
                    <Button
                      variant="ghost"
                      onClick={() => deletePoint(p.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <Button variant="secondary" onClick={() => addPoint(q.code)}>
                Add point
              </Button>
            </div>
          </Card>
        );
      })}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          loading={busy === "save"}
          onClick={() => onSave()}
        >
          Save changes
        </Button>
        <Button
          loading={busy === "approve"}
          disabled={errors.length > 0 || unresolved}
          onClick={() => onApprove()}
        >
          Approve rubric
        </Button>
      </div>
      <FieldError message={error} />
    </div>
  );
}
