/* ============================================================================
   MediShift Engine — FINAL (clean start)
   ============================================================================
   KJ shifts (count for KJ staffing): CD, N
   2P shifts (count for norma, NOT for KJ staffing): 2PCD, 2PN
   R (RZ): only by requirement/manual, counts for norma, NOT for KJ staffing
   OFF: X, -, PN, OCR/OČR ...
   DOV: counts 11.5h AND reduces targetHours (161*fte - 11.5*dovDays)

   HARD:
   - N -> CD forbidden always
   - X day forbids CD/N; also day BEFORE X forbids N
   - max 2 consecutive work-days, except pattern whitelist:
       PAT_A: NNN (Fri+Sat+Sun)
       PAT_B: CDNN (Fri CD + Sat N + Sun N)
       PAT_C: CDCDN (Sat CD + Sun CD + Mon N)

   Weekend:
   - Usually full (Sat+Sun for same nurse)
   - Emergency split for N allowed (Sat N by one, Sun N by another)
   - Sat and Sun counts can differ (e.g., Sat 6, Sun 5)

   B Friday:
   - Often prefer Fri CD (CDNN) instead of Fri N, because Koudelkova covers 2–3 Fri N.
   - Fri-only N used only if needed to reach Friday N min.
============================================================================ */

export const SHIFT = {
  CD: 'CD',
  N: 'N',
  TWO_P_CD: '2PCD',
  TWO_P_N: '2PN',
  R: 'R',
  X: 'X',
  DOV: 'DOV',
  OFF: '-', // internal
};

const HOURS_NORMA = {
  [SHIFT.CD]: 11.5,
  [SHIFT.N]: 11.5,
  [SHIFT.TWO_P_CD]: 11.5,
  [SHIFT.TWO_P_N]: 11.5,
  [SHIFT.DOV]: 11.5,
  [SHIFT.R]: 7.5,
  [SHIFT.X]: 0,
  [SHIFT.OFF]: 0,
};

const DEFAULT_TARGET_FULL = 161; // hours
const KJ_LIMITS = { min: 5, max: 7, maxExp: 5, maxExpEx: 6 };
const EMERGENCY_SPLIT_WEEKEND_N = true;

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function normHoursOf(sh) { return HOURS_NORMA[sh] ?? 0; }

function isKJ(sh) { return sh === SHIFT.CD || sh === SHIFT.N; }
function is2P(sh) { return sh === SHIFT.TWO_P_CD || sh === SHIFT.TWO_P_N; }
function isOff(sh) {
  return sh === SHIFT.X || sh === SHIFT.OFF || sh === SHIFT.DOV ||
         sh === 'PN' || sh === 'OČR' || sh === 'OCR';
}
function isWork(sh) {
  return sh === SHIFT.CD || sh === SHIFT.N ||
         sh === SHIFT.TWO_P_CD || sh === SHIFT.TWO_P_N || sh === SHIFT.R;
}

function normalizeShift(v) {
  const s = (v || '').toString().trim();
  const u = s.toUpperCase();

  if (u === 'D' || u === 'DEN' || u === 'DENNI' || u === 'DENNÍ') return SHIFT.CD;
  if (u === 'N' || u === 'NOC' || u === 'NOCNI' || u === 'NOČNÍ') return SHIFT.N;
  if (u === 'R' || u === 'RZ') return SHIFT.R;
  if (u === '2PCD') return SHIFT.TWO_P_CD;
  if (u === '2PN') return SHIFT.TWO_P_N;
  if (u === 'DOV' || u === 'DOVOLENA' || u === 'DOVOLENÁ') return SHIFT.DOV;
  if (u === 'X' || u === 'VOLNO') return SHIFT.X;
  if (u === '-' || u === '') return SHIFT.OFF;

  // PN/OCR etc pass-through
  return s;
}

function buildMonthCtx(month, year) {
  const DAYS = new Date(year, month, 0).getDate();
  const dow = {}; // 1..DAYS -> 1..7 (Po..Ne)
  const isFri = {}, isSat = {}, isSun = {}, isWeekend = {};

  for (let d = 1; d <= DAYS; d++) {
    const jsDay = new Date(year, month - 1, d).getDay(); // 0=Sun..6=Sat
    const iso = jsDay === 0 ? 7 : jsDay;
    dow[d] = iso;
    isFri[d] = iso === 5;
    isSat[d] = iso === 6;
    isSun[d] = iso === 7;
    isWeekend[d] = iso === 6 || iso === 7;
  }

  const weekends = [];
  let idx = 0;
  for (let d = 1; d <= DAYS; d++) {
    if (isSat[d] && d + 1 <= DAYS && isSun[d + 1]) {
      idx++;
      const sat = d, sun = d + 1;
      const fri = (sat - 1 >= 1 && isFri[sat - 1]) ? (sat - 1) : null;
      weekends.push({ idx, fri, sat, sun });
    }
  }

  return { month, year, DAYS, dow, isFri, isSat, isSun, isWeekend, weekends };
}

