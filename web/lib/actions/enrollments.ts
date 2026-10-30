"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth";
import { createClient } from "../supabase/server";

export interface JoinResult {
  ok: boolean;
  title?: string;
  error?: string;
}

export async function joinByCode(code: string): Promise<JoinResult> {
  await requireRole("student");
  if (!code.trim()) return { ok: false, error: "Enter a join code." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("join_with_code", {
    p_code: code.trim(),
  });
  if (error) {
    if (error.message.includes("invalid code"))
      return { ok: false, error: "No assessment uses that code." };
    return { ok: false, error: error.message };
  }
  const row = (data as { title: string }[] | null)?.[0];
  revalidatePath("/student");
  return { ok: true, title: row?.title };
}
