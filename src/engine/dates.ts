// Month names in the two languages we've verified live traffic in
// (Italian by default, English once language-mirroring kicked in — see
// ARCHITECTURE.md, 2026-09-15). Adding a language here is just adding a
// row; the rest of the resolver is language-agnostic regex plumbing.
const MONTHS: Record<string, number> = {
  gennaio: 1,
  january: 1,
  febbraio: 2,
  february: 2,
  marzo: 3,
  march: 3,
  aprile: 4,
  april: 4,
  maggio: 5,
  may: 5,
  giugno: 6,
  june: 6,
  luglio: 7,
  july: 7,
  agosto: 8,
  august: 8,
  settembre: 9,
  september: 9,
  ottobre: 10,
  october: 10,
  novembre: 11,
  november: 11,
  dicembre: 12,
  december: 12,
};
const MONTH_NAMES_PATTERN = Object.keys(MONTHS).join("|");

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

/** `isoDate` (YYYY-MM-DD) plus `days` calendar days, as another ISO date —
 * used to derive a confirmed booking's real end date from its start date
 * and the product's own duration (candidate.durationDays), since a
 * traveller's dateTo is optional and the actual reservation is defined by
 * duration, not by whatever dateTo (if any) they happened to say. */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return toIso(addDays(new Date(Date.UTC(y!, m! - 1, d!)), days));
}

/** Inclusive interval overlap (touching counts) — "dal 1 al 10" conflicts
 * with both "dal 1 al 3" and "dall'8 all'11" (Giuseppe, 2026-09-15: "le
 * intersezioni contano"). Only ever used as a heads-up disclosure, never to
 * block a booking — a traveller can be anywhere they like except two places
 * at once, so only DATES matter here, never destination. */
export function datesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/** Deterministic IT/EN date resolver. Calendar arithmetic is exactly the
 * kind of thing an LLM gets subtly wrong (verified live: Workers AI
 * Llama-3.3-70B returned "1970"/"1971" as the year despite an explicit
 * "today is 2026-09-14, never use 1970" instruction) — so the model is only
 * asked to lift the raw date phrase out of the sentence; resolving it to a
 * real calendar date happens here, in code, where it's testable. */