function createEmptyState(nurses, ctx) {
  const sc = {}, meta = {};
  for (const n of nurses) {
    sc[n.name] = Array(ctx.DAYS).fill(SHIFT.OFF);
    meta[n.name] = Array(ctx.DAYS).fill(null).map(() => ({}));
  }
  return { sc, meta };
}

/** SPECIALS / CONSTRAINTS */
function isKoudelkova(nm) { return nm.toLowerCase().includes('koudelkov'); }
function isAbrahamOrKubist(nm) {
  const x = nm.toLowerCase();
  return x.includes('abraham') || x.includes('kubišt') || x.includes('kubist');
}
function isHaunerova(nm) { return nm.toLowerCase().includes('hauner'); }

function getPersonConstraints(nurse) {
  const nm = nurse.name.toLowerCase();
  return {
    noFriN: nm.includes('hauner'),     // Haunerová: hard no Friday N
    avoidFriCD: nm.includes('hauner'), // Haunerová: soft avoid Friday CD
  };
}

/**
 * Lock helper (pattern tagging).
 * @param {boolean} [hard=false] – hard locks (requirements, pattern weekends) prevent
 *   removal by balanceNorma; soft locks (auto KJ/2P fills) can be cleared.
 */
function lockShift(st, nm, day, value, tag, hard = false) {
  if (day == null) return true;
  const m = st.meta[nm][day - 1];
  if (m?.lock) return st.sc[nm][day - 1] === value;
  st.sc[nm][day - 1] = value;
  if (hard) m.lock = true;
  if (tag) m.tag = tag;
  return true;
}

/** Set a slot without any lock flag (soft-assign, easily removable). */
function softAssign(st, nm, day, value, tag) {
  if (day == null) return;
  const m = st.meta[nm][day - 1];
  if (m?.lock) return; // hard-locked slots are immutable
  st.sc[nm][day - 1] = value;
  if (tag) m.tag = tag;
}

/** Weekend identification helpers */
function isFullWeekendWorked(sc, nm, we) {
  const sat = sc[nm][we.sat - 1];
  const sun = sc[nm][we.sun - 1];
  return isWork(sat) && isWork(sun);
}
function fullWeekendType(sc, nm, we) {
  if (!isFullWeekendWorked(sc, nm, we)) return null;
  const sat = sc[nm][we.sat - 1], sun = sc[nm][we.sun - 1];
  const satK = (sat === SHIFT.CD || sat === SHIFT.N) ? sat : null;
  const sunK = (sun === SHIFT.CD || sun === SHIFT.N) ? sun : null;
  if (satK === SHIFT.N || sunK === SHIFT.N) return SHIFT.N;
  if (satK === SHIFT.CD && sunK === SHIFT.CD) return SHIFT.CD;
  return null;
}

/** Prev-month facts (optional input) */
function getPrevMonthFacts(prevSc, prevCtx, nm) {
  const out = { hadLastFullWeekend: false, lastFullWeekendType: null, lastDayShift: null };
  if (!prevSc || !prevCtx || !prevSc[nm]) return out;
  out.lastDayShift = prevSc[nm][prevCtx.DAYS - 1] || null;
  for (let i = prevCtx.weekends.length - 1; i >= 0; i--) {
    const we = prevCtx.weekends[i];
    if (isFullWeekendWorked(prevSc, nm, we)) {
      out.hadLastFullWeekend = true;
      out.lastFullWeekendType = fullWeekendType(prevSc, nm, we);
      break;
    }
  }
  return out;
}

/* ========================================================================
   STEP 1 — Requirements
   ======================================================================== */
function applyRequirements(st, ctx, reqs) {
  for (const r of reqs) {
    const nm = r.name;
    if (!st.sc[nm]) continue;
    const d = r.day;
    if (d < 1 || d > ctx.DAYS) continue;
    const v = normalizeShift(r.value);

    st.sc[nm][d - 1] = v;
    st.meta[nm][d - 1].lock = true; // requirements are always hard locks

    // day before X cannot be N
    if (v === SHIFT.X) {
      if (d - 1 >= 1) st.meta[nm][d - 2].banNightBeforeX = true;
    }
  }
}

/* ========================================================================
   STEP 2 — Auto DOV from long X runs (full FTE only)
   ======================================================================== */
