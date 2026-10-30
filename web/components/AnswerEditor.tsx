"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { saveDraft, submitWork } from "@/lib/actions/submissions";
import { MAX_ANSWER_CHARS, type AnswerMode } from "@/lib/types";
import Button from "./ui/Button";
import Card from "./ui/Card";
import FieldError from "./ui/FieldError";
import Label from "./ui/Label";
import LocalDateTime from "./LocalDateTime";
import Textarea from "./ui/Textarea";

const MAX_PDF_BYTES = 10_485_760; // 10 MB, matches the answer-pdfs bucket

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
}: {
  assessmentId: string;
  studentId: string;
  answerMode: AnswerMode;
  questions: EditorQuestion[];
  initial: Record<string, DraftAnswer>;
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>(initial);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingQ, setUploadingQ] = useState<string | null>(null);

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

  async function onPdfChange(
    questionId: string,
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setQuestionErrors((prev) => ({ ...prev, [questionId]: "" }));
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError(`${file.name}: only PDF files are allowed.`);
      return;
    }
    if (file.size <= 0 || file.size > MAX_PDF_BYTES) {
      setError(`${file.name}: file must be between 1 byte and 10 MB.`);
      return;
    }
    setUploadingQ(questionId);
    try {
      const supabase = createClient();
      const path = `${assessmentId}/${studentId}/${questionId}.pdf`;
      const { error: uploadError } = await supabase.storage
        .from("answer-pdfs")
        .upload(path, file, { upsert: true });
      if (uploadError) {
        setError("Upload failed. Try again.");
        return;
      }
      setDraft(questionId, { text: "", pdfPath: path });
      const saved = await saveDraft({
        assessmentId,
        answers: questions.map((q) => ({
          questionId: q.id,
          text: q.id === questionId ? "" : draftFor(q.id).text,
          pdfPath: q.id === questionId ? path : draftFor(q.id).pdfPath,
        })),
      });
      if (!saved.ok) {
        setQuestionErrors((prev) => ({
          ...prev,
          [questionId]: saved.error ?? "Could not save the draft.",
        }));
      } else {
        setSavedAt(new Date().toISOString());
      }
    } finally {
      setUploadingQ(null);
    }
  }

  async function onSubmit() {
    setError("");
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

  return (
    <div className="space-y-4">
      {questions.map((q) => {
        const draft = draftFor(q.id);
        return (
          <Card key={q.id} title={`${q.code} · ${q.max_marks} marks`}>
            <div className="space-y-3">
              <p className="whitespace-pre-wrap text-sm text-slate-700">
                {q.prompt}
              </p>
              {answerMode === "typed" ? (
                <div>
                  <Label htmlFor={`answer-${q.id}`}>Your answer</Label>
                  <Textarea
                    id={`answer-${q.id}`}
                    value={draft.text}
                    maxLength={MAX_ANSWER_CHARS}
                    rows={6}
                    onChange={(e) =>
                      setDraft(q.id, { text: e.target.value })
                    }
                  />
                  <p className="mt-1 text-xs text-slate-600">
                    {draft.text.length} / {MAX_ANSWER_CHARS} characters
                  </p>
                </div>
              ) : (
                <div>
                  <Label htmlFor={`answer-pdf-${q.id}`}>
                    {draft.pdfPath ? "Replace PDF" : "Upload PDF"}
                  </Label>
                  {draft.pdfPath && (
                    <p className="mb-1 text-sm font-medium text-slate-900">
                      PDF uploaded
                    </p>
                  )}
                  <input
                    id={`answer-pdf-${q.id}`}
                    type="file"
                    accept=".pdf,application/pdf"
                    disabled={uploadingQ === q.id}
                    onChange={(e) => onPdfChange(q.id, e)}
                    className="block w-full text-sm text-slate-700 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-slate-300 file:bg-white file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-900 hover:file:bg-slate-50 disabled:opacity-50"
                  />
                  {uploadingQ === q.id && (
                    <p className="mt-1 text-sm text-slate-600">Uploading…</p>
                  )}
                </div>
              )}
              <FieldError message={questionErrors[q.id]} />
            </div>
          </Card>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" loading={saving} onClick={onSave}>
          Save draft
        </Button>
        <Button loading={submitting} onClick={onSubmit}>
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
