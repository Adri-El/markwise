"use client";

import { useState } from "react";
import { signIn, signUp } from "@/lib/actions/auth";
import type { Role } from "@/lib/types";
import Button from "./ui/Button";
import FieldError from "./ui/FieldError";
import Input from "./ui/Input";
import Label from "./ui/Label";

const roles: { value: Role; title: string; blurb: string }[] = [
  {
    value: "student",
    title: "Student",
    blurb: "Join with a code, submit answers",
  },
  {
    value: "lecturer",
    title: "Lecturer",
    blurb: "Set assessments, review marks",
  },
];

export default function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const [role, setRole] = useState<Role | "">("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const fullName = String(form.get("fullName") ?? "").trim();
    const matric = String(form.get("matric") ?? "").trim();
    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (mode === "sign-up" && role === "") {
      setError("Choose Student or Lecturer.");
      return;
    }
    if (mode === "sign-up" && role !== "") {
      if (!fullName) {
        setError("Full name is required.");
        return;
      }
      if (role === "student" && !matric) {
        setError("Matric number is required.");
        return;
      }
    }
    setPending(true);
    try {
      const result =
        mode === "sign-up"
          ? await signUp({ email, password, role, fullName, matric })
          : await signIn({ email, password });
      if (!result.ok) setError(result.error ?? "Something went wrong.");
      else if (result.next) window.location.href = result.next;
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {mode === "sign-up" && (
        <div
          role="radiogroup"
          aria-label="Account type"
          className="grid grid-cols-2 gap-3"
        >
          {roles.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={role === r.value}
              onClick={() => setRole(r.value)}
              className={
                `rounded-lg border p-4 text-left transition-colors ${
                  role === r.value
                    ? "border-indigo-600 bg-indigo-50/60 ring-2 ring-indigo-600/30"
                    : "border-slate-300 bg-white hover:border-slate-400"
                }`
              }
            >
              <span className="block text-sm font-semibold text-slate-900">
                {r.title}
              </span>
              <span className="mt-0.5 block text-xs text-slate-600">
                {r.blurb}
              </span>
            </button>
          ))}
        </div>
      )}
      {mode === "sign-up" && role !== "" && (
        <div>
          <Label htmlFor="auth-fullname">Full name</Label>
          <Input
            id="auth-fullname"
            name="fullName"
            placeholder={
              role === "lecturer" ? "e.g. Dr Ada Okafor" : "Full name"
            }
            autoComplete="name"
            maxLength={100}
          />
        </div>
      )}
      {mode === "sign-up" && role === "student" && (
        <div>
          <Label htmlFor="auth-matric">Matric number</Label>
          <Input id="auth-matric" name="matric" placeholder="Matric number" />
        </div>
      )}
      <div>
        <Label htmlFor="auth-email">Email</Label>
        <Input
          id="auth-email"
          name="email"
          type="email"
          placeholder="Email"
          autoComplete="email"
        />
      </div>
      <div>
        <Label htmlFor="auth-password">Password</Label>
        <Input
          id="auth-password"
          name="password"
          type="password"
          placeholder="Password"
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        />
      </div>
      <FieldError message={error} />
      <Button type="submit" loading={pending} className="w-full">
        {mode === "sign-up" ? "Create account" : "Sign in"}
      </Button>
    </form>
  );
}
