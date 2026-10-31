import type { ReactNode } from "react";

// Wrap every occurrence of the quotes in <mark>. Both sides are
// lowercased with whitespace runs collapsed to one space, and each
// normalised character maps back to its original index, so quotes
// still match next to punctuation. Longest quotes match first;
// quotes under 3 characters, quotes that don't match, and matches
// overlapping an earlier one are skipped.
export function highlightQuotes(
  text: string,
  quotes: string[],
): ReactNode[] {
  const [normed, index] = normalizeWithMap(text);
  const wanted = quotes
    .map((q) => q.toLowerCase().split(/\s+/).filter(Boolean).join(" "))
    .filter((q) => q.length >= 3)
    .sort((a, b) => b.length - a.length);
  const used = new Array<boolean>(normed.length).fill(false);
  const spans: { start: number; end: number }[] = [];
  for (const quote of wanted) {
    const at = findUnmarked(normed, quote, used);
    if (at < 0) continue;
    for (let i = at; i < at + quote.length; i++) used[i] = true;
    spans.push({ start: index[at], end: index[at + quote.length - 1] + 1 });
  }
  spans.sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let pos = 0;
  spans.forEach((span, i) => {
    if (span.start > pos) nodes.push(text.slice(pos, span.start));
    nodes.push(
      <mark key={i} className="rounded bg-amber-100 px-0.5 text-slate-900">
        {text.slice(span.start, span.end)}
      </mark>,
    );
    pos = span.end;
  });
  if (pos < text.length) nodes.push(text.slice(pos));
  return nodes;
}

function normalizeWithMap(text: string): [string, number[]] {
  const lowered = text.toLowerCase();
  const chars: string[] = [];
  const index: number[] = [];
  let pending = false;
  let pendingAt = 0;
  for (let i = 0; i < lowered.length; i++) {
    if (/\s/.test(lowered[i])) {
      if (chars.length > 0 && !pending) {
        pending = true;
        pendingAt = i;
      }
      continue;
    }
    if (pending) {
      chars.push(" ");
      index.push(pendingAt);
      pending = false;
    }
    chars.push(lowered[i]);
    index.push(i);
  }
  return [chars.join(""), index];
}

function findUnmarked(
  haystack: string,
  needle: string,
  used: boolean[],
): number {
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    let clear = true;
    for (let i = at; i < at + needle.length; i++) {
      if (used[i]) {
        clear = false;
        break;
      }
    }
    if (clear) return at;
    at = haystack.indexOf(needle, at + 1);
  }
  return -1;
}
