import { redirect } from "next/navigation";
import { currentProfile } from "@/lib/auth";
import Button from "@/components/ui/Button";

const steps = [
  { lead: "Create.", rest: "Set assignments, tests and exams with marking schemes." },
  { lead: "Students submit.", rest: "Typed answers or PDFs, before the deadline." },
  { lead: "AI marks with evidence.", rest: "Every mark cites a quote from the answer." },
  { lead: "You review & export.", rest: "Adjust, approve and export results to Excel." },
];

export default async function Home() {
  const profile = await currentProfile();
  if (profile) {
    redirect(profile.role === "lecturer" ? "/lecturer" : "/student");
  }
  return (
    <div className="max-w-2xl space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-semibold text-slate-900">
          Marking that shows its work.
        </h1>
        <p className="text-slate-600">
          Lecturers set the work, students submit it, and an AI marker grades
          every script against your marking scheme — with a quote behind every
          mark.
        </p>
      </div>
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">
              {i + 1}
            </span>
            <p className="text-sm text-slate-700">
              <strong className="font-semibold text-slate-900">
                {step.lead}
              </strong>{" "}
              {step.rest}
            </p>
          </li>
        ))}
      </ol>
      <div className="flex gap-3">
        <Button href="/sign-in" variant="secondary">
          Sign in
        </Button>
        <Button href="/sign-up">Create account</Button>
      </div>
    </div>
  );
}
