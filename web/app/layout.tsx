import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Markwise",
  description: "AI marking assistant for lecturers",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased">
        <header className="border-b border-neutral-200">
          <div className="max-w-3xl mx-auto px-6 py-3">
            <a href="/" className="font-semibold">
              Markwise
            </a>
          </div>
        </header>
        <main className="max-w-3xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
