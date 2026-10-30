import { requireRole } from "@/lib/auth";
import AssessmentForm from "@/components/AssessmentForm";

export default async function NewAssessmentPage() {
  await requireRole("lecturer");
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">New assessment</h1>
      <AssessmentForm />
    </div>
  );
}
