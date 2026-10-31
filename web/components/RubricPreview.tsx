import Card from "./ui/Card";
import Badge from "./ui/Badge";
import type { Question, RubricPoint } from "@/lib/types";

function stripPrefix(note: string): string {
  return note.replace(/^(Accept|Reject):\s*/, "");
}

export default function RubricPreview({
  questions,
  points,
}: {
  questions: Question[];
  points: RubricPoint[];
}) {
  const byCode = new Map<string, RubricPoint[]>();
  for (const point of points) {
    const list = byCode.get(point.question_id) ?? [];
    list.push(point);
    byCode.set(point.question_id, list);
  }
  const groups = questions.filter((q) => (byCode.get(q.code) ?? []).length > 0);

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-slate-900">Rubric draft</h2>
      {groups.map((q) => {
        const list = byCode.get(q.code) ?? [];
        const sum = list.reduce((total, p) => total + p.max_marks, 0);
        return (
          <Card key={q.id} title={`${q.code} · ${sum} / ${q.max_marks} marks`}>
            <p className="truncate text-sm text-slate-600">{q.prompt}</p>
            <ul className="mt-2 divide-y divide-slate-200">
              {list.map((p) => (
                <li key={p.id} className="space-y-1.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-slate-800">{p.description}</p>
                    <p className="shrink-0 text-sm font-medium text-slate-900">
                      {p.max_marks} marks
                    </p>
                  </div>
                  {p.needs_lecturer && (
                    <Badge tone="warning">Needs your decision</Badge>
                  )}
                  {(p.accept ?? []).length > 0 && (
                    <p className="text-sm text-slate-600">
                      <span className="font-medium text-slate-700">
                        Accept:{" "}
                      </span>
                      {(p.accept ?? []).map(stripPrefix).join("; ")}
                    </p>
                  )}
                  {(p.reject ?? []).length > 0 && (
                    <p className="text-sm text-slate-600">
                      <span className="font-medium text-slate-700">
                        Reject:{" "}
                      </span>
                      {(p.reject ?? []).map(stripPrefix).join("; ")}
                    </p>
                  )}
                  {p.source_quote && (
                    <div>
                      <p className="text-sm text-slate-700 italic">
                        &ldquo;{p.source_quote}&rdquo;
                      </p>
                      <p className="text-xs text-slate-500">
                        {p.source_file}, p. {p.source_page}
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
