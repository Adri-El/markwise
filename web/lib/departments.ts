// Parse the lecturer's comma-separated departments into the same
// title-cased, de-duplicated list the database stores (see
// create_assessment in web/supabase/schema.sql).
export function parseDepartments(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(",")) {
    const collapsed = raw.trim().replace(/\s+/g, " ");
    if (collapsed === "") continue;
    const titled = collapsed
      .toLowerCase()
      .replace(/(^|[^a-z0-9])([a-z0-9])/g, (_, p1: string, p2: string) =>
        p1 + p2.toUpperCase(),
      );
    if (!seen.has(titled)) {
      seen.add(titled);
      out.push(titled);
    }
  }
  return out;
}
