import type { ReactNode } from "react";

export default function Label({
  htmlFor,
  children,
  className = "",
}: {
  htmlFor: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={`mb-1 block text-sm font-medium text-slate-700 ${className}`}
    >
      {children}
    </label>
  );
}
