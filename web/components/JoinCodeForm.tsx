"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { joinByCode } from "@/lib/actions/enrollments";
import Button from "./ui/Button";
import FieldError from "./ui/FieldError";
import Input from "./ui/Input";

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
    <form onSubmit={onSubmit} className="max-w-sm space-y-2">
      <div className="flex gap-2">
        <label htmlFor="join-code" className="sr-only">
          Join code
        </label>
        <Input
          id="join-code"
          name="code"
          placeholder="Join code"
          autoComplete="off"
          className="uppercase"
        />
        <Button type="submit" loading={pending}>
          Join
        </Button>
      </div>
      {isError ? (
        <FieldError message={message} />
      ) : (
        message && <p className="text-sm text-green-700">{message}</p>
      )}
    </form>
  );
}