function applyAutoDovFromLongOff(st, nurses, ctx) {
  for (const n of nurses) {
    if (n.fte < 0.9) continue;
    const nm = n.name;
    const arr = st.sc[nm];
    let runStart = -1;

    for (let i = 0; i <= ctx.DAYS; i++) {
      const v = i < ctx.DAYS ? arr[i] : null;
      const isX = v === SHIFT.X;

      if (isX && runStart < 0) {
        runStart = i;
      } else if (!isX && runStart >= 0) {
        const runLen = i - runStart;
        // Convert weekday X days in a run >= 5 to DOV
        if (runLen >= 5) {
          for (let j = runStart; j < i; j++) {
            const dayNum = j + 1;
            const iso = ctx.dow[dayNum];
            // Convert weekday X to DOV even if locked (auto-DOV is a
            // special pass that fires regardless of how the X was set)
            if (iso <= 5) {
              arr[j] = SHIFT.DOV;
              st.meta[nm][j].autoDov = true;
            }
          }
        }
        runStart = -1;
      }
    }
  }
}

/* ========================================================================
   HARD CONSTRAINT HELPERS
   ======================================================================== */

/**
 * Returns true if the slot (nm, day) is available to assign to the given shift.
 * Hard rules checked:
 *   - Already locked
 *   - Slot already has a non-OFF value
 *   - X on that day → forbid CD/N/2P
 *   - banNightBeforeX (day before X) → forbid N
 *   - N→CD rule: if previous day is N, forbid CD (backward)
 *   - N→CD rule: if NEXT day already has CD, forbid N (forward)
 */
function canAssign(st, ctx, nm, day, shift) {
  const i = day - 1;
  const m = st.meta[nm][i];
  if (m.lock) return false;

  const cur = st.sc[nm][i];
  if (cur !== SHIFT.OFF) return false;

  // X on this day → no work
  if (m.banWork) return false;
  if (cur === SHIFT.X) return false;

  // banNightBeforeX
  if (m.banNightBeforeX && shift === SHIFT.N) return false;

  // N→CD rule (backward): if previous day is N, forbid CD
  if (shift === SHIFT.CD && day >= 2 && st.sc[nm][day - 2] === SHIFT.N) return false;

  // N→CD rule (forward): if next day already has CD, forbid N
  if (shift === SHIFT.N && day < ctx.DAYS && st.sc[nm][day] === SHIFT.CD) return false;

  return true;
}

/**
 * Count consecutive work days ending at `day` (1-based).
 * Returns the run length.
 */
function consWorkEndingAt(sc, nm, day) {
  let run = 0;
  for (let d = day; d >= 1; d--) {
    if (isWork(sc[nm][d - 1])) run++;
    else break;
  }
  return run;
}

/**
 * Whitelist patterns that allow >2 consecutive work days.
 * Returns true if placing `shift` on `day` is covered by a whitelist pattern.
 *
 * PAT_A : NNN on Fri+Sat+Sun
 * PAT_B : CDNN on Fri CD, Sat N, Sun N
 * PAT_C : CDCDN on Sat CD, Sun CD, Mon N
 */
function isPatternWhitelisted(sc, ctx, nm, day, shift) {
  const iso = ctx.dow[day];

  // PAT_A: NNN – Fri+Sat+Sun all N
  if (shift === SHIFT.N) {
    if (iso === 7) { // Sun N → check Sat N + Fri N
      const sat = day - 1, fri = day - 2;
      if (sat >= 1 && ctx.dow[sat] === 6 && sc[nm][sat - 1] === SHIFT.N &&
          fri >= 1 && ctx.dow[fri] === 5 && sc[nm][fri - 1] === SHIFT.N) return true;
    }
    if (iso === 6) { // Sat N → check Fri N (partial coverage for 2-consecutive)
      const fri = day - 1;
      if (fri >= 1 && ctx.dow[fri] === 5 && sc[nm][fri - 1] === SHIFT.N) return true;
    }
  }

  // PAT_B: CDNN – Fri CD, Sat N, Sun N
  if (shift === SHIFT.N) {
    if (iso === 7) { // Sun N → check Sat N + Fri CD
      const sat = day - 1, fri = day - 2;
      if (sat >= 1 && ctx.dow[sat] === 6 && sc[nm][sat - 1] === SHIFT.N &&
          fri >= 1 && ctx.dow[fri] === 5 && sc[nm][fri - 1] === SHIFT.CD) return true;
    }
    if (iso === 6) { // Sat N → check Fri CD
      const fri = day - 1;
      if (fri >= 1 && ctx.dow[fri] === 5 && sc[nm][fri - 1] === SHIFT.CD) return true;
    }
  }
  if (shift === SHIFT.CD && iso === 5) {
    // Fri CD — PAT_B allowed as the first step (2 work days still ok before)
  }

  // PAT_C: CDCDN – Sat CD, Sun CD, Mon N
  if (shift === SHIFT.N && iso === 1) { // Mon N
    const sun = day - 1, sat = day - 2;
    if (sun >= 1 && ctx.dow[sun] === 7 && sc[nm][sun - 1] === SHIFT.CD &&
        sat >= 1 && ctx.dow[sat] === 6 && sc[nm][sat - 1] === SHIFT.CD) return true;
  }

  return false;
}

