"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  attachScript,
  saveDraft,
  setSubmissionDepartment,
  submitWork,
} from "@/lib/actions/submissions";
import { MAX_ANSWER_CHARS, type AnswerMode } from "@/lib/types";
import Button from "./ui/Button";
import Card from "./ui/Card";
import FieldError from "./ui/FieldError";
import Label from "./ui/Label";
import LocalDateTime from "./LocalDateTime";
import Select from "./ui/Select";
import Textarea from "./ui/Textarea";

const MAX_SCRIPT_BYTES = 26_214_400; // 25 MB, matches the answer-pdfs bucket

interface DraftAnswer {
  text: string;
  pdfPath: string | null;
}

interface EditorQuestion {
  id: string;
  code: string;
  prompt: string;
  max_marks: number;
}

export default function AnswerEditor({
  assessmentId,
  studentId,
  answerMode,
  questions,
  initial,
  scriptAttached,
  scriptUploadedAt,
  departments,
  savedDepartment,
}: {
  assessmentId: string;
  studentId: string;
  answerMode: AnswerMode;
  questions: EditorQuestion[];
  initial: Record<string, DraftAnswer>;
  scriptAttached: boolean;
  scriptUploadedAt: string | null;
  departments: string[];
  savedDepartment: string | null;
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>(initial);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [hasScript, setHasScript] = useState(scriptAttached);
  const [scriptAt, setScriptAt] = useState<string | null>(scriptUploadedAt);
  const [uploadingScript, setUploadingScript] = useState(false);
  const [scriptError, setScriptError] = useState("");
  const [department, setDepartment] = useState(savedDepartment ?? "");
  const [savingDepartment, setSavingDepartment] = useState(false);

  async function onDepartmentChange(value: string) {
    if (value === "") return;
    setError("");
    setSavingDepartment(true);
    try {
      const result = await setSubmissionDepartment(assessmentId, value);
      if (!result.ok) {
        setError(result.error ?? "Could not save your department.");
        return;
      }
      setDepartment(value);
    } finally {
      setSavingDepartment(false);
    }
  }

  const departmentPicker = (
    <Card title="Department">
      <div className="max-w-xs">
        <Label htmlFor="department">Department</Label>
        <Select
          id="department"
          value={department}
          disabled={savingDepartment}
          onChange={(e) => onDepartmentChange(e.target.value)}
        >
          <option value="">Select your department</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        {savingDepartment && (
          <p className="mt-1 text-sm text-slate-600">Saving…</p>
        )}
      </div>
    </Card>
  );

  function departmentChosen(): boolean {
    if (department !== "") return true;
    setError("Select your department before submitting.");
    return false;
  }

  function draftFor(questionId: string): DraftAnswer {
    return drafts[questionId] ?? { text: "", pdfPath: null };
  }

  function setDraft(questionId: string, patch: Partial<DraftAnswer>) {
    setDrafts((prev) => ({
      ...prev,
      [questionId]: { ...draftFor(questionId), ...patch },
    }));
  }

  async function persist(): Promise<boolean> {
    const result = await saveDraft({
      assessmentId,
      answers: questions.map((q) => ({
        questionId: q.id,
        text: draftFor(q.id).text,
        pdfPath: draftFor(q.id).pdfPath,
      })),
    });
    if (!result.ok) {
      setError(result.error ?? "Could not save the draft.");
      return false;
    }
    setSavedAt(new Date().toISOString());
    return true;
  }

  async function onSave() {
    setError("");
    setSaving(true);
    try {
      await persist();
    } finally {
      setSaving(false);
    }
  }

  async function onScriptChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setScriptError("");
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setScriptError(`${file.name}: only PDF files are allowed.`);
      return;
    }
    if (file.size <= 0 || file.size > MAX_SCRIPT_BYTES) {
      setScriptError(`${file.name}: file must be between 1 byte and 25 MB.`);
      return;
    }
    setUploadingScript(true);
    try {
      const supabase = createClient();
      const { error: uploadError } = await supabase.storage
        .from("answer-pdfs")
        .upload(`${assessmentId}/${studentId}/script.pdf`, file, {
          upsert: true,
        });
      if (uploadError) {
        setScriptError("Upload failed. Try again.");
        return;
      }
      const attached = await attachScript(assessmentId);
      if (!attached.ok) {
        setScriptError(attached.error ?? "Could not save the script.");
        return;
      }
      setHasScript(true);
      setScriptAt(new Date().toISOString());
    } finally {
      setUploadingScript(false);
    }
  }

  async function onSubmit() {
    setError("");
    if (!departmentChosen()) return;
    setSubmitting(true);
    try {
      if (!(await persist())) return;
      const blank = questions.filter((q) => {
        const d = draftFor(q.id);
        return answerMode === "pdf" ? !d.pdfPath : d.text.trim() === "";
      }).length;
      const confirmed = window.confirm(
        blank > 0
          ? `${blank} question${blank === 1 ? " is" : "s are"} blank. ` +
              "You can't change answers after submitting. Submit anyway?"
          : "You can't change answers after submitting. Submit?",
      );
      if (!confirmed) return;
      const result = await submitWork(assessmentId);
      if (!result.ok) {
        setError(result.error ?? "Could not submit.");
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitPdf() {
    setError("");
    if (!departmentChosen()) return;
    if (!hasScript) {
      setError("Upload your answer script (PDF) before submitting.");
      return;
    }
    const confirmed = window.confirm(
      "You can't change your script after submitting. Submit?",
    );
    if (!confirmed) return;
    setSubmitting(true);
    try {
      const result = await submitWork(assessmentId);
      if (!result.ok) {
        setError(result.error ?? "Could not submit.");
        return;
      }
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (answerMode === "pdf") {
    return (
      <div className="space-y-4">
        {departmentPicker}
        {questions.map((q) => (
          <Card key={q.id} title={`${q.code} · ${q.max_marks} marks`}>
            <p className="whitespace-pre-wrap text-sm text-slate-700">
              {q.prompt}
            </p>
          </Card>
        ))}
        <Card
          title="Your answer script"
          subtitle="Upload one PDF with your answers to all questions. Label each answer with its question number (Q1, Q2, …)."
        >
          <div className="space-y-3">
            {hasScript && (
              <p className="text-sm font-medium text-slate-900">
                Script uploaded{" "}
                {scriptAt ? <LocalDateTime value={scriptAt} /> : null}
              </p>
            )}
            <div>
              <Label htmlFor="answer-script">
                {hasScript ? "Replace script" : "Upload script"}
              </Label>
              <input
                id="answer-script"
                type="file"
                accept=".pdf,application/pdf"
                disabled={uploadingScript}
                onChange={onScriptChange}
                className="block w-full text-sm text-slate-700 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-slate-300 file:bg-white file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-900 hover:file:bg-slate-50 disabled:opacity-50"
              />
              {uploadingScript && (
                <p className="mt-1 text-sm text-slate-600">Uploading…</p>
              )}
            </div>
            <FieldError message={scriptError} />
          </div>
        </Card>
        <FieldError message={error} />
        <div>
          <Button
            loading={submitting}
            disabled={department === ""}
            onClick={onSubmitPdf}
          >
            Submit
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {departmentPicker}
      {questions.map((q) => {
        const draft = draftFor(q.id);
        return (
          <Card key={q.id} title={`${q.code} · ${q.max_marks} marks`}>
            <div className="space-y-3">
              <p className="whitespace-pre-wrap text-sm text-slate-700">
                {q.prompt}
              </p>
              <div>
                <Label htmlFor={`answer-${q.id}`}>Your answer</Label>
                <Textarea
                  id={`answer-${q.id}`}
                  value={draft.text}
                  maxLength={MAX_ANSWER_CHARS}
                  rows={6}
                  onChange={(e) => setDraft(q.id, { text: e.target.value })}
                />
                <p className="mt-1 text-xs text-slate-600">
                  {draft.text.length} / {MAX_ANSWER_CHARS} characters
                </p>
              </div>
            </div>
          </Card>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" loading={saving} onClick={onSave}>
          Save draft
        </Button>
        <Button
          loading={submitting}
          disabled={department === ""}
          onClick={onSubmit}
        >
          Submit
        </Button>
        {savedAt && (
          <p className="text-sm text-slate-600">
            Saved <LocalDateTime value={savedAt} />
          </p>
        )}
      </div>
      <FieldError message={error} />
    </div>
  );
}
