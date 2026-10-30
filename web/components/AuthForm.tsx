"use client";

import { useState } from "react";
import { signIn, signUp } from "@/lib/actions/auth";
import type { Role } from "@/lib/types";

const input =
  "w-full border border-neutral-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-neutral-600";

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
    if (mode === "sign-up" && role === "student") {
      if (!fullName) {
        setError("Full name is required.");
        return;
      }
      if (!matric) {
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
    <form onSubmit={onSubmit} className="space-y-4 max-w-sm">
      {mode === "sign-up" && (
        <div className="flex gap-4 text-sm">
          {(["student", "lecturer"] as Role[]).map((r) => (
            <label
              key={r}
              htmlFor={`auth-role-${r}`}
              className="flex items-center gap-2"
            >
              <input
                id={`auth-role-${r}`}
                type="radio"
                name="role"
                value={r}
                checked={role === r}
                onChange={() => setRole(r)}
              />
              {r === "student" ? "Student" : "Lecturer"}
            </label>
          ))}
        </div>
      )}
      {mode === "sign-up" && role === "student" && (
        <>
          <div>
            <label htmlFor="auth-fullname" className="block text-sm font-medium mb-1">
              Full name
            </label>
            <input
              id="auth-fullname"
              name="fullName"
              placeholder="Full name"
              className={input}
              autoComplete="name"
            />
          </div>
          <div>
            <label htmlFor="auth-matric" className="block text-sm font-medium mb-1">
              Matric number
            </label>
            <input
              id="auth-matric"
              name="matric"
              placeholder="Matric number"
              className={input}
            />
          </div>
        </>
      )}
      <div>
        <label htmlFor="auth-email" className="block text-sm font-medium mb-1">
          Email
        </label>
        <input
          id="auth-email"
          name="email"
          type="email"
          placeholder="Email"
          className={input}
          autoComplete="email"
        />
      </div>
      <div>
        <label htmlFor="auth-password" className="block text-sm font-medium mb-1">
          Password
        </label>
        <input
          id="auth-password"
          name="password"
          type="password"
          placeholder="Password"
          className={input}
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        />
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="bg-neutral-900 text-white text-sm rounded px-4 py-2 disabled:opacity-50"
      >
        {pending
          ? "Please wait…"
          : mode === "sign-up"
            ? "Create account"
            : "Sign in"}
      </button>
    </form>
  );
}
