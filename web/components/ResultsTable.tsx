import Badge from "./ui/Badge";
import Card from "./ui/Card";
import LocalDateTime from "./LocalDateTime";

export interface ResultRow {
  submissionId: string;
  studentName: string;
  matric: string | null;
  status: "marked" | "needs_review" | "incomplete" | null;
  total: number | null;
  max: number | null;
  flags: number;
  markedAt: string | null;
  edited: boolean;
  approved: boolean;
  published: boolean;
}

const STATUS_RANK: Record<NonNullable<ResultRow["status"]>, number> = {
  needs_review: 0,
  incomplete: 1,
  marked: 2,
};

export function sortResultRows<T extends ResultRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const rankA = a.status === null ? 3 : STATUS_RANK[a.status];
    const rankB = b.status === null ? 3 : STATUS_RANK[b.status];
    if (rankA !== rankB) return rankA - rankB;
    return a.studentName.localeCompare(b.studentName);
  });
}

function StatusBadge({ status }: { status: ResultRow["status"] }) {
  if (status === "marked") return <Badge tone="success">Marked</Badge>;
  if (status === "needs_review")
    return <Badge tone="warning">Needs review</Badge>;
  if (status === "incomplete") return <Badge tone="danger">Incomplete</Badge>;
  return <Badge tone="neutral">Not marked yet</Badge>;
}

export default function ResultsTable({
  assessmentId,
  rows,
}: {
  assessmentId: string;
  rows: ResultRow[];
}) {
  return (
    <Card title="Results">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-500">
              <th className="py-2 pr-4 font-medium">Student</th>
              <th className="py-2 pr-4 font-medium">Matric</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Score</th>
              <th className="py-2 pr-4 font-medium">Flags</th>
              <th className="py-2 pr-4 font-medium">Approved</th>
              <th className="py-2 pr-4 font-medium">Published</th>
              <th className="py-2 font-medium">Marked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.map((row) => (
              <tr key={row.submissionId}>
                <td className="py-2 pr-4 text-slate-900">
                  {row.status !== null ? (
                    <a
                      href={`/lecturer/assessments/${assessmentId}/results/${row.submissionId}`}
                      className="font-medium text-indigo-600 hover:underline"
                    >
                      {row.studentName}
                    </a>
                  ) : (
                    row.studentName
                  )}
                </td>
                <td className="py-2 pr-4 text-slate-600">
                  {row.matric ?? "—"}
                </td>
                <td className="py-2 pr-4">
                  <StatusBadge status={row.status} />
                </td>
                <td className="py-2 pr-4 text-slate-600">
                  {row.total === null || row.max === null
                    ? "—"
                    : `${row.total} / ${row.max}`}
                  {row.edited && (
                    <span className="ml-1 text-xs text-slate-400">edited</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-slate-600">{row.flags}</td>
                <td className="py-2 pr-4">
                  {row.approved ? (
                    <Badge tone="success">Approved</Badge>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {row.published ? (
                    <Badge tone="info">Published</Badge>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
                <td className="py-2 text-slate-600">
                  <LocalDateTime value={row.markedAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
