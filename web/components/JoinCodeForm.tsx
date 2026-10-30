"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { joinByCode } from "@/lib/actions/enrollments";

export default function JoinCodeForm() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setIsError(false);
    const code = String(
      new FormData(event.currentTarget).get("code") ?? "",
    ).trim();
    if (!code) {
      setIsError(true);
      setMessage("Enter a join code.");
      return;
    }
    setPending(true);
    try {
      const result = await joinByCode(code);
      if (!result.ok) {
        setIsError(true);
        setMessage(result.error ?? "Something went wrong.");
      } else {
        setMessage(
          result.title ? `Joined “${result.title}”.` : "Joined assessment.",
        );
        (event.target as HTMLFormElement).reset();
        router.refresh();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex gap-2 items-start max-w-sm">
      <label htmlFor="join-code" className="sr-only">
        Join code
      </label>
      <input
        id="join-code"
        name="code"
        placeholder="Join code"
        autoComplete="off"
        className="flex-1 border border-neutral-300 rounded px-3 py-2 text-sm uppercase focus:outline-none focus:border-neutral-600"
      />
      <button
        type="submit"
        disabled={pending}
        className="bg-neutral-900 text-white text-sm rounded px-4 py-2 disabled:opacity-50"
      >
        {pending ? "…" : "Join"}
      </button>
      {message && (
        <p className={`text-sm ${isError ? "text-red-700" : "text-green-700"}`}>
          {message}
        </p>
      )}
    </form>
  );
}
