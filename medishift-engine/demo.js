/**
 * MediShift Engine — Demo
 *
 * Run with:  node medishift-engine/demo.js
 * (Node.js >= 14 required; uses ES modules via package.json "type":"module"
 *  OR run as:  node --input-type=module < medishift-engine/demo.js)
 *
 * This demo generates a May-2024 schedule for a small team and prints
 * the result to the console.
 */

import { generateSchedule, buildMonthCtx, SHIFT } from './engine.js';

/* ── Nurse roster ── */
const nurses = [
  { name: 'Nováková',    fte: 1.0 },
  { name: 'Haunerová',   fte: 1.0 },
  { name: 'Koudelková',  fte: 1.0 },
  { name: 'Krátká',      fte: 0.5 },
  { name: 'Abrahamová',  fte: 1.0 },
];

/* ── Month ── */
const MONTH = 5;
const YEAR  = 2024;
const ctx   = buildMonthCtx(MONTH, YEAR);

/* ── Per-day staffing requirements (KJ: CD + N) ── */
// Note: with KJ-only staffing, KJ_LIMITS.max violations are expected (informational).
// In production, add twoPCDMin / twoPNMin requirements to distribute load across 2P shifts
// and bring each nurse's KJ count within 5–7 per month.
const staffing = {};
for (let d = 1; d <= ctx.DAYS; d++) {
  const iso = ctx.dow[d];
  const isWE = iso === 6 || iso === 7;
  staffing[d] = {
    cdMin: isWE ? 1 : 1,
    nMin:  isWE ? 1 : 1,
  };
}

/* ── Manual requirements (locks) ── */
const requirements = [
  // Nováková: 2-týdenní dovolená na začátku měsíce
  ...Array.from({ length: 14 }, (_, i) => ({ name: 'Nováková', day: i + 1, value: 'X' })),
  // Haunerová: konkrétní den požadavek
  { name: 'Haunerová', day: 20, value: 'CD' },
  // Krátká: výjimečná noční
  { name: 'Krátká',    day: 10, value: 'N'  },
];

/* ── Generate ── */
const result = generateSchedule({ nurses, requirements, month: MONTH, year: YEAR, staffing });

/* ── Pretty-print schedule table ── */
const DOW_LABELS = ['', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const SHIFT_COLORS = {
  [SHIFT.CD]: '\x1b[36m',       // cyan
  [SHIFT.N]: '\x1b[35m',        // magenta
  [SHIFT.TWO_P_CD]: '\x1b[34m', // blue
  [SHIFT.TWO_P_N]:  '\x1b[34m', // blue
  [SHIFT.DOV]: '\x1b[33m',      // yellow
  [SHIFT.X]:   '\x1b[90m',      // grey
  [SHIFT.R]:   '\x1b[32m',      // green
  [SHIFT.OFF]: '\x1b[90m',      // grey
};
const RESET = '\x1b[0m';

function col(sh) {
  return `${SHIFT_COLORS[sh] ?? ''}${sh.padEnd(4)}${RESET}`;
}

// Header row
const headerDays = Array.from({ length: ctx.DAYS }, (_, i) => {
  const d = i + 1;
  return String(d).padStart(4);
}).join('');
console.log(`\n${'Sestra'.padEnd(15)} ${headerDays}`);

const dowRow = Array.from({ length: ctx.DAYS }, (_, i) => {
  const d = i + 1;
  return DOW_LABELS[ctx.dow[d]].padStart(4);
}).join('');
console.log(`${''.padEnd(15)} ${dowRow}`);
console.log('─'.repeat(16 + ctx.DAYS * 5));

for (const n of nurses) {
  const row = result.schedule[n.name].map(col).join(' ');
  console.log(`${n.name.padEnd(15)} ${row}`);
}

/* ── Stats ── */
console.log('\n── Statistiky ──────────────────────────────────────────────');
console.log('Sestra'.padEnd(16) + 'Práce'.padStart(8) + 'Cíl'.padStart(8) +
            'Celkem'.padStart(8) + 'Diff'.padStart(7) + 'KJ'.padStart(5) + 'DOV'.padStart(5));
console.log('─'.repeat(58));
for (const [nm, s] of Object.entries(result.stats)) {
  console.log(
    nm.padEnd(16) +
    `${s.norma}h`.padStart(8) +
    `${s.target}h`.padStart(8) +
    `${s.totalHours}h`.padStart(8) +
    `${s.diff >= 0 ? '+' : ''}${s.diff}h`.padStart(7) +
    String(s.kjDays).padStart(5) +
    String(s.dovDays).padStart(5)
  );
}

/* ── Violations ── */
if (result.violations.length === 0) {
  console.log('\n✅  Žádná porušení pravidel.');
} else {
  console.log(`\n⚠️  Porušení pravidel (${result.violations.length}):`);
  for (const v of result.violations) {
    console.log(`  [den ${v.day}] ${v.nurse} — ${v.rule} (směna: ${v.shift})`);
  }
}