/**
 * Check whether placing `shift` on `day` for `nm` violates the
 * max-2-consecutive-work-days rule (considering pattern whitelist).
 * Checks bidirectionally: existing work-days before AND after `day`.
 */
function violatesConsecutiveRule(sc, ctx, nm, day, shift) {
  if (!isWork(shift)) return false;

  const runBefore = consWorkEndingAt(sc, nm, day - 1);

  // Count forward run (already-assigned work days immediately after `day`)
  let runAfter = 0;
  const DAYS = sc[nm].length;
  for (let d = day + 1; d <= DAYS; d++) {
    if (isWork(sc[nm][d - 1])) runAfter++;
    else break;
  }

  const totalRun = runBefore + 1 + runAfter;
  if (totalRun <= 2) return false;

  // Violation unless a whitelist pattern covers the END of this run
  const endDay = day + runAfter;
  const endShift = runAfter > 0 ? sc[nm][endDay - 1] : shift;
  if (isPatternWhitelisted(sc, ctx, nm, endDay, endShift)) return false;

  // Also check if the START is covered (for incomplete patterns being built)
  if (isPatternWhitelisted(sc, ctx, nm, day, shift)) return false;

  return true;
}

/* ========================================================================
   STEP 3 — Weekend assignment
   ======================================================================== */

/**
 * Assign weekend shifts (Sat, Sun, and optionally Fri for CDNN pattern).
 * Strategy:
 *   - For each weekend, collect per-day staffing needs.
 *   - Prefer full weekends (same nurse works both Sat+Sun).
 *   - Prefer KJ night weekends (N on Sat+Sun) or CD on Sat+Sun.
 *   - Koudelkova: can cover Fri N, preferred for it.
 *   - Haunerová: hard no Fri N, soft avoid Fri CD.
 *
 * @param {object} st - schedule state
 * @param {Array}  nurses
 * @param {object} ctx - month context
 * @param {object} staffing - { [day]: { cdMin, nMin, twoPCDMin, twoPNMin } }
 */