export function resolveDate(raw: string | null, now: Date = new Date()): string | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();

  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // "9/10/2026", "9-10-2026", "09.10.2026" — Italian/European convention
  // is day/month/year, not the US month/day/year (regression: "9/10/2026"
  // typed literally by a traveller was silently dropped, see
  // ARCHITECTURE.md for the live repro).
  const slashMatch = text.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\b/);
  if (slashMatch) {
    const day = Number(slashMatch[1]);
    const month = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return toIso(new Date(Date.UTC(year, month - 1, day)));
    }
  }

  if (/\boggi\b|\btoday\b/.test(text)) return toIso(now);
  if (/\bdomani\b|\btomorrow\b/.test(text)) return toIso(addDays(now, 1));
  if (/\bdopodomani\b|\bday after tomorrow\b/.test(text)) return toIso(addDays(now, 2));

  const inDays = text.match(/tra\s+(\d+)\s+giorni|in\s+(\d+)\s+days?/);
  if (inDays) return toIso(addDays(now, Number(inDays[1] ?? inDays[2])));
  const inWeeks = text.match(/tra\s+(\d+)\s+settiman|in\s+(\d+)\s+weeks?/);
  if (inWeeks) return toIso(addDays(now, Number(inWeeks[1] ?? inWeeks[2]) * 7));

  if (/prossimo\s+weekend|weekend\s+prossimo|prossimo\s+fine\s*settimana|next\s+weekend/.test(text)) {
    const day = now.getUTCDay(); // 0=Sun..6=Sat
    const offset = ((6 - day + 7) % 7) || 7; // next Saturday, always in the future
    return toIso(addDays(now, offset));
  }

  // "dal 15 al 21 settembre" / "15 to 21 September" — a date RANGE, where
  // the day textually adjacent to the month isn't necessarily the START
  // day (regression found live by Giuseppe, 2026-09-14: the generic
  // dayMonth pattern below isn't anchored to the start of the phrase, so
  // on "dal 15 al 21 settembre" it skips the "15" — not directly attached
  // to "settembre", "al 21" sits in between — and matches "21 settembre"
  // instead, silently resolving dateFrom to the wrong end of the range).
  // Tried first, before the generic single-day pattern, so a range phrase
  // always keeps its own first number as the day regardless of which one
  // ends up textually next to the month name.
  //
  // "(del|dal)" — verified live 2026-09-15 (sessionId
  // `60ff320a-...`): "il periodo DEL 16 al 22 settembre" hit this exact
  // same bug a second time — "del" ("of the period") is just as natural
  // as "dal" ("from") here and wasn't covered, so the phrase fell
  // through to the generic pattern below and again picked the wrong end
  // (22, not 16). This is exactly why the traveller saw a late,
  // confusing date renegotiation after already giving personal data:
  // the wrong day silently "matched" the wide availability window shown
  // at proposal time, only failing for real once the cart actually
  // opened for that specific (wrong) day.
  const itRange = text.match(
    new RegExp(`d(?:al|el)\\s+(\\d{1,2})\\s*(?:°|º)?\\s*al\\s+\\d{1,2}\\s*(?:°|º)?\\s*(?:di\\s+|d['’]\\s*)?(${MONTH_NAMES_PATTERN})(?:\\s+(\\d{4}))?`),
  );
  const enRange = text.match(
    new RegExp(`(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*to\\s+\\d{1,2}\\s*(?:st|nd|rd|th)?\\s+(${MONTH_NAMES_PATTERN})(?:,?\\s+(\\d{4}))?`),
  );
  const range = itRange ?? enRange;

  // "25 settembre" / "il 9 di ottobre" / "September 25th" / "25 September
  // 2027" — "di"/"d'" as a connector is common spoken/written Italian
  // ("il 9 di ottobre"), and day-before-or-after-month covers both IT
  // ("25 settembre") and EN ("September 25th") orderings.
  const dayMonth = text.match(
    new RegExp(`(\\d{1,2})\\s*(?:°|º|st|nd|rd|th)?\\s*(?:di\\s+|d['’]\\s*|of\\s+)?(${MONTH_NAMES_PATTERN})(?:\\s+(\\d{4}))?`),
  );
  const monthDay = text.match(
    new RegExp(`(${MONTH_NAMES_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`),
  );
  const m = range ?? dayMonth ?? (monthDay && [monthDay[0], monthDay[2], monthDay[1], monthDay[3]]);
  if (m) {
    const day = Number(m[1]);
    const month = MONTHS[m[2]!.toLowerCase()]!;
    let year = m[3] ? Number(m[3]) : now.getUTCFullYear();
    let candidate = new Date(Date.UTC(year, month - 1, day));
    if (!m[3] && candidate.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
      year += 1;
      candidate = new Date(Date.UTC(year, month - 1, day));
    }
    return toIso(candidate);
  }

  return null;
}

/** Pulls a bare month reference ("in June", "a giugno", "verso ottobre")
 * out of a date phrase that didn't resolve to an exact day — used to bias
 * candidate selection toward the right month instead of blindly offering
 * the earliest availability regardless of season (regression: live test,
 * "three days off in June" got offered a December date because
 * date_unspecified only ever looked at candidate.minDate). Returns a bare
 * month number 1-12 — matcher.ts resolves which actual year/date within a
 * given candidate's availability window, since that depends on the
 * candidate, not on this phrase alone. */
export function extractMonthHint(raw: string | null): number | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  const match = text.match(new RegExp(`\\b(${MONTH_NAMES_PATTERN})\\b`));
  if (!match) return null;
  return MONTHS[match[1]!.toLowerCase()]!;
}
