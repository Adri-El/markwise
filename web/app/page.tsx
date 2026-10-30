import { redirect } from "next/navigation";
import { currentProfile } from "@/lib/auth";

export default async function Home() {
  const profile = await currentProfile();
  if (profile) {
    redirect(profile.role === "lecturer" ? "/lecturer" : "/student");
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Mark coursework faster</h1>
      <p className="text-neutral-700 max-w-xl">
        Lecturers set assignments, tests and exams. Students submit typed
        answers or PDFs. An AI marking agent marks every script against the
        lecturer&apos;s marking scheme, and the lecturer reviews the results.
      </p>
      <p className="flex gap-4 text-sm">
        <a href="/sign-in" className="underline">
          Sign in
        </a>
        <a href="/sign-up" className="underline">
          Create an account
        </a>
      </p>
    </div>
  );
}
