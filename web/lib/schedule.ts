// Pure date helpers for assessment schedules. Safe on client and server.

export const PAST_GRACE_MS = 60_000;

// datetime-local value -> ISO UTC string.
export function localToIso(local: string): string {
  return new Date(local).toISOString();
}

// ISO UTC string -> datetime-local value in the local time zone.
export function isoToLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function isValidDate(value: string | null): value is string {
  return !!value && !Number.isNaN(new Date(value).getTime());
}

export function isPast(value: string): boolean {
  return new Date(value).getTime() < Date.now() - PAST_GRACE_MS;
}
