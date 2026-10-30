import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { currentProfile } from "@/lib/auth";
import { signOut } from "@/lib/actions/auth";
import Button from "@/components/ui/Button";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Markwise",
  description: "AI marking assistant for lecturers",
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const profile = await currentProfile();
  const who = profile
    ? profile.full_name
      ? `${profile.full_name} · ${capitalize(profile.role)}`
      : capitalize(profile.role)
    : null;

  return (
    <html lang="en">
      <body className={`${inter.className} min-h-screen bg-slate-50 text-slate-900`}>
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
            <a href="/" className="text-base font-semibold text-slate-900">
              Markwise
            </a>
            {profile ? (
              <div className="flex items-center gap-4 text-sm">
                <span className="text-slate-600">{who}</span>
                <form action={signOut}>
                  <Button type="submit" variant="ghost">
                    Sign out
                  </Button>
                </form>
              </div>
            ) : (
              <a
                href="/sign-in"
                className="text-sm font-medium text-indigo-600 hover:underline"
              >
                Sign in
              </a>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
