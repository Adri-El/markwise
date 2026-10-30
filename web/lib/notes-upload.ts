import { createClient } from "@/lib/supabase/client";
import { recordNote } from "@/lib/actions/notes";

export const NOTE_ACCEPT = ".pdf,.md,.txt";
export const NOTE_ALLOWED_EXTENSIONS = [".pdf", ".md", ".txt"];
export const MAX_NOTE_BYTES = 20_971_520; // 20 MB, matches the course_notes check
export const MAX_NOTES_PER_ASSESSMENT = 10;

export interface UploadNoteResult {
  ok: boolean;
  error?: string;
}

// Returns an error message when the file is unusable, else null.
export function validateNoteFile(file: File): string | null {
  const dot = file.name.lastIndexOf(".");
  if (
    dot < 0 ||
    !NOTE_ALLOWED_EXTENSIONS.includes(file.name.slice(dot).toLowerCase())
  )
    return "Only .pdf, .md and .txt files are allowed.";
  if (file.size <= 0 || file.size > MAX_NOTE_BYTES)
    return "File must be between 1 byte and 20 MB.";
  return null;
}

export function formatNoteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

// Uploads to Storage, records the row, removes the object if recording fails.
export async function uploadNote(
  assessmentId: string,
  file: File,
): Promise<UploadNoteResult> {
  const path = `${assessmentId}/${crypto.randomUUID()}-${sanitise(file.name)}`;
  const supabase = createClient();
  const { error: uploadError } = await supabase.storage
    .from("course-notes")
    .upload(path, file);
  if (uploadError) return { ok: false, error: "Upload failed. Try again." };
  const result = await recordNote({
    assessmentId,
    storagePath: path,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  });
  if (!result.ok) {
    await supabase.storage.from("course-notes").remove([path]);
    return { ok: false, error: result.error ?? "Could not save the note." };
  }
  return { ok: true };
}
