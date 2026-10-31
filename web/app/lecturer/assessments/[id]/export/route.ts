import { notFound } from "next/navigation";
import ExcelJS from "exceljs";
import { requireRole } from "@/lib/auth";
import { effectiveScores } from "@/lib/scoring";
import type { Award, ResultOverrides } from "@/lib/scoring";
import { createClient } from "@/lib/supabase/server";
import type { Assessment, Question, RubricPoint } from "@/lib/types";

export const runtime = "nodejs";

interface ResultShape {
  submission_id: string;
  awards: unknown;
  overrides: unknown;
}

function sanitiseTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug === "" ? "assessment" : slug;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireRole("lecturer");
  const { id } = await params;
  const supabase = await createClient();
  const { data: assessment } = await supabase
    .from("assessments")
    .select("*")
    .eq("id", id)
    .single();
  if (!assessment) notFound();
  const a = assessment as Assessment;

  const { data: questions } = await supabase
    .from("questions")
    .select("*")
    .eq("assessment_id", id)
    .order("position");
  const questionList = (questions ?? []) as Question[];
  const max = questionList.reduce((t, q) => t + q.max_marks, 0);
  const { data: rubricRows } = await supabase
    .from("rubrics")
    .select("points")
    .eq("assessment_id", id)
    .limit(1);
  const saved = (rubricRows ?? [])[0] as { points?: unknown } | undefined;
  const points: RubricPoint[] = Array.isArray(saved?.points)
    ? (saved.points as RubricPoint[])
    : [];
  const { data: submittedSubs } = await supabase
    .from("submissions")
    .select("id, student_id")
    .eq("assessment_id", id)
    .eq("status", "submitted");
  const submittedList = ((submittedSubs ?? []) as {
    id: string;
    student_id: string;
  }[]);
  let resultShapes: ResultShape[] = [];
  let profileShapes: {
    id: string;
    full_name: string;
    matric_number: string | null;
  }[] = [];
  if (submittedList.length > 0) {
    const subIds = submittedList.map((s) => s.id);
    const { data: results } = await supabase
      .from("results")
      .select("submission_id, awards, overrides")
      .in("submission_id", subIds);
    resultShapes = (results ?? []) as ResultShape[];
    const studentIds = [...new Set(submittedList.map((s) => s.student_id))];
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, matric_number")
      .in("id", studentIds);
    profileShapes = (profiles ?? []) as typeof profileShapes;
  }
  const resultBySub = new Map(resultShapes.map((r) => [r.submission_id, r]));
  const profileById = new Map(profileShapes.map((p) => [p.id, p]));

  const rows = submittedList
    .map((s) => {
      const result = resultBySub.get(s.id);
      const profile = profileById.get(s.student_id);
      const awards = Array.isArray(result?.awards)
        ? (result.awards as Award[])
        : [];
      const overrides = (result?.overrides ?? {}) as ResultOverrides;
      const total = result
        ? effectiveScores(questionList, points, awards, overrides).total
        : null;
      return {
        name: profile?.full_name ?? "Unknown student",
        matric: profile?.matric_number ?? null,
        score: total,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Results");
  sheet.columns = [
    { header: "Name", key: "name", width: 24 },
    { header: "Matric number", key: "matric", width: 16 },
    { header: `Score (out of ${max})`, key: "score", width: 16 },
  ];
  for (const row of rows) {
    sheet.addRow(row);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `${sanitiseTitle(a.title)}-results.xlsx`;
  return new Response(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
