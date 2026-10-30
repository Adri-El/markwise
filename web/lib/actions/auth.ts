"use server";

import { redirect } from "next/navigation";
import { createClient } from "../supabase/server";
import type { Role } from "../types";

export interface AuthResult {
  ok: boolean;
  error?: string;
  next?: string;
}

function friendlyError(message: string): string {
  if (message.includes("Invalid login credentials"))
    return "Wrong email or password.";
  if (message.includes("User already registered"))
    return "An account with this email already exists. Try signing in.";
  if (message.includes("matric_number"))
    return "That matric number is already registered.";
  if (message.includes("Password should be"))
    return "Password must be at least 6 characters.";
  return message;
}

export async function signUp(input: {
  email: string;
  password: string;
  role: string;
  fullName: string;
  matric: string;
}): Promise<AuthResult> {
  const email = input.email.trim();
  if (!email || !input.password)
    return { ok: false, error: "Email and password are required." };
  if (input.password.length < 6)
    return { ok: false, error: "Password must be at least 6 characters." };
  if (input.role !== "student" && input.role !== "lecturer")
    return { ok: false, error: "Choose Student or Lecturer." };
  if (input.role === "student") {
    if (!input.fullName.trim())
      return { ok: false, error: "Full name is required." };
    if (!input.matric.trim())
      return { ok: false, error: "Matric number is required." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: {
      data: {
        role: input.role,
        full_name: input.fullName.trim(),
        matric_number: input.matric.trim(),
      },
    },
  });
  if (error) return { ok: false, error: friendlyError(error.message) };
  if (!data.session)
    return { ok: true, next: "/sign-in?notice=check-email" };
  redirect(input.role === "lecturer" ? "/lecturer" : "/student");
}

export async function signIn(input: {
  email: string;
  password: string;
}): Promise<AuthResult> {
  if (!input.email.trim() || !input.password)
    return { ok: false, error: "Email and password are required." };
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: input.email.trim(),
    password: input.password,
  });
  if (error) return { ok: false, error: friendlyError(error.message) };
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .single();
  if (profileError || !profile) {
    console.error(
      "sign-in profile lookup failed:",
      profileError?.message ?? "no profile row",
    );
    return {
      ok: false,
      error: "Signed in, but your profile could not be loaded. Try again.",
    };
  }
  const role = (profile as { role: Role }).role;
  redirect(role === "lecturer" ? "/lecturer" : "/student");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}