function assignWeekends(st, nurses, ctx, staffing) {
  const { sc, meta } = st;

  for (const we of ctx.weekends) {
    const { fri, sat, sun } = we;

    const satStaff = staffing[sat] || {};
    const sunStaff = staffing[sun] || {};
    const friStaff = fri ? (staffing[fri] || {}) : {};

    // How many KJ (CD+N) needed each day
    const satNMin = satStaff.nMin || 0;
    const sunNMin = sunStaff.nMin || 0;
    const satCDMin = satStaff.cdMin || 0;
    const sunCDMin = sunStaff.cdMin || 0;
    const friCDMin = friStaff.cdMin || 0;
    const friNMin = friStaff.nMin || 0;

    // Eligible nurses for this weekend (not already locked on Sat or Sun)
    const available = nurses.filter(n => {
      const nm = n.name;
      const satFree = !meta[nm][sat - 1].lock && sc[nm][sat - 1] === SHIFT.OFF;
      const sunFree = !meta[nm][sun - 1].lock && sc[nm][sun - 1] === SHIFT.OFF;
      return satFree || sunFree;
    });

    // Sort by fewest total assigned shifts so far (fair distribution)
    available.sort((a, b) => {
      const aW = sc[a.name].filter(isWork).length;
      const bW = sc[b.name].filter(isWork).length;
      return aW - bW;
    });

    // --- Assign N weekends (KJ) ---
    // Try to pair full Sat N + Sun N to same nurse
    let satNAssigned = countDayShift(sc, sat, SHIFT.N);
    let sunNAssigned = countDayShift(sc, sun, SHIFT.N);

    for (const n of available) {
      if (satNAssigned >= satNMin && sunNAssigned >= sunNMin) break;
      const nm = n.name;
      const pc = getPersonConstraints(n);

      const satFree = !meta[nm][sat - 1].lock && sc[nm][sat - 1] === SHIFT.OFF;
      const sunFree = !meta[nm][sun - 1].lock && sc[nm][sun - 1] === SHIFT.OFF;
      if (!satFree && !sunFree) continue;

      // Try full N weekend (Sat+Sun N)
      const canSatN = satFree && !violatesConsecutiveRule(sc, ctx, nm, sat, SHIFT.N) &&
                      canAssign(st, ctx, nm, sat, SHIFT.N);
      const canSunN = sunFree && !violatesConsecutiveRule(sc, ctx, nm, sun, SHIFT.N) &&
                      canAssign(st, ctx, nm, sun, SHIFT.N);

      if (satNAssigned < satNMin && sunNAssigned < sunNMin && canSatN && canSunN) {
        // Check Fri: prefer CDNN pattern if Fri is available
        if (fri && !meta[nm][fri - 1].lock && sc[nm][fri - 1] === SHIFT.OFF &&
            !pc.noFriN && isKoudelkova(nm)) {
          // Koudelkova: Fri N + Sat N + Sun N = NNN (PAT_A)
          if (!violatesConsecutiveRule(sc, ctx, nm, fri, SHIFT.N) &&
              canAssign(st, ctx, nm, fri, SHIFT.N)) {
            lockShift(st, nm, fri, SHIFT.N, 'PAT_A_fri', true);
          }
        } else if (fri && !meta[nm][fri - 1].lock && sc[nm][fri - 1] === SHIFT.OFF &&
                   !pc.avoidFriCD &&
                   !violatesConsecutiveRule(sc, ctx, nm, fri, SHIFT.CD) &&
                   canAssign(st, ctx, nm, fri, SHIFT.CD)) {
          // CDNN pattern: Fri CD + Sat N + Sun N
          lockShift(st, nm, fri, SHIFT.CD, 'PAT_B_fri', true);
        }
        lockShift(st, nm, sat, SHIFT.N, 'weekend_N_sat', true);
        lockShift(st, nm, sun, SHIFT.N, 'weekend_N_sun', true);
        satNAssigned++;
        sunNAssigned++;
        continue;
      }

      // Emergency split: Sat N only or Sun N only
      if (EMERGENCY_SPLIT_WEEKEND_N) {
        if (satNAssigned < satNMin && canSatN) {
          lockShift(st, nm, sat, SHIFT.N, 'split_N_sat', true);
          satNAssigned++;
        } else if (sunNAssigned < sunNMin && canSunN) {
          lockShift(st, nm, sun, SHIFT.N, 'split_N_sun', true);
          sunNAssigned++;
        }
      }
    }

    // --- Assign CD weekends ---
    let satCDAssigned = countDayShift(sc, sat, SHIFT.CD);
    let sunCDAssigned = countDayShift(sc, sun, SHIFT.CD);

    for (const n of available) {
      if (satCDAssigned >= satCDMin && sunCDAssigned >= sunCDMin) break;
      const nm = n.name;
      const satFree = !meta[nm][sat - 1].lock && sc[nm][sat - 1] === SHIFT.OFF;
      const sunFree = !meta[nm][sun - 1].lock && sc[nm][sun - 1] === SHIFT.OFF;
      if (!satFree && !sunFree) continue;

      const canSatCD = satFree && !violatesConsecutiveRule(sc, ctx, nm, sat, SHIFT.CD) &&
                       canAssign(st, ctx, nm, sat, SHIFT.CD);
      const canSunCD = sunFree && !violatesConsecutiveRule(sc, ctx, nm, sun, SHIFT.CD) &&
                       canAssign(st, ctx, nm, sun, SHIFT.CD);

      if (satCDAssigned < satCDMin && sunCDAssigned < sunCDMin && canSatCD && canSunCD) {
        // Check for CDCDN: Sat CD + Sun CD + Mon N
        const mon = sun + 1;
        if (mon <= ctx.DAYS && ctx.dow[mon] === 1 &&
            !meta[nm][mon - 1].lock && sc[nm][mon - 1] === SHIFT.OFF &&
            !violatesConsecutiveRule(sc, ctx, nm, mon, SHIFT.N) &&
            canAssign(st, ctx, nm, mon, SHIFT.N)) {
          lockShift(st, nm, sat, SHIFT.CD, 'PAT_C_sat', true);
          lockShift(st, nm, sun, SHIFT.CD, 'PAT_C_sun', true);
          lockShift(st, nm, mon, SHIFT.N, 'PAT_C_mon', true);
        } else {
          lockShift(st, nm, sat, SHIFT.CD, 'weekend_CD_sat', true);
          lockShift(st, nm, sun, SHIFT.CD, 'weekend_CD_sun', true);
        }
        satCDAssigned++;
        sunCDAssigned++;
        continue;
      }

      // Single-day fallback
      if (satCDAssigned < satCDMin && canSatCD) {
        lockShift(st, nm, sat, SHIFT.CD, 'weekend_CD_sat', true);
        satCDAssigned++;
      } else if (sunCDAssigned < sunCDMin && canSunCD) {
        lockShift(st, nm, sun, SHIFT.CD, 'weekend_CD_sun', true);
        sunCDAssigned++;
      }
    }

    // --- Friday KJ (if weekends have Fri) ---
    if (fri) {
      let friCDAssigned = countDayShift(sc, fri, SHIFT.CD);
      let friNAssigned = countDayShift(sc, fri, SHIFT.N);

      const friAvail = nurses.filter(n => {
        const nm = n.name;
        return !meta[nm][fri - 1].lock && sc[nm][fri - 1] === SHIFT.OFF;
      });
      friAvail.sort((a, b) =>
        sc[a.name].filter(isWork).length - sc[b.name].filter(isWork).length
      );

      for (const n of friAvail) {
        if (friCDAssigned >= friCDMin && friNAssigned >= friNMin) break;
        const nm = n.name;
        const pc = getPersonConstraints(n);

        // Prefer CD on Friday (CDNN preferred over N-only on Fri)
        if (friCDAssigned < friCDMin && !pc.avoidFriCD &&
            !violatesConsecutiveRule(sc, ctx, nm, fri, SHIFT.CD) &&
            canAssign(st, ctx, nm, fri, SHIFT.CD)) {
          lockShift(st, nm, fri, SHIFT.CD, 'fri_CD', true);
          friCDAssigned++;
        } else if (friNAssigned < friNMin && !pc.noFriN &&
                   !violatesConsecutiveRule(sc, ctx, nm, fri, SHIFT.N) &&
                   canAssign(st, ctx, nm, fri, SHIFT.N)) {
          lockShift(st, nm, fri, SHIFT.N, 'fri_N', true);
          friNAssigned++;
        }
      }
    }
  }
}

