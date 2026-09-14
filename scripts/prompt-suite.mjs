#!/usr/bin/env node
// Prompt suite: sends real, previously-live-tested traveller utterances to
// the deployed agent and checks the *structured* NLU extraction
// (state.slots / state.language) against what a correct read of the
// sentence should be — not the reply text, which the LLM phrases
// differently every run by design.
//
// Scope, deliberately narrow: this tests interpret() (the AI-dependent
// NLU layer), which has NO automated coverage today (unlike matcher.ts /
// dates.ts / hofj/client.ts, which are unit-tested for free). It does NOT
// re-test booking/business logic — that's already covered deterministically
// elsewhere. Each case is one fresh conversation, one message wherever
// possible, to keep the call count (and therefore the cost) predictable.
//
// COSTS REAL MONEY: every case is 1-2 real turns against the live Worker,
// each turn calling interpret() + say() — real AI calls, billed against
// the Anthropic Haiku fallback the moment Workers AI's free daily quota
// is exhausted (it was, as of 2026-09-14 — see ARCHITECTURE.md). Default
// mode below is DRY RUN (prints the cases and the call count, calls
// nothing). Pass --run to actually hit the API.
//
// Usage:
//   node scripts/prompt-suite.mjs                # dry run, no cost
//   node scripts/prompt-suite.mjs --run           # runs for real
//   node scripts/prompt-suite.mjs --run --only=date   # filter by name substring

const BASE_URL = process.argv.find((a) => a.startsWith("--base="))?.slice("--base=".length)
  ?? "https://vela-trip-agent.gleonardi87.workers.dev";
const DO_RUN = process.argv.includes("--run");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? null;

