import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";
import type { Profile, Role } from "./types";

export async function currentProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  if (!sub) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", sub)
    .single();
  return (profile as Profile | null) ?? null;
}

export async function requireRole(role: Role): Promise<Profile> {
  const profile = await currentProfile();
  if (!profile) redirect("/sign-in");
  if (profile.role !== role) {
    redirect(profile.role === "lecturer" ? "/lecturer" : "/student");
  }
  return profile;
}