/** Count how many nurses have the given shift on a particular day */
function countDayShift(sc, day, shift) {
  return Object.values(sc).filter(arr => arr[day - 1] === shift).length;
}

/* ========================================================================
   STEP 4 — Fill KJ (CD/N) weekday shifts
   ======================================================================== */

function fillKJDays(st, nurses, ctx, staffing) {
  const { sc } = st;

  for (let d = 1; d <= ctx.DAYS; d++) {
    if (ctx.isWeekend[d]) continue; // Already handled in step 3

    const dayStaff = staffing[d] || {};
    const cdMin = dayStaff.cdMin || 0;
    const nMin = dayStaff.nMin || 0;

    let cdAssigned = countDayShift(sc, d, SHIFT.CD);
    let nAssigned = countDayShift(sc, d, SHIFT.N);

    if (cdAssigned >= cdMin && nAssigned >= nMin) continue;

    // Sort by fewest norma hours so far (fair distribution)
    const eligible = nurses
      .filter(n => sc[n.name][d - 1] === SHIFT.OFF && !st.meta[n.name][d - 1].lock)
      .sort((a, b) => countNormaHours(sc, a.name, ctx) - countNormaHours(sc, b.name, ctx));

    for (const n of eligible) {
      if (cdAssigned >= cdMin && nAssigned >= nMin) break;
      const nm = n.name;
      const pc = getPersonConstraints(n);
      const tgt = targetHours(n, sc, ctx);
      const curHours = countNormaHours(sc, nm, ctx);
      if (curHours >= tgt) continue; // Already at or over target

      if (cdAssigned < cdMin &&
          !violatesConsecutiveRule(sc, ctx, nm, d, SHIFT.CD) &&
          canAssign(st, ctx, nm, d, SHIFT.CD)) {
        softAssign(st, nm, d, SHIFT.CD, 'kj_cd');
        cdAssigned++;
      } else if (nAssigned < nMin &&
                 (!pc.noFriN || !ctx.isFri[d]) &&
                 !violatesConsecutiveRule(sc, ctx, nm, d, SHIFT.N) &&
                 canAssign(st, ctx, nm, d, SHIFT.N)) {
        softAssign(st, nm, d, SHIFT.N, 'kj_n');
        nAssigned++;
      }
    }
  }
}

/* ========================================================================
   STEP 5 — Fill 2P shifts (2PCD / 2PN)
   ======================================================================== */

function fill2P(st, nurses, ctx, staffing) {
  const { sc } = st;

  for (let d = 1; d <= ctx.DAYS; d++) {
    const dayStaff = staffing[d] || {};
    const twoPCDMin = dayStaff.twoPCDMin || 0;
    const twoPNMin = dayStaff.twoPNMin || 0;

    let twoPCDAssigned = countDayShift(sc, d, SHIFT.TWO_P_CD);
    let twoPNAssigned = countDayShift(sc, d, SHIFT.TWO_P_N);

    if (twoPCDAssigned >= twoPCDMin && twoPNAssigned >= twoPNMin) continue;

    const eligible = nurses
      .filter(n => sc[n.name][d - 1] === SHIFT.OFF && !st.meta[n.name][d - 1].lock)
      .sort((a, b) => countNormaHours(sc, a.name, ctx) - countNormaHours(sc, b.name, ctx));

    for (const n of eligible) {
      if (twoPCDAssigned >= twoPCDMin && twoPNAssigned >= twoPNMin) break;
      const nm = n.name;
      const tgt = targetHours(n, sc, ctx);
      const curHours = countNormaHours(sc, nm, ctx);
      if (curHours >= tgt) continue;

      if (twoPCDAssigned < twoPCDMin &&
          !violatesConsecutiveRule(sc, ctx, nm, d, SHIFT.TWO_P_CD) &&
          canAssign(st, ctx, nm, d, SHIFT.TWO_P_CD)) {
        softAssign(st, nm, d, SHIFT.TWO_P_CD, '2p_cd');
        twoPCDAssigned++;
      } else if (twoPNAssigned < twoPNMin &&
                 !violatesConsecutiveRule(sc, ctx, nm, d, SHIFT.TWO_P_N) &&
                 canAssign(st, ctx, nm, d, SHIFT.TWO_P_N)) {
        softAssign(st, nm, d, SHIFT.TWO_P_N, '2p_n');
        twoPNAssigned++;
      }
    }
  }
}

