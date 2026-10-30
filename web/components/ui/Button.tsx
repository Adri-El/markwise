"use client";

import type { MouseEventHandler, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700",
  secondary:
    "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50",
  ghost: "text-slate-700 hover:bg-slate-100",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

interface ButtonProps {
  variant?: Variant;
  loading?: boolean;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  href?: string;
  className?: string;
  children: ReactNode;
}

export default function Button({
  variant = "primary",
  loading = false,
  type = "button",
  disabled = false,
  onClick,
  href,
  className = "",
  children,
}: ButtonProps) {
  const cls =
    `inline-flex cursor-pointer items-center justify-center gap-2 rounded-md ` +
    `px-4 py-2 text-sm font-medium transition-colors ` +
    `disabled:cursor-not-allowed disabled:opacity-50 ` +
    `${variants[variant]} ${className}`;
  if (href !== undefined) {
    return (
      <a href={href} className={cls}>
        {loading ? "Please wait…" : children}
      </a>
    );
  }
  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      className={cls}
    >
      {loading ? "Please wait…" : children}
    </button>
  );
}
