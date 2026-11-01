export type Role = "lecturer" | "student";
export type AssessmentKind = "assignment" | "test" | "exam";
export type AnswerMode = "typed" | "pdf";

export const MAX_ANSWER_CHARS = 20_000;

export const DRAFT_BLOCK_REASON =
  "Upload course notes or add a marking scheme to every question first.";

export interface Profile {
  id: string;
  role: Role;
  full_name: string;
  matric_number: string | null;
}

export interface Assessment {
  id: string;
  lecturer_id: string;
  title: string;
  kind: AssessmentKind;
  instructions: string;
  opens_at: string | null;
  closes_at: string | null;
  answer_mode: AnswerMode;
  join_code: string;
  created_at: string;
  departments: string[];
}

export interface Subpart {
  id: string;
  max_marks: number;
}

export interface Question {
  id: string;
  assessment_id: string;
  code: string;
  position: number;
  prompt: string;
  max_marks: number;
  subparts: Subpart[];
}

export interface MarkingScheme {
  question_id: string;
  scheme: string;
}

export interface CourseNote {
  id: string;
  assessment_id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: string;
}

export interface Submission {
  id: string;
  assessment_id: string;
  student_id: string;
  status: "draft" | "submitted";
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  script_path: string | null;
  department: string | null;
}

export interface Answer {
  id: string;
  submission_id: string;
  question_id: string;
  text: string;
  pdf_path: string | null;
  updated_at: string;
}

export interface MarkingJobProgress {
  stage?: "reading_notes" | "drafting" | "saving" | "marking";
  points?: number;
  notes_pages?: number;
  unreadable_pages?: { file: string; page: number }[];
  warnings?: string[];
  usage?: { input_tokens?: number; output_tokens?: number };
  total?: number;
  done?: number;
  needs_review?: number;
  incomplete?: number;
  note?: string;
}

export interface MarkingJob {
  id: string;
  assessment_id: string;
  type: "build_rubric" | "mark_all";
  status: "queued" | "working" | "done" | "error";
  progress: MarkingJobProgress;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RubricPoint {
  id: string;
  question_id: string;
  subpart?: string;
  description: string;
  max_marks: number;
  source_quote?: string;
  source_file?: string;
  source_page?: number;
  source_section?: string;
  accept?: string[];
  reject?: string[];
  needs_lecturer?: boolean;
  reason?: string;
}