/* ========================================================================
   STEP 6 — Norma balance
   ======================================================================== */

function countDovDays(sc, nm, ctx) {
  let count = 0;
  for (let d = 1; d <= ctx.DAYS; d++) {
    if (sc[nm][d - 1] === SHIFT.DOV) count++;
  }
  return count;
}

function targetHours(nurse, sc, ctx) {
  const base = DEFAULT_TARGET_FULL * nurse.fte;
  const dovDays = countDovDays(sc, nurse.name, ctx);
  return Math.max(0, base - HOURS_NORMA[SHIFT.DOV] * dovDays);
}

function countNormaHours(sc, nm, ctx) {
  let hours = 0;
  for (let d = 1; d <= ctx.DAYS; d++) {
    hours += normHoursOf(sc[nm][d - 1]);
  }
  return hours;
}

/**
 * Balance norma: add or remove SOFT-assigned shifts to approach target hours.
 * Hard-locked slots (requirements, weekend patterns) are never touched.
 * Priority: prefer CD on weekdays; only add N when CD is exhausted.
 */
function balanceNorma(st, nurses, ctx) {
  const { sc } = st;

  const isSoftTag = tag => !tag || tag.startsWith('kj_') || tag.startsWith('2p_') || tag.startsWith('balance_');

  for (const n of nurses) {
    const nm = n.name;
    const target = targetHours(n, sc, ctx);

    // --- Remove excess hours ---
    for (let d = 1; d <= ctx.DAYS && countNormaHours(sc, nm, ctx) > target + 0.5; d++) {
      const sh = sc[nm][d - 1];
      if (!isWork(sh)) continue;
      const m = st.meta[nm][d - 1];
      if (m.lock) continue;                // hard-locked
      if (!isSoftTag(m.tag)) continue;     // pattern-locked weekend etc.
      sc[nm][d - 1] = SHIFT.OFF;
      delete m.tag;
    }

    // --- Add missing hours ---
    for (let d = 1; d <= ctx.DAYS && countNormaHours(sc, nm, ctx) < target - 0.5; d++) {
      if (ctx.isWeekend[d]) continue;
      if (!canAssign(st, ctx, nm, d, SHIFT.CD)) continue;
      if (violatesConsecutiveRule(sc, ctx, nm, d, SHIFT.CD)) continue;
      softAssign(st, nm, d, SHIFT.CD, 'balance_add_cd');
    }
    for (let d = 1; d <= ctx.DAYS && countNormaHours(sc, nm, ctx) < target - 0.5; d++) {
      const pc = getPersonConstraints(n);
      if (pc.noFriN && ctx.isFri[d]) continue;
      if (!canAssign(st, ctx, nm, d, SHIFT.N)) continue;
      if (violatesConsecutiveRule(sc, ctx, nm, d, SHIFT.N)) continue;
      softAssign(st, nm, d, SHIFT.N, 'balance_add_n');
    }
  }
}

/* ========================================================================
   STEP 7 — Validate constraints (collect violations, non-destructive)
   ======================================================================== */

function validateConstraints(st, nurses, ctx) {
  const violations = [];

  for (const n of nurses) {
    const nm = n.name;
    const arr = st.sc[nm];

    for (let d = 1; d <= ctx.DAYS; d++) {
      const sh = arr[d - 1];

      // N→CD rule
      if (sh === SHIFT.CD && d >= 2 && arr[d - 2] === SHIFT.N) {
        violations.push({ nurse: nm, day: d, rule: 'N_before_CD', shift: sh });
      }

      // X day has work
      if (st.meta[nm][d - 1].lock && sh === SHIFT.X && isWork(sh)) {
        violations.push({ nurse: nm, day: d, rule: 'X_has_work', shift: sh });
      }

      // banNightBeforeX violated
      if (st.meta[nm][d - 1].banNightBeforeX && sh === SHIFT.N) {
        violations.push({ nurse: nm, day: d, rule: 'N_before_X', shift: sh });
      }

      // Haunerová: no Fri N
      if (isHaunerova(nm) && ctx.isFri[d] && sh === SHIFT.N) {
        violations.push({ nurse: nm, day: d, rule: 'HAUNER_NO_FRI_N', shift: sh });
      }

      // Consecutive work days > 2 (without pattern whitelist)
      if (isWork(sh) && d >= 3) {
        const prev1 = arr[d - 2];
        const prev2 = arr[d - 3];
        if (isWork(prev1) && isWork(prev2)) {
          if (!isPatternWhitelisted(st.sc, ctx, nm, d, sh)) {
            violations.push({ nurse: nm, day: d, rule: 'CONSECUTIVE_3', shift: sh });
          }
        }
      }
    }
  }

  return violations;
}

