"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createAssessment,
  type QuestionInput,
} from "@/lib/actions/assessments";
import type { AnswerMode, AssessmentKind } from "@/lib/types";
import {
  MAX_NOTES_PER_ASSESSMENT,
  NOTE_ACCEPT,
  formatNoteSize,
  uploadNote,
  validateNoteFile,
} from "@/lib/notes-upload";
import { isPast, localToIso } from "@/lib/schedule";
import Button from "./ui/Button";
import Card from "./ui/Card";
import FieldError from "./ui/FieldError";
import Input from "./ui/Input";
import Label from "./ui/Label";
import Textarea from "./ui/Textarea";

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

function Segmented<T extends string>({
  label,
  group,
  options,
  value,
  onChange,
}: {
  label: string;
  group: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <span
        id={`${group}-label`}
        className="mb-1 block text-sm font-medium text-slate-700"
      >
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${group}-label`}
        className="inline-flex overflow-hidden rounded-md border border-slate-300 bg-white"
      >
        {options.map((option, i) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={
              `px-4 py-2 text-sm font-medium ` +
              `${i > 0 ? "border-l border-slate-300 " : ""}` +
              `${value === option.value ? "bg-indigo-600 text-white" : "text-slate-700 hover:bg-slate-50"}`
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
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
  const [noteFiles, setNoteFiles] = useState<File[]>([]);
  const [notesError, setNotesError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  function updateQuestion(index: number, patch: Partial<FormQuestion>) {
    setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  const parsedTotals = questions.map((q) => Number(q.maxMarks));
  const totalMarks =
    parsedTotals.every((m) => validMarks(m))
      ? parsedTotals.reduce((sum, m) => sum + m, 0)
      : null;

  function validateSchedule(): { opens: string | null; closes: string | null } | string {
    if (kind === "assignment") {
      if (!closesAt) return "A due date and time is required.";
      if (isPast(closesAt)) return "Due must not be in the past.";
      return { opens: null, closes: localToIso(closesAt) };
    }
    if (!opensAt || !closesAt) return "Opens and Closes are both required.";
    if (isPast(opensAt)) return "Opens must not be in the past.";
    if (isPast(closesAt)) return "Closes must not be in the past.";
    if (new Date(closesAt).getTime() <= new Date(opensAt).getTime())
      return "Closes must be after Opens.";
    return { opens: localToIso(opensAt), closes: localToIso(closesAt) };
  }

  function validateQuestions(): QuestionInput[] | string {
    const parsed: QuestionInput[] = [];
    for (const [i, q] of questions.entries()) {
      const n = i + 1;
      if (!q.prompt.trim()) return `Question ${n}: prompt is required.`;
      const maxMarks = Number(q.maxMarks);
      if (q.maxMarks.trim() === "" || !validMarks(maxMarks))
        return `Question ${n}: max marks must be a positive multiple of 0.5.`;
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
    let result;
    try {
      result = await createAssessment({
        title,
        kind,
        instructions,
        opensAt: schedule.opens,
        closesAt: schedule.closes,
        answerMode,
        referenceNote,
        questions: parsed,
      });
    } catch {
      setError("Something went wrong.");
      setPending(false);
      return;
    }
    if (!result.ok || !result.id) {
      setError(result.error ?? "Something went wrong.");
      setPending(false);
      return;
    }
    // From here on pending stays true until navigation: no second submit.
    if (noteFiles.length === 0) {
      router.push(`/lecturer/assessments/${result.id}`);
      return;
    }
    let failed = 0;
    for (const [i, file] of noteFiles.entries()) {
      setUploadProgress(`Uploading notes ${i + 1} of ${noteFiles.length}…`);
      try {
        const uploaded = await uploadNote(result.id, file);
        if (!uploaded.ok) failed += 1;
      } catch {
        failed += 1;
      }
    }
    setUploadProgress(null);
    router.push(
      failed > 0
        ? `/lecturer/assessments/${result.id}?notes_failed=${failed}`
        : `/lecturer/assessments/${result.id}`,
    );
  }

  function onKindChange(next: AssessmentKind) {
    setKind(next);
    if (next === "assignment") setOpensAt("");
  }

  // Picking files only stages them; nothing uploads until Create succeeds.
  function onNotesChange(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = "";
    setNotesError("");
    const kept: File[] = [...noteFiles];
    for (const file of picked) {
      const problem = validateNoteFile(file);
      if (problem) {
        setNotesError(`${file.name}: ${problem}`);
        break;
      }
      if (kept.length >= MAX_NOTES_PER_ASSESSMENT) {
        setNotesError("Maximum 10 files per assessment.");
        break;
      }
      kept.push(file);
    }
    setNoteFiles(kept);
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-6">
      <Card title="Details">
        <div className="space-y-4">
          <div>
            <Label htmlFor="assessment-title">Title</Label>
            <Input
              id="assessment-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <Segmented
            label="Kind"
            group="assessment-kind"
            value={kind}
            onChange={onKindChange}
            options={[
              { value: "assignment", label: "Assignment" },
              { value: "test", label: "Test" },
              { value: "exam", label: "Exam" },
            ]}
          />
          <div>
            <Label htmlFor="assessment-instructions">
              Instructions for students
            </Label>
            <Textarea
              id="assessment-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
            />
          </div>
        </div>
      </Card>

      <Card title="Schedule">
        {kind === "assignment" ? (
          <div className="max-w-xs">
            <Label htmlFor="assessment-due">Due</Label>
            <Input
              id="assessment-due"
              type="datetime-local"
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
            />
          </div>
        ) : (
          <div className="grid max-w-md grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="assessment-opens">Opens</Label>
              <Input
                id="assessment-opens"
                type="datetime-local"
                value={opensAt}
                onChange={(e) => setOpensAt(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="assessment-closes">Closes</Label>
              <Input
                id="assessment-closes"
                type="datetime-local"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
              />
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Answer format"
        subtitle="How students submit every question in this assessment."
      >
        <Segmented
          label="Format"
          group="answer-mode"
          value={answerMode}
          onChange={setAnswerMode}
          options={[
            { value: "typed", label: "Typed" },
            { value: "pdf", label: "PDF" },
          ]}
        />
        {answerMode === "pdf" && (
          <p className="mt-2 text-sm text-slate-600">
            Students upload one PDF containing all their answers.
          </p>
        )}
      </Card>

      <div className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Questions</h2>
        {questions.map((q, i) => (
          <Card
            key={i}
            title={`Question ${i + 1}`}
            actions={
              questions.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    setQuestions((qs) => qs.filter((_, j) => j !== i))
                  }
                >
                  Remove
                </Button>
              ) : undefined
            }
          >
            <div className="space-y-4">
              <div>
                <Label htmlFor={`q-${i}-prompt`}>Prompt</Label>
                <Textarea
                  id={`q-${i}-prompt`}
                  value={q.prompt}
                  onChange={(e) => updateQuestion(i, { prompt: e.target.value })}
                  rows={2}
                />
              </div>
              <div className="max-w-32">
                <Label htmlFor={`q-${i}-max`}>Max marks</Label>
                <Input
                  id={`q-${i}-max`}
                  type="number"
                  min="0.5"
                  step="0.5"
                  value={q.maxMarks}
                  onChange={(e) =>
                    updateQuestion(i, { maxMarks: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor={`q-${i}-scheme`}>
                  Marking scheme (optional, lecturers only)
                </Label>
                <Textarea
                  id={`q-${i}-scheme`}
                  value={q.scheme}
                  onChange={(e) => updateQuestion(i, { scheme: e.target.value })}
                  rows={3}
                />
                <p className="mt-1 text-sm text-slate-600">
                  Leave blank to draft this question&apos;s rubric from your
                  course notes. If given, it sets the points and mark split.
                </p>
              </div>
              <div>
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Sub-parts (optional)
                </span>
                {q.subparts.length > 0 && (
                  <table className="mb-2 w-full max-w-xs text-sm">
                    <thead>
                      <tr className="text-left text-slate-600">
                        <th className="py-1 pr-2 font-medium">Id</th>
                        <th className="py-1 pr-2 font-medium">Max marks</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.subparts.map((s, si) => (
                        <tr key={si}>
                          <td className="py-1 pr-2">
                            <label
                              htmlFor={`q-${i}-sub-${si}-id`}
                              className="sr-only"
                            >
                              Sub-part {si + 1} id
                            </label>
                            <Input
                              id={`q-${i}-sub-${si}-id`}
                              placeholder="a"
                              value={s.id}
                              onChange={(e) => {
                                const subparts = q.subparts.map((x, xi) =>
                                  xi === si
                                    ? { ...x, id: e.target.value }
                                    : x,
                                );
                                updateQuestion(i, { subparts });
                              }}
                            />
                          </td>
                          <td className="py-1 pr-2">
                            <label
                              htmlFor={`q-${i}-sub-${si}-max`}
                              className="sr-only"
                            >
                              Sub-part {si + 1} max marks
                            </label>
                            <Input
                              id={`q-${i}-sub-${si}-max`}
                              type="number"
                              min="0.5"
                              step="0.5"
                              placeholder="max"
                              value={s.maxMarks}
                              onChange={(e) => {
                                const subparts = q.subparts.map((x, xi) =>
                                  xi === si
                                    ? { ...x, maxMarks: e.target.value }
                                    : x,
                                );
                                updateQuestion(i, { subparts });
                              }}
                            />
                          </td>
                          <td className="py-1">
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() =>
                                updateQuestion(i, {
                                  subparts: q.subparts.filter(
                                    (_, xi) => xi !== si,
                                  ),
                                })
                              }
                            >
                              Remove
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <Button
                  type="button"
                  variant="secondary"
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
                >
                  Add sub-part
                </Button>
              </div>
            </div>
          </Card>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() => setQuestions((qs) => [...qs, blankQuestion()])}
        >
          Add question
        </Button>
      </div>

      <Card
        title="Course notes (optional)"
        subtitle="Optional. Read once to draft the marking rubric. You can also add notes later on the assessment page."
      >
        <div className="space-y-3">
          {noteFiles.length > 0 && (
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
              {noteFiles.map((file, i) => (
                <li
                  key={`${file.name}-${file.size}-${i}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <p className="truncate text-sm text-slate-900">
                    {file.name}{" "}
                    <span className="text-slate-600">
                      · {formatNoteSize(file.size)}
                    </span>
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setNoteFiles((files) => files.filter((_, j) => j !== i))
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Label htmlFor="assessment-notes">Add files</Label>
            <input
              id="assessment-notes"
              type="file"
              accept={NOTE_ACCEPT}
              multiple
              onChange={onNotesChange}
              className="block w-full text-sm text-slate-700 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-slate-300 file:bg-white file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-900 hover:file:bg-slate-50 disabled:opacity-50"
            />
          </div>
          <FieldError message={notesError} />
        </div>
      </Card>

      <Card
        title="Lecturer-only notes"
        subtitle="Guidance for the AI marker. Students never see this."
      >
        <Label htmlFor="assessment-reference-note">
          Marking guidance for the AI (not shown to students)
        </Label>
        <Textarea
          id="assessment-reference-note"
          value={referenceNote}
          onChange={(e) => setReferenceNote(e.target.value)}
          rows={2}
          placeholder="e.g. Accept phonetic spelling. For Q3, mark only the first two differences stated."
        />
      </Card>

      <div className="sticky bottom-0 rounded-lg border border-slate-200 bg-white px-5 py-3 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-slate-900">
            Total: {totalMarks === null ? "—" : `${totalMarks} marks`}
          </p>
          <Button
            type="submit"
            loading={pending && uploadProgress === null}
            disabled={pending}
          >
            {uploadProgress ?? "Create assessment"}
          </Button>
        </div>
        {error && (
          <div className="mt-2">
            <FieldError message={error} />
          </div>
        )}
      </div>
    </form>
  );
}
