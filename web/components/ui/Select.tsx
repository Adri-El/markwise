import type { ReactNode, SelectHTMLAttributes } from "react";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
}

export default function Select({ className = "", children, ...rest }: SelectProps) {
  return (
    <select
      className={
        `w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm ` +
        `text-slate-900 focus:border-indigo-600 focus:outline-none ` +
        `focus:ring-2 focus:ring-indigo-600/30 disabled:bg-slate-100 ${className}`
      }
      {...rest}
    >
      {children}
    </select>
  );
}