/* ========================================================================
   BUILD OUTPUT
   ======================================================================== */

function buildOutput(st, nurses, ctx) {
  const stats = {};
  for (const n of nurses) {
    const nm = n.name;
    const sc = st.sc[nm];
    const dovDays = countDovDays(st.sc, nm, ctx);
    const norma = countNormaHours(st.sc, nm, ctx);
    const target = targetHours(n, st.sc, ctx);
    const kjDays = sc.filter(isKJ).length;
    const twoPDays = sc.filter(is2P).length;
    stats[nm] = {
      norma: Math.round(norma * 10) / 10,
      target: Math.round(target * 10) / 10,
      diff: Math.round((norma - target) * 10) / 10,
      kjDays,
      twoPDays,
      dovDays,
    };
  }

  const violations = validateConstraints(st, nurses, ctx);

  return {
    schedule: st.sc,
    meta: st.meta,
    stats,
    violations,
    ctx,
  };
}

/* ========================================================================
   MAIN EXPORT — generateSchedule
   ======================================================================== */

/**
 * Generate a monthly work schedule.
 *
 * @param {object} config
 * @param {Array}  config.nurses         - [{ name, fte, ... }]
 * @param {Array}  [config.requirements] - [{ name, day, value }]
 * @param {number} config.month          - 1–12
 * @param {number} config.year           - e.g. 2024
 * @param {object} [config.staffing]     - { [day]: { cdMin, cdMax, nMin, nMax, twoPCDMin, twoPNMin } }
 * @param {object} [config.prevSchedule] - { sc, ctx } from previous month
 * @returns {{ schedule, meta, stats, violations, ctx }}
 */
export function generateSchedule(config) {
  const {
    nurses,
    requirements = [],
    month,
    year,
    staffing = {},
    prevSchedule = null,
  } = config;

  if (!nurses || nurses.length === 0) throw new Error('nurses array is required');
  if (!month || !year) throw new Error('month and year are required');

  const ctx = buildMonthCtx(month, year);
  const st = createEmptyState(nurses, ctx);

  // Precompute prev-month facts per nurse (for continuity checks)
  const prevFacts = {};
  if (prevSchedule) {
    for (const n of nurses) {
      prevFacts[n.name] = getPrevMonthFacts(prevSchedule.sc, prevSchedule.ctx, n.name);
    }
    // Propagate banNightBeforeX to day 1 if last day of prev month was X
    for (const n of nurses) {
      const pf = prevFacts[n.name];
      if (pf.lastDayShift === SHIFT.X) {
        st.meta[n.name][0].banNightBeforeX = true;
      }
    }
  }

  // Mark X days as ban-work
  for (const n of nurses) {
    const nm = n.name;
    for (let d = 1; d <= ctx.DAYS; d++) {
      if (st.sc[nm][d - 1] === SHIFT.X) {
        st.meta[nm][d - 1].banWork = true;
      }
    }
  }

  // Step 1: Requirements
  applyRequirements(st, ctx, requirements);

  // Re-mark banWork for X days locked by requirements
  for (const n of nurses) {
    const nm = n.name;
    for (let d = 1; d <= ctx.DAYS; d++) {
      if (st.sc[nm][d - 1] === SHIFT.X) {
        st.meta[nm][d - 1].banWork = true;
        if (d + 1 <= ctx.DAYS) st.meta[nm][d].banNightBeforeX = true;
      }
    }
  }

  // Step 2: Auto DOV
  applyAutoDovFromLongOff(st, nurses, ctx);

  // Step 3: Weekends
  assignWeekends(st, nurses, ctx, staffing);

  // Step 4: Weekday KJ
  fillKJDays(st, nurses, ctx, staffing);

  // Step 5: 2P shifts
  fill2P(st, nurses, ctx, staffing);

  // Step 6: Norma balance
  balanceNorma(st, nurses, ctx);

  // Build and return final result
  return buildOutput(st, nurses, ctx);
}

export {
  buildMonthCtx,
  createEmptyState,
  applyRequirements,
  applyAutoDovFromLongOff,
  assignWeekends,
  fillKJDays,
  fill2P,
  balanceNorma,
  validateConstraints,
  normalizeShift,
  getPrevMonthFacts,
  isKJ,
  is2P,
  isOff,
  isWork,
  normHoursOf,
  HOURS_NORMA,
  KJ_LIMITS,
};