function pad(n) {
  return String(n).padStart(2, "0");
}
function isoToday(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Each case: one fresh conversation. `messages` is usually length 1 to keep
// cost predictable (each message = ~2 AI calls: interpret() + say()).
// `expect(state)` returns a list of {field, ok, detail} — keep assertions
// to what a single message should have made unambiguous; don't assert on
// fields the sentence never touched.
const CASES = [
  {
    name: "date-range-dal-x-al-y",
    source: "sessionId 81992bfd-... / verify-regex-bug-01, 2026-09-14 — the day+month regex bug Giuseppe found",
    messages: ["Prenotami un weekend di Padel a Lanzarote dal 15 al 21 settembre, budget 2000 euro, siamo in 2"],
    expect: (s) => [
      check("sport", s.slots.sport === "padel"),
      check("city", s.slots.city?.toLowerCase().includes("lanzarote")),
      check("dateFrom ends -09-15 (not -09-21)", s.slots.dateFrom?.endsWith("-09-15")),
      check("dateTo ends -09-21", s.slots.dateTo?.endsWith("-09-21")),
      check("budget", s.slots.budget === 2000),
      check("adults", s.slots.adults === 2),
    ],
  },
  {
    name: "date-slash-format",
    source: "sessionId 81992bfd-..., 2026-09-14 — '9/10/2026' typed literally",
    messages: ["Vorrei prenotare del tennis per il 9/10/2026, budget 300 euro, sono da solo"],
    expect: (s) => [
      check("sport", s.slots.sport === "tennis"),
      check("dateFrom", s.slots.dateFrom === "2026-10-09"),
      check("budget", s.slots.budget === 300),
      check("adults=1 (da solo)", s.slots.adults === 1),
    ],
  },
  {
    name: "date-di-connector",
    source: "sessionId 81992bfd-..., 2026-09-14 — 'il 9 di ottobre' spoken connector",
    messages: ["Voglio giocare a tennis il 9 di ottobre, budget 300 euro, sono da solo"],
    expect: (s) => [check("dateFrom ends -10-09", s.slots.dateFrom?.endsWith("-10-09"))],
  },
  {
    name: "budget-illimitato-is-tier-not-number",
    source: "sessionId 81992bfd-..., 2026-09-14 — 'budget illimitato' must not become a fake number",
    messages: ["Voglio giocare a padel, budget illimitato, voglio il miglior insegnante possibile, siamo in 2"],
    expect: (s) => [
      check("budget stays null", s.slots.budget === null),
      check("budgetTier = high", s.slots.budgetTier === "high"),
      check("adults", s.slots.adults === 2),
    ],
  },
  {
    name: "vague-region-not-a-fake-city",
    source: "sessionId 81992bfd-..., 2026-09-14 — 'il miglior insegnante... in Nord Europa'",
    messages: ["Voglio il miglior insegnante di padel possibile, da qualche parte in Nord Europa, budget 1000 euro, siamo in 2"],
    expect: (s) => [
      check("city stays null/unresolved (not hallucinated as a real city)", !s.slots.city || s.slots.city.length < 3 || /nord|europa/i.test(s.slots.city)),
      check("budget", s.slots.budget === 1000),
    ],
  },
  {
    name: "english-multislot-target-journey",
    source: "target customer journey given by Giuseppe, verified live 2026-09-14 (verify-en-01)",
    messages: [
      "Vela, I have three days off in June. I want to play padel somewhere warm. Somewhere nice, but not crazy expensive. I am going with Francesca.",
    ],
    expect: (s) => [
      check("sport", s.slots.sport === "padel"),
      check("adults=2 (Francesca)", s.slots.adults === 2),
      check("budgetTier = mid", s.slots.budgetTier === "mid"),
      check("preferredMonth = 6 (June)", s.slots.preferredMonth === 6),
      check("language = inglese", /ingl/i.test(s.language ?? "")),
    ],
  },
  {
    name: "italian-full-slot-one-shot",
    source: "verify-stripe-01, 2026-09-14",
    messages: ["Voglio giocare a tennis a Roma il 25 settembre, budget 500 euro, siamo in 2"],
    expect: (s) => [
      check("sport", s.slots.sport === "tennis"),
      check("city", s.slots.city?.toLowerCase().includes("roma")),
      check("dateFrom ends -09-25", s.slots.dateFrom?.endsWith("-09-25")),
      check("budget", s.slots.budget === 500),
      check("adults", s.slots.adults === 2),
    ],
  },
  {
    name: "adults-counting-siamo-in-N",
    source: "prompt design rule in engine/ai.ts (INTERPRET_SYSTEM)",
    messages: ["Vogliamo giocare a padel a Milano, siamo in 4, budget 1500 euro"],
    expect: (s) => [check("adults=4", s.slots.adults === 4)],
  },
  {
    name: "adults-non-numerable-stays-null",
    source: "explicit prompt rule in engine/ai.ts — 'un gruppo di amici' without a number must NOT be guessed",
    messages: ["Vogliamo portare un gruppo di amici a giocare a padel a Torino, budget 1200 euro"],
    expect: (s) => [check("adults stays null (never guessed)", s.slots.adults === null)],
  },
  {
    name: "unrealistic-tiny-budget-still-extracted-correctly",
    source: "flagged as untested 2026-09-14 — the NUMBER should still parse right even if no product will ever match it",
    messages: ["Voglio giocare a tennis a Milano, budget 20 euro, siamo in 2"],
    expect: (s) => [check("budget=20 (extraction is right even though no real product will match)", s.slots.budget === 20)],
  },
  {
    name: "english-relative-date-in-N-days",
    source: "dates.ts English support, added 2026-09-14 — full pipeline check, not just the unit test",
    messages: ["I want to play tennis in Rome in 5 days, budget 400 euros, just me"],
    expect: (s) => [
      check("dateFrom", s.slots.dateFrom === isoToday(5)),
      check("adults=1 (just me)", s.slots.adults === 1),
    ],
  },
  {
    name: "mid-language-switch",
    source: "flagged as untested 2026-09-14 — language sticky-but-updating mid conversation",
    messages: [
      "Voglio giocare a tennis a Roma, budget 500 euro",
      "Actually, we are 3 people, let's speak English from now on",
    ],
    expect: (s) => [
      check("adults=3 (from the English follow-up)", s.slots.adults === 3),
      check("language switched to English", /ingl|english/i.test(s.language ?? "")),
    ],
  },
];

function check(field, ok) {
  return { field, ok: !!ok };
}

async function postMessage(sessionId, text) {
  const res = await fetch(`${BASE_URL}/api/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function runCase(c) {
  const sessionId = `suite-${c.name}-${Date.now()}`;
  let last;
  for (const text of c.messages) {
    last = await postMessage(sessionId, text);
  }
  const results = c.expect(last.state);
  return { name: c.name, sessionId, results, reply: last.reply };
}

function printPlan() {
  const totalMessages = CASES.reduce((n, c) => n + c.messages.length, 0);
  console.log(`Prompt suite: ${CASES.length} cases, ${totalMessages} total messages.`);
  console.log(`Each message ≈ 1-2 real AI calls (interpret + say) — roughly ${totalMessages * 2} calls if the run happens to hit the Haiku fallback (Workers AI's free daily quota was already exhausted once today, see ARCHITECTURE.md).\n`);
  for (const c of CASES) {
    console.log(`- ${c.name}  [${c.messages.length} msg]`);
    console.log(`  source: ${c.source}`);
  }
  console.log(`\nDry run only — nothing was called. Re-run with --run to actually spend real API calls.`);
}

async function main() {
  const cases = ONLY ? CASES.filter((c) => c.name.includes(ONLY)) : CASES;
  if (!DO_RUN) {
    printPlan();
    return;
  }

  console.log(`Running ${cases.length} case(s) against ${BASE_URL} — this costs real API calls.\n`);
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    try {
      const { sessionId, results, reply } = await runCase(c);
      const caseOk = results.every((r) => r.ok);
      console.log(`${caseOk ? "✅" : "❌"} ${c.name}  (sessionId: ${sessionId})`);
      for (const r of results) {
        if (!r.ok) console.log(`    ✗ ${r.field}`);
      }
      if (!caseOk) console.log(`    reply was: ${JSON.stringify(reply)}`);
      caseOk ? pass++ : fail++;
    } catch (err) {
      console.log(`❌ ${c.name}  (threw: ${err instanceof Error ? err.message : err})`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed, out of ${cases.length}.`);
  if (fail > 0) process.exitCode = 1;
}

main();
