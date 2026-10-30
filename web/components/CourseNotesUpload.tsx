"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteNote } from "@/lib/actions/notes";
import {
  MAX_NOTES_PER_ASSESSMENT,
  NOTE_ACCEPT,
  formatNoteSize,
  uploadNote,
  validateNoteFile,
} from "@/lib/notes-upload";
import type { CourseNote } from "@/lib/types";
import Button from "./ui/Button";
import Card from "./ui/Card";
import FieldError from "./ui/FieldError";
import Label from "./ui/Label";
import LocalDateTime from "./LocalDateTime";

export default function CourseNotesUpload({
  assessmentId,
  notes,
}: {
  assessmentId: string;
  notes: CourseNote[];
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    const problem = validateNoteFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    if (notes.length >= MAX_NOTES_PER_ASSESSMENT) {
      setError("Maximum 10 files per assessment.");
      return;
    }
    setUploading(true);
    try {
      const result = await uploadNote(assessmentId, file);
      if (!result.ok) {
        setError(result.error ?? "Upload failed. Try again.");
        return;
      }
      router.refresh();
    } finally {
      setUploading(false);
    }
  }

  async function onRemove(note: CourseNote) {
    if (!window.confirm(`Remove ${note.filename}?`)) return;
    setError("");
    setRemovingId(note.id);
    try {
      const result = await deleteNote({ assessmentId, noteId: note.id });
      if (!result.ok) {
        setError(result.error ?? "Could not delete the note.");
      } else {
        router.refresh();
      }
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card
      title="Course notes"
      subtitle="Read once to draft the marking rubric. You review and approve the rubric before any script is marked."
    >
      <div className="space-y-4">
        {notes.length === 0 ? (
          <p className="text-sm text-slate-600">No files yet.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
            {notes.map((note) => (
              <li
                key={note.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {note.filename}
                  </p>
                  <p className="text-xs text-slate-600">
                    {formatNoteSize(note.size_bytes)} ·{" "}
                    <LocalDateTime value={note.created_at} />
                  </p>
                </div>
                <Button
                  variant="ghost"
                  loading={removingId === note.id}
                  onClick={() => onRemove(note)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <Label htmlFor="course-notes-file">Upload a file</Label>
          <input
            id="course-notes-file"
            type="file"
            accept={NOTE_ACCEPT}
            disabled={uploading}
            onChange={onFileChange}
            className="block w-full text-sm text-slate-700 file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-slate-300 file:bg-white file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-900 hover:file:bg-slate-50 disabled:opacity-50"
          />
          {uploading && (
            <p className="mt-1 text-sm text-slate-600">Uploading…</p>
          )}
        </div>
        <FieldError message={error} />
      </div>
    </Card>
  );
}
