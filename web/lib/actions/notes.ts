"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { createClient } from "../supabase/server";

export interface RecordNoteInput {
  assessmentId: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface NoteResult {
  ok: boolean;
  error?: string;
}

const ALLOWED_EXTENSIONS = [".pdf", ".md", ".txt"];
const MAX_NOTE_BYTES = 20_971_520; // 20 MB, matches the course_notes check
const MAX_NOTES_PER_ASSESSMENT = 10;

export async function recordNote(input: RecordNoteInput): Promise<NoteResult> {
  await requireRole("lecturer");
  const { assessmentId, storagePath, filename, mimeType, sizeBytes } = input;
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (filename.lastIndexOf(".") < 0 || !ALLOWED_EXTENSIONS.includes(ext))
    return { ok: false, error: "Only .pdf, .md and .txt files are allowed." };
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_NOTE_BYTES)
    return { ok: false, error: "File must be between 1 byte and 20 MB." };
  if (!storagePath.startsWith(`${assessmentId}/`))
    return { ok: false, error: "Invalid storage path." };

  const supabase = await createClient();
  const { data: assessment } = await supabase
    .from("assessments")
    .select("id")
    .eq("id", assessmentId)
    .single();
  if (!assessment) return { ok: false, error: "Assessment not found." };

  const { count } = await supabase
    .from("course_notes")
    .select("id", { count: "exact", head: true })
    .eq("assessment_id", assessmentId);
  if ((count ?? 0) >= MAX_NOTES_PER_ASSESSMENT)
    return { ok: false, error: "Maximum 10 files per assessment." };

  const { error } = await supabase.from("course_notes").insert({
    assessment_id: assessmentId,
    storage_path: storagePath,
    filename,
    mime_type: mimeType,
    size_bytes: sizeBytes,
  });
  if (error) {
    console.error("recordNote insert failed:", error.message);
    return { ok: false, error: "Could not save the note. Try again." };
  }
  revalidatePath(`/lecturer/assessments/${assessmentId}`);
  return { ok: true };
}

export async function deleteNote(input: {
  assessmentId: string;
  noteId: string;
}): Promise<NoteResult> {
  await requireRole("lecturer");
  const supabase = await createClient();
  const { data: note } = await supabase
    .from("course_notes")
    .select("id, storage_path")
    .eq("id", input.noteId)
    .eq("assessment_id", input.assessmentId)
    .single();
  if (!note) return { ok: false, error: "Note not found." };

  const { error } = await supabase
    .from("course_notes")
    .delete()
    .eq("id", input.noteId);
  if (error) {
    console.error("deleteNote row delete failed:", error.message);
    return { ok: false, error: "Could not delete the note. Try again." };
  }
  const { data: removed, error: storageError } = await supabase.storage
    .from("course-notes")
    .remove([(note as { storage_path: string }).storage_path]);
  if (storageError || (removed ?? []).length === 0) {
    // Orphaned file is harmless; the row is gone, so still return ok.
    console.error(
      "deleteNote storage remove failed:",
      storageError?.message ?? "no objects removed",
    );
  }
  revalidatePath(`/lecturer/assessments/${input.assessmentId}`);
  return { ok: true };
}
