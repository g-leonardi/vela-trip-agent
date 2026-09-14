const ITALIAN_MONTHS: Record<string, number> = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toIso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/** Deterministic Italian/ISO date resolver. Calendar arithmetic is exactly
 * the kind of thing an LLM gets subtly wrong (verified live: Workers AI
 * Llama-3.3-70B returned "1970"/"1971" as the year despite an explicit
 * "today is 2026-09-14, never use 1970" instruction) — so the model is only
 * asked to lift the raw date phrase out of the sentence; resolving it to a
 * real calendar date happens here, in code, where it's testable. */
export function resolveDate(raw: string | null, now: Date = new Date()): string | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();

  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  if (/\boggi\b/.test(text)) return toIso(now);
  if (/\bdomani\b/.test(text)) return toIso(addDays(now, 1));
  if (/\bdopodomani\b/.test(text)) return toIso(addDays(now, 2));

  const inDays = text.match(/tra\s+(\d+)\s+giorni/);
  if (inDays) return toIso(addDays(now, Number(inDays[1])));
  const inWeeks = text.match(/tra\s+(\d+)\s+settiman/);
  if (inWeeks) return toIso(addDays(now, Number(inWeeks[1]) * 7));

  if (/prossimo\s+weekend|weekend\s+prossimo|prossimo\s+fine\s*settimana/.test(text)) {
    const day = now.getUTCDay(); // 0=Sun..6=Sat
    const offset = ((6 - day + 7) % 7) || 7; // next Saturday, always in the future
    return toIso(addDays(now, offset));
  }

  // "25 settembre" / "25 settembre 2027" / "settembre 25"
  const dayMonth = text.match(
    /(\d{1,2})\s*(?:°|º)?\s*(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?/,
  );
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = ITALIAN_MONTHS[dayMonth[2]!]!;
    let year = dayMonth[3] ? Number(dayMonth[3]) : now.getUTCFullYear();
    let candidate = new Date(Date.UTC(year, month - 1, day));
    if (!dayMonth[3] && candidate.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
      year += 1;
      candidate = new Date(Date.UTC(year, month - 1, day));
    }
    return toIso(candidate);
  }

  return null;
}
