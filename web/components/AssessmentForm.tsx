"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createAssessment,
  type QuestionInput,
} from "@/lib/actions/assessments";
import type { AnswerMode, AssessmentKind } from "@/lib/types";

const input =
  "w-full border border-neutral-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-neutral-600";
const label = "block text-sm font-medium mb-1";

const PAST_GRACE_MS = 60_000;

interface FormSubpart {
  id: string;
  maxMarks: string;
}

interface FormQuestion {
  prompt: string;
  maxMarks: string;
  scheme: string;
  subparts: FormSubpart[];
}

const blankQuestion = (): FormQuestion => ({
  prompt: "",
  maxMarks: "5",
  scheme: "",
  subparts: [],
});

function validMarks(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value > 0 &&
    Math.abs(value * 2 - Math.round(value * 2)) < 1e-9
  );
}

function inPast(value: string): boolean {
  return new Date(value).getTime() < Date.now() - PAST_GRACE_MS;
}

function toIso(local: string): string {
  return new Date(local).toISOString();
}

export default function AssessmentForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<AssessmentKind>("assignment");
  const [instructions, setInstructions] = useState("");
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [answerMode, setAnswerMode] = useState<AnswerMode>("typed");
  const [referenceNote, setReferenceNote] = useState("");
  const [questions, setQuestions] = useState<FormQuestion[]>([blankQuestion()]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  function updateQuestion(index: number, patch: Partial<FormQuestion>) {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  function validateSchedule(): { opens: string | null; closes: string | null } | string {
    if (kind === "assignment") {
      if (!closesAt) return "A due date and time is required.";
      if (inPast(closesAt)) return "Due must not be in the past.";
      return { opens: null, closes: toIso(closesAt) };
    }
    if (!opensAt || !closesAt) return "Opens and Closes are both required.";
    if (inPast(opensAt)) return "Opens must not be in the past.";
    if (inPast(closesAt)) return "Closes must not be in the past.";
    if (new Date(closesAt).getTime() <= new Date(opensAt).getTime())
      return "Closes must be after Opens.";
    return { opens: toIso(opensAt), closes: toIso(closesAt) };
  }

  function validateQuestions(): QuestionInput[] | string {
    const parsed: QuestionInput[] = [];
    for (const [i, q] of questions.entries()) {
      const n = i + 1;
      if (!q.prompt.trim()) return `Question ${n}: prompt is required.`;
      const maxMarks = Number(q.maxMarks);
      if (q.maxMarks.trim() === "" || !validMarks(maxMarks))
        return `Question ${n}: max marks must be a positive multiple of 0.5.`;
      if (!q.scheme.trim())
        return `Question ${n}: marking scheme is required.`;
      const subparts: QuestionInput["subparts"] = [];
      for (const s of q.subparts) {
        if (!/^[a-z]$/.test(s.id))
          return `Question ${n}: sub-part ids must be single lowercase letters (a, b, c…).`;
        const subMax = Number(s.maxMarks);
        if (s.maxMarks.trim() === "" || !validMarks(subMax))
          return `Question ${n}: each sub-part max must be a positive multiple of 0.5.`;
        subparts.push({ id: s.id, maxMarks: subMax });
      }
      const ids = subparts.map((s) => s.id);
      if (new Set(ids).size !== ids.length)
        return `Question ${n}: sub-part ids must be unique.`;
      if (subparts.length > 0) {
        const sum = subparts.reduce((total, s) => total + s.maxMarks, 0);
        if (Math.abs(sum - maxMarks) > 1e-9)
          return `Question ${n}: sub-part marks must sum exactly to the question max (${maxMarks}).`;
      }
      parsed.push({ prompt: q.prompt, maxMarks, scheme: q.scheme, subparts });
    }
    return parsed;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    const schedule = validateSchedule();
    if (typeof schedule === "string") {
      setError(schedule);
      return;
    }
    const parsed = validateQuestions();
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    setPending(true);
    try {
      const result = await createAssessment({
        title,
        kind,
        instructions,
        opensAt: schedule.opens,
        closesAt: schedule.closes,
        answerMode,
        referenceNote,
        questions: parsed,
      });
      if (!result.ok || !result.id) {
        setError(result.error ?? "Something went wrong.");
      } else {
        router.push(`/lecturer/assessments/${result.id}`);
      }
    } finally {
      setPending(false);
    }
  }

  function onKindChange(next: AssessmentKind) {
    setKind(next);
    if (next === "assignment") setOpensAt("");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-2xl">
      <div>
        <label htmlFor="assessment-title" className={label}>
          Title
        </label>
        <input
          id="assessment-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={input}
        />
      </div>
      <div className="flex gap-6 flex-wrap">
        <div>
          <label htmlFor="assessment-kind" className={label}>
            Kind
          </label>
          <select
            id="assessment-kind"
            value={kind}
            onChange={(e) => onKindChange(e.target.value as AssessmentKind)}
            className="border border-neutral-300 rounded px-3 py-2 text-sm"
          >
            <option value="assignment">Assignment</option>
            <option value="test">Test</option>
            <option value="exam">Exam</option>
          </select>
        </div>
        <div>
          <span className={label} id="answer-mode-label">
            Answer mode
          </span>
          <div
            role="radiogroup"
            aria-labelledby="answer-mode-label"
            className="flex gap-4 text-sm py-2"
          >
            {(["typed", "pdf"] as AnswerMode[]).map((mode) => (
              <label
                key={mode}
                htmlFor={`answer-mode-${mode}`}
                className="flex items-center gap-2"
              >
                <input
                  id={`answer-mode-${mode}`}
                  type="radio"
                  name="answerMode"
                  value={mode}
                  checked={answerMode === mode}
                  onChange={() => setAnswerMode(mode)}
                />
                {mode === "typed" ? "Typed" : "PDF"}
              </label>
            ))}
          </div>
        </div>
        {kind === "assignment" ? (
          <div>
            <label htmlFor="assessment-due" className={label}>
              Due
            </label>
            <input
              id="assessment-due"
              type="datetime-local"
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
              className="border border-neutral-300 rounded px-3 py-2 text-sm"
            />
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="assessment-opens" className={label}>
                Opens
              </label>
              <input
                id="assessment-opens"
                type="datetime-local"
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
                className="border border-neutral-300 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="assessment-closes" className={label}>
                Closes
              </label>
              <input
                id="assessment-closes"
                type="datetime-local"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
                className="border border-neutral-300 rounded px-3 py-2 text-sm"
              />
            </div>
          </>
        )}
      </div>
      <div>
        <label htmlFor="assessment-instructions" className={label}>
          Instructions for students
        </label>
        <textarea
          id="assessment-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={3}
          className={input}
        />
      </div>
      <div>
        <label htmlFor="assessment-reference-note" className={label}>
          Reference note (lecturers only)
        </label>
        <textarea
          id="assessment-reference-note"
          value={referenceNote}
          onChange={(e) => setReferenceNote(e.target.value)}
          rows={2}
          className={input}
        />
      </div>

      {questions.map((q, i) => (
        <fieldset
          key={i}
          className="border border-neutral-200 rounded p-4 space-y-3"
        >
          <legend className="text-sm font-semibold px-1">
            Question {i + 1}
          </legend>
          <div>
            <label htmlFor={`q-${i}-prompt`} className={label}>
              Prompt
            </label>
            <textarea
              id={`q-${i}-prompt`}
              value={q.prompt}
              onChange={(e) => updateQuestion(i, { prompt: e.target.value })}
              rows={2}
              className={input}
            />
          </div>
          <div className="flex gap-4 items-end">
            <div>
              <label htmlFor={`q-${i}-max`} className={label}>
                Max marks
              </label>
              <input
                id={`q-${i}-max`}
                type="number"
                min="0.5"
                step="0.5"
                value={q.maxMarks}
                onChange={(e) => updateQuestion(i, { maxMarks: e.target.value })}
                className="border border-neutral-300 rounded px-3 py-2 text-sm w-24"
              />
            </div>
            {questions.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setQuestions((qs) => qs.filter((_, j) => j !== i))
                }
                className="text-sm text-red-700 pb-2"
              >
                Remove
              </button>
            )}
          </div>
          <div>
            <label htmlFor={`q-${i}-scheme`} className={label}>
              Marking scheme (lecturers only)
            </label>
            <textarea
              id={`q-${i}-scheme`}
              value={q.scheme}
              onChange={(e) => updateQuestion(i, { scheme: e.target.value })}
              rows={3}
              className={input}
            />
          </div>
          <div>
            <span className={label}>Sub-parts (optional)</span>
            {q.subparts.map((s, si) => (
              <div key={si} className="flex gap-2 mb-2 items-end">
                <div>
                  <label htmlFor={`q-${i}-sub-${si}-id`} className="sr-only">
                    Sub-part {si + 1} id
                  </label>
                  <input
                    id={`q-${i}-sub-${si}-id`}
                    placeholder="id, e.g. a"
                    value={s.id}
                    onChange={(e) => {
                      const subparts = q.subparts.map((x, xi) =>
                        xi === si ? { ...x, id: e.target.value } : x,
                      );
                      updateQuestion(i, { subparts });
                    }}
                    className="border border-neutral-300 rounded px-3 py-2 text-sm w-32"
                  />
                </div>
                <div>
                  <label htmlFor={`q-${i}-sub-${si}-max`} className="sr-only">
                    Sub-part {si + 1} max marks
                  </label>
                  <input
                    id={`q-${i}-sub-${si}-max`}
                    type="number"
                    min="0.5"
                    step="0.5"
                    placeholder="max"
                    value={s.maxMarks}
                    onChange={(e) => {
                      const subparts = q.subparts.map((x, xi) =>
                        xi === si ? { ...x, maxMarks: e.target.value } : x,
                      );
                      updateQuestion(i, { subparts });
                    }}
                    className="border border-neutral-300 rounded px-3 py-2 text-sm w-24"
                  />
                </div>
                <button
                  type="button"
                  onClick={() =>
                    updateQuestion(i, {
                      subparts: q.subparts.filter((_, xi) => xi !== si),
                    })
                  }
                  className="text-sm text-red-700 pb-2"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                updateQuestion(i, {
                  subparts: [
                    ...q.subparts,
                    {
                      id: String.fromCharCode(97 + q.subparts.length),
                      maxMarks: "1",
                    },
                  ],
                })
              }
              className="text-sm underline"
            >
              Add sub-part
            </button>
          </div>
        </fieldset>
      ))}
      <div className="flex gap-4 items-center">
        <button
          type="button"
          onClick={() => setQuestions((qs) => [...qs, blankQuestion()])}
          className="text-sm underline"
        >
          Add question
        </button>
        <button
          type="submit"
          disabled={pending}
          className="bg-neutral-900 text-white text-sm rounded px-4 py-2 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Create assessment"}
        </button>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}
