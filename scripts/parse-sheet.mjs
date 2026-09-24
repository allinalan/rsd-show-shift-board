#!/usr/bin/env node
/*
  parse-sheet — read the Show Shift Schedule (Google Sheet, xlsx export) into board shape, and
  prove the read before anyone trusts it.

  Stage 1 of docs/ROADMAP.md: the Sheet is still the truth, so the board has to be re-synced from
  it. A misparse is the dangerous failure here — it is silent, it writes a wrong seed, and everyone
  then trusts the wrong seed. So this script's real job is `--verify`: parse the Sheet, line the
  parse up against seed/events.json, and show per-field mismatch counts. A field that differs on
  one or two events is the team editing the Sheet; a field that differs on most of them is this
  parser having drifted, and `--verify` exits non-zero when it sees that.

  Usage:
    parse-sheet.mjs <schedule.xlsx> [--tab 2026] [--json]     parse; print a summary, or the events
    parse-sheet.mjs <schedule.xlsx> --verify                  check the parse against seed/events.json
    parse-sheet.mjs <schedule.xlsx> --diff [--out report.md]  what changed since the seed
    parse-sheet.mjs --grid <grid.json> [...]                  take a pre-dumped grid instead of xlsx
    ... --seed <events.json>                                  check against a file other than seed/events.json

  Pull the Sheet with no auth:
    curl -sL -o /tmp/schedule.xlsx \
      "https://docs.google.com/spreadsheets/d/10p5Ro2WpeJ7mMOyS92OWIT3w3Nl-KGX4vBMkXJoOCTs/export?format=xlsx"

  This repo has no node_modules. Reading .xlsx needs SheetJS, which is vendored in the sibling
  automations projects; see XLSX_PATHS below. `--grid` is the way out if none of them are present.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) { const k = a.slice(2); flags[k] = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : true; }
  else pos.push(a);
}
const die = m => { console.error('parse-sheet: ' + m); process.exit(1); };
const out = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));

// ---------- the Sheet's shape (1-indexed columns A=0 here) --------------------------------
// Re-check these when the season's tab is rebuilt; they drift year to year.
const C = { FLAG: 0, LEVEL: 1, STATUS: 2, BESTCPO: 3, DESC: 4, DAY0: 5, DAY9: 11,
            COST: 12, START: 13, END: 14, CITY: 15, LOC: 16,
            PROMOTER: 18, CONTACT: 19, PHONE: 20, EMAIL: 21, WEBSITE: 22,
            VCSTATUS: 25, VCNUM: 26 };

/**
 * Two rows are written wholesale in the wrong columns — a data-entry accident, not a pattern, so
 * they are named rather than guessed at. Each says which column really holds which field; no
 * values live here, so a later edit on the Sheet still comes through and nothing private lands in
 * this public repo. Keyed by name + weekend, never row number: the Sheet is reordered constantly.
 *
 * Maricopa (Oct) sits one column right of every other event row, two for the last two fields —
 * confirmed against the January Maricopa row, the same show with the same promoter. Tucson Rodeo
 * WK2 sits one column left from City onward — confirmed against the WK1 row, which is correct.
 * Its city also spilled into the last day column, so it stays a day label too, as the seed has it.
 */
const SHEET_REPAIRS = {
  'maricopa county home garden show|2026-10-02':
    { COST: 13, CITY: 16, LOC: 17, PROMOTER: 19, CONTACT: 20, PHONE: 21, EMAIL: 23, WEBSITE: 24 },
  'tucson rodeo wk2|2027-02-26':
    { CITY: 11, LOC: 15, PROMOTER: 16, CONTACT: 17, PHONE: 18, EMAIL: 19, WEBSITE: 22 },
};

const WEEKDAYS = { sunday:0, sun:0, monday:1, mon:1, tuesday:2, tues:2, tue:2, wednesday:3,
  weds:3, wed:3, thursday:4, thurs:4, thur:4, thu:4, friday:5, fri:5, saturday:6, sat:6 };

const str = v => (v === null || v === undefined) ? '' : String(v).trim();
const EPOCH = Date.UTC(1899, 11, 30);
const iso = d => d ? d.toISOString().slice(0, 10) : null;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** An Excel serial, M/D/YYYY or YYYY-MM-DD; anything else is not a date. */
function toDate(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const ser = n => (n > 20000 && n < 80000) ? new Date(EPOCH + Math.round(n) * 86400000) : null;
  if (typeof raw === 'number') return ser(raw);
  const s = String(raw).trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) return ser(Number(s));
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?!\d)/);
  if (m) { let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900; return new Date(Date.UTC(y, +m[1] - 1, +m[2])); }
  return null;
}
/** A day cell that holds a date keeps its date text, the way the 2026-09-13 migration wrote it. */
const asSheetDate = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;

function weekdayOf(label) {
  if (label === null || label === undefined || label === '') return null;
  const d = toDate(label);
  if (d) return d.getUTCDay();
  for (const tok of String(label).toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z]+/))
    if (tok && WEEKDAYS[tok] !== undefined) return WEEKDAYS[tok];
  return null;
}
/**
 * A day label resolves to a real date only when it carries a weekday word, has no parenthetical,
 * and is not itself a date. "Monday SE" resolves; "Friday (SE)", "Thursday (Thanksgiving Day)",
 * "1/26/2024" and "SE Surprise" do not. Checked against the migration: 565 labels resolved and
 * 21 did not, with no exceptions either way.
 */
function resolvableWeekday(label) {
  const s = String(label ?? '');
  if (s === '' || s.includes('(') || toDate(s) !== null) return null;
  return weekdayOf(s);
}
/** SE / set-up / tear-down days are scheduled, but they are never selling shifts. */
export const isSEday = label => /set\s*up|tear\s*down|\bse\b/i.test(String(label || ''));

const looksShift = d => /^shift\s*\d/i.test(d);
const looksBooth = d => /^booth\s*#?\s*\d/i.test(d);
const looksNumericCell = v => /^\$?\s*[\d,.]+\s*(k)?$/i.test(str(v));
const looksPhone = v => /^[+(]?\d[\d\s().-]{7,}$/.test(str(v));
const looksEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(v));

const normLevel = v => {
  const s = str(v);
  if (/^jv$/i.test(s)) return 'JV';
  if (/^varsity$/i.test(s)) return 'Varsity';
  if (/industry/i.test(s)) return 'Trade/Industry';
  return '';                                        // "Frosh", stray text and typos are not levels
};
/** The migration rounded the cost to whole dollars; a non-numeric cell ("pending", "FREE") stays. */
function fmtCost(raw) {
  const s = str(raw);
  if (s === '') return { cost: '', costNum: null };
  const n = Number(s.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return { cost: s, costNum: null };
  return { cost: `$${Math.round(n).toLocaleString('en-US')}`, costNum: Math.round(n) };
}
/** "17k" -> 17000, "5.5k" -> 5500, "850" -> 850. */
function cpoNum(raw) {
  const s = str(raw).toLowerCase();
  const m = s.match(/^([\d.,]+)\s*k?$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return /k$/.test(s) ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Alan's rule, verbatim: "If there is a name under an event in the schedule (not if it only says
 * ft.. there has to be a rep name and it can have ft after that)". Strip every (ft. …) and any
 * trailing bare "ft …"; what remains is the lead rep, and nothing left means helper-only.
 */
export function splitRep(raw) {
  let s = str(raw);
  if (!s) return { rep: '', ft: [] };
  if (/^x+$/i.test(s)) return { rep: '__X__', ft: [] };
  const ft = [];
  s = s.replace(/\(\s*f\.?t\.?[\s.:-]*([^)]*)\)?/gi, (_, inner) => { ft.push(inner); return ' '; });
  s = s.replace(/\bf\.?t\.?[\s.:-]+(.*)$/i, (_, rest) => { ft.push(rest); return ' '; });
  s = s.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const helpers = ft.join(',').split(/[,&]| and /i).map(x => x.replace(/[^\w' .-]/g, ' ').trim()).filter(Boolean);
  if (/^x+$/i.test(s)) return { rep: '__X__', ft: helpers };
  if (!s || s.length < 2) return { rep: '', ft: helpers };
  if (/^(tbd|n\/a|na|open|-+|\?+)$/i.test(s)) return { rep: '', ft: helpers };
  // a leftover day name in a rep column is not a rep
  const withoutDays = s.replace(/sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat/gi, '');
  if (weekdayOf(s) !== null && !/[a-z]{4,}/i.test(withoutDays)) return { rep: '', ft: helpers };
  return { rep: s, ft: helpers };
}

/**
 * Map each day column to a real date.
 *
 * The anchor is the **weekend banner**, never the Start Date: schedule Start Dates are routinely
 * stale — 9 rows sit more than a month from their weekend and 8 are in the wrong year outright —
 * but the banner is always right, because the banner is what the staffing is for. Candidate
 * anchors are the weekend ±6 days; each is scored by how many of its dates land inside the
 * event's own start–end run, and the tie-break is distance back to the banner.
 */
function resolveDates(dayLabels, weekendDate, start, end) {
  const home = weekendDate || start;
  const blank = new Array(dayLabels.length).fill(null);
  if (!home) return blank;
  const wd = dayLabels.map(resolvableWeekday);
  const first = wd.findIndex(w => w !== null);
  if (first === -1) return blank;
  const seq = anchor => {
    const dates = new Array(dayLabels.length).fill(null);
    let cur = anchor; dates[first] = cur;
    for (let i = first + 1; i < dayLabels.length; i++) {
      if (wd[i] === null) continue;
      let next = addDays(cur, 1);
      while (next.getUTCDay() !== wd[i]) next = addDays(next, 1);
      dates[i] = cur = next;
    }
    return dates;
  };
  const inRun = d => start ? (d >= addDays(start, -1) && d <= addDays(end || start, 1)) : false;
  let best = null;
  for (let cand = addDays(home, -6); cand <= addDays(home, 6); cand = addDays(cand, 1)) {
    if (cand.getUTCDay() !== wd[first]) continue;
    const dates = seq(cand);
    const score = dates.filter(d => d && inRun(d)).length;
    const dist = Math.abs(cand.getTime() - home.getTime());
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { dates, score, dist };
  }
  return best.dates;
}

// ---------- the walk ----------------------------------------------------------------------
export function parseSheet(grid, { seasonYear = 2026 } = {}) {
  const events = [], warnings = [];
  let weekend = null, ev = null, booth = null, repairs = 0;

  const newBooth = (e, label) => {
    const b = { label, status: '', days: e.days.slice(), dates: e.dates.slice(), shifts: [] };
    e.booths.push(b); return b;
  };

  for (let r = 1; r <= grid.length; r++) {
    if (r === 1) continue;                    // header row — E1 has held an event name before now
    const row = grid[r - 1] || [];
    const desc = str(row[C.DESC]).replace(/^\s*\d{6,}\s*-\s*/, '');   // strip a VC number prefix

    // Weekend banner. The leftmost of columns A–H wins; a stale copy sits far to the right.
    let banner = null;
    for (let c = 0; c <= 7; c++) {
      const m = str(row[c]).match(/^weekend\s+(\d{1,2})\s*[-\/]\s*(\d{1,2})/i);
      if (m) { banner = { mo: +m[1], day: +m[2] }; break; }
    }
    if (banner) {
      const year = banner.mo >= 8 ? seasonYear : seasonYear + 1;
      weekend = iso(new Date(Date.UTC(year, banner.mo - 1, banner.day)));
      continue;
    }
    if (row.every(c => str(c) === '')) continue;

    const dayCells = [];
    for (let c = C.DAY0; c <= C.DAY9; c++) dayCells.push(row[c]);

    if (desc && looksBooth(desc)) {            // "Booth #2 10x10" is a sub-header, not an event
      if (!ev) { warnings.push(`row ${r}: booth header with no event above it`); continue; }
      booth = newBooth(ev, desc);
      continue;
    }

    const isShiftRow = desc !== '' && looksShift(desc);
    const hasDayHeader = dayCells.some(v => str(v) !== '' && weekdayOf(v) !== null);
    const hasEventFields = str(row[C.STATUS]) !== '' || str(row[C.COST]) !== '' || row[C.START] != null ||
      str(row[C.CITY]) !== '' || str(row[C.LOC]) !== '' || str(row[C.PROMOTER]) !== '' || str(row[C.VCSTATUS]) !== '';
    // An event header carries a description that is neither Shift nor Booth — even a bare one
    // ("Snowflake Harvest Fest", "x"). A row with no description but real event fields beside a
    // day header is an event too; the migration named those "Unnamed event (<venue>)".
    const isEventRow = !isShiftRow && (desc !== '' || (hasDayHeader && hasEventFields));

    if (isEventRow) {
      // Every non-empty cell in F–L is a day label, junk included: the migration kept
      // "SE Surprise" and a spilled "Tucson, AZ" as labels, and the slot arrays line up with them.
      const dayCols = [];
      for (let c = C.DAY0; c <= C.DAY9; c++) if (str(row[c]) !== '') dayCols.push(c);
      const days = dayCols.map(c => { const d = toDate(row[c]); return d ? asSheetDate(d) : str(row[c]); });
      const start = toDate(row[C.START]), end = toDate(row[C.END]);
      const weekendDate = weekend ? new Date(`${weekend}T00:00:00Z`) : null;
      const name = desc ? desc.replace(/\s+/g, ' ').trim()
                        : `Unnamed event (${str(row[C.LOC]) || str(row[C.CITY]) || `row ${r}`})`;
      const repair = SHEET_REPAIRS[`${normName(name)}|${weekend || ''}`] || {};
      if (Object.keys(repair).length) repairs++;
      const at = k => row[repair[k] !== undefined ? repair[k] : C[k]];
      const { cost, costNum } = fmtCost(at('COST'));
      // Column spill. Two shapes, both common enough to be worth reading rather than copying:
      //   a phone in the Promoter cell, or an e-mail in the Website cell — one field out of place;
      //   a phone or e-mail in the *Contact* cell — the whole contact block starts a column early,
      //   so what follows is phone/e-mail/website, not contact/phone/e-mail. Six rows do this,
      //   all of them Queen Creek Family Market or Litchfield Park.
      const promoterCell = str(at('PROMOTER')), websiteCell = str(at('WEBSITE'));
      const contactCell = str(at('CONTACT'));
      const blockShifted = looksPhone(contactCell) || looksEmail(contactCell);
      const cell = { contact: blockShifted ? '' : contactCell,
                     phone:   blockShifted ? (looksPhone(contactCell) ? contactCell : '') : str(at('PHONE')),
                     email:   blockShifted ? (looksEmail(contactCell) ? contactCell : (looksEmail(str(at('PHONE'))) ? str(at('PHONE')) : '')) : str(at('EMAIL')),
                     website: blockShifted ? str(at('EMAIL')) : websiteCell };
      ev = {
        row: r, weekend,
        flag: /^mf$/i.test(str(row[C.FLAG])) ? 'MF' : '',
        level: normLevel(row[C.LEVEL]),
        sheetStatus: str(row[C.STATUS]),
        bestCPO: str(row[C.BESTCPO]),
        name,
        days, dates: resolveDates(days, weekendDate, start, end).map(iso),
        cost, costNum,
        startDate: iso(start) || '', endDate: iso(end) || '',
        cityState: str(at('CITY')), location: str(at('LOC')),
        promoter: looksPhone(promoterCell) ? '' : promoterCell,
        contact: cell.contact,
        phone: looksPhone(promoterCell) ? promoterCell : cell.phone,
        email: cell.email || (looksEmail(cell.website) ? cell.website : ''),
        website: looksEmail(cell.website) ? '' : cell.website,
        vcStatus: str(at('VCSTATUS')), vcNumber: str(at('VCNUM')),
        booths: [], dayCols,
      };
      events.push(ev); booth = null;
      continue;
    }

    // Shift rows: labelled "Shift N", or unlabelled but carrying names. Either way the names line
    // up with the event row's day columns, not with the first N cells.
    if (!ev) continue;
    const cols = ev.dayCols.length ? ev.dayCols : Array.from({ length: C.DAY9 - C.DAY0 + 1 }, (_, i) => C.DAY0 + i);
    const anyName = cols.some(c => { const v = str(row[c]); return v !== '' && !looksNumericCell(v) && splitRep(v).rep !== ''; });
    if (!isShiftRow && !anyName) continue;
    if (!booth) booth = newBooth(ev, '');
    booth.shifts.push({
      label: desc || 'Shift',
      slots: cols.map(c => looksNumericCell(row[c]) ? { rep: '', ft: [] } : splitRep(row[c])),
    });
  }
  return { events, warnings, repairs };
}

const newBoothOn = (e, label) => e.booths.push({ label, status: '', days: e.days.slice(), dates: e.dates.slice(), shifts: [] });
/**
 * Some booths are written as their own event rows ("Maricopa Booth #2 (Ag Building) …") instead of
 * as "Booth #N" sub-headers. They carry no dates, cost, promoter or VC number of their own and sit
 * under the same weekend as the event above; the migration folded them in as booths, and split the
 * parent's own booth description out of its name.
 */
export function mergeBoothSiblings(events) {
  const firstWord = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')[0] || '';
  const acc = [];
  for (const e of events) {
    const prev = acc[acc.length - 1];
    const sibling = prev && /\bbooth\s*#?\s*\d/i.test(e.name) && !e.startDate && !e.cost &&
      !e.promoter && !e.vcNumber && e.weekend === prev.weekend &&
      firstWord(e.name) && firstWord(e.name) === firstWord(prev.name);
    if (!sibling) { acc.push(e); continue; }
    if (!prev._split) {
      prev._split = true;
      const m = prev.name.match(/^([^(]+?)\s*\((.+)$/);
      if (m) {
        const label = `Booth #1 ${m[2].replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[()]/g, '').replace(/\s+/g, ' ').trim()}`;
        prev.name = m[1].trim();
        if (!prev.booths.length) newBoothOn(prev, label);
        else for (const b of prev.booths) if (!b.label) b.label = label;
      }
      prev.mergedBoothRows = [prev.row];
    }
    const label = e.name.replace(new RegExp(`^${firstWord(e.name)}\\s*`, 'i'), '').trim();
    const src = e.booths.length ? e.booths : [{ label: '', status: '', days: e.days.slice(), dates: e.dates.slice(), shifts: [] }];
    for (const b of src) prev.booths.push({ ...b, label: b.label || label, status: b.status || e.sheetStatus || '' });
    prev.mergedBoothRows.push(e.row);
  }
  for (const e of acc) delete e._split;
  return acc;
}

/**
 * Mesa Market Place bills by the month and is written as two rows a weekend, "A ROW" and "B ROW".
 * They are one event with two booths. Reading them as two events is what made the 2026-09-19 diff
 * report a phantom mirror-image swap of four reps across two December weekends.
 */
export function mergeMesa(events) {
  const MESA = /mesa\s*market\s*place|mesa\s*market\b|swap\s*meet|swapmeet/i;
  const rowLabel = n => { const m = String(n).match(/\(?\b([AB])\s*row\)?/i); return m ? `${m[1].toUpperCase()} Row` : null; };
  const acc = [];
  for (let i = 0; i < events.length; i++) {
    const a = events[i], b = events[i + 1];
    if (b && MESA.test(a.name) && MESA.test(b.name) && a.weekend === b.weekend) {
      const fill = (e, lab) => (e.booths.length ? e.booths : [{ label: '', status: '', days: e.days.slice(), dates: e.dates.slice(), shifts: [] }])
        .map(x => ({ ...x, label: lab }));
      acc.push({ ...a, name: 'Mesa Market Place Swapmeet', mergedRows: [a.row, b.row], costBasis: 'month',
                 booths: [...fill(a, rowLabel(a.name) || 'A Row'), ...fill(b, rowLabel(b.name) || 'B Row')] });
      i++;
      continue;
    }
    acc.push({ ...a, costBasis: 'date' });
  }
  return acc;
}

export const parseAll = (grid, opts) => {
  const { events, warnings, repairs } = parseSheet(grid, opts);
  const merged = mergeMesa(mergeBoothSiblings(events));
  for (const e of merged) delete e.dayCols;
  return { events: merged, warnings, repairs };
};

// ---------- reps --------------------------------------------------------------------------
/**
 * The board stores rep names as `settings.roster` spells them, not as the Sheet does. Case and
 * punctuation are normalised away, which covers "Matt A" / "Matt A." and "Jerry " / "Jerry"; these
 * are the only tokens on the Sheet that normalisation cannot reach. Re-derive the list with
 * `--verify`, which names any rep it cannot resolve.
 * "Kendall G." is Kendall Gooch, whom the board has always spelled "Kendall": the Sheet started
 * writing "Kendall G." in Sept 2026 when Kendall Harrison ("Kendall H." on the roster) joined.
 */
export const REP_ALIASES = { cam: 'Cameron', jp: 'J. Parker', mattaragon: 'Matt A.', kendallg: 'Kendall' };
const normRep = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
export function makeRepResolver(roster) {
  const byNorm = new Map((roster || []).map(r => [normRep(r), r]));
  return raw => {
    const s = str(raw);
    if (!s || s === '__X__') return s;
    const k = normRep(s);
    return byNorm.get(k) || (REP_ALIASES[k] && byNorm.get(normRep(REP_ALIASES[k]))) || REP_ALIASES[k] || s;
  };
}
/** One identity per rep, so an alias never reads as a change. */
export const repKey = (raw, resolve) => {
  const s = str(raw);
  if (!s) return '';
  if (s === '__X__' || /^x+$/i.test(s)) return '__X__';
  return normRep(resolve ? resolve(s) : (REP_ALIASES[normRep(s)] || s));
};

// ---------- the board's own status ---------------------------------------------------------
/** A shift is a slot with a rep that is not empty and not __X__. SE days are never shifts. */
export function staffedCount(e) {
  let n = 0;
  for (const b of e.booths || []) {
    const days = b.days || [];
    (b.shifts || []).forEach(s => (s.slots || []).forEach((sl, i) => {
      const r = str(sl && sl.rep);
      if (r && r !== '__X__' && !isSEday(days[i])) n++;
    }));
  }
  return n;
}
/** Replays the 2026-09-13 migration on all 227 of its events. */
export function boardStatus(vcStatus, sheetStatus, staffed) {
  const v = str(vcStatus);
  if (v) {
    if (/^booked/i.test(v)) return { status: 'Booked', dead: false };
    if (/^ok to book/i.test(v) || /^pending promoter\s*-?\s*need contract/i.test(v)) return { status: 'OK to Book - Need Contract', dead: false };
    if (/^pending promoter/i.test(v)) return { status: 'Pending Promoter Acceptance', dead: false };
    if (/^pending co\b/i.test(v)) return { status: 'Pending Coordinator', dead: false };
    if (/^show full/i.test(v)) return { status: 'Show Full', dead: false };
    if (/cancel|missed|declin|closed/i.test(v)) return { status: 'Cancelled', dead: true };
    if (/^booking request needed/i.test(v)) return { status: 'Booking Request Needed', dead: false };
    // VC's "Request to Book" = Olean has the booking request (VC Status Definitions, read 2026-09-23)
    if (/^request to book/i.test(v)) return { status: 'Booking Request Submitted', dead: false };
    if (/^prospective/i.test(v)) return { status: 'Prospective', dead: false };
    return { status: v, dead: false };
  }
  const c = str(sheetStatus);
  if (/no dates|cancel/i.test(c)) return { status: 'Cancelled', dead: true };
  if (/^booked/i.test(c)) return { status: 'Booked', dead: false };
  if (staffed > 0 || /^in progress/i.test(c)) return { status: 'Booking Request Needed', dead: false };
  return { status: 'Prospective', dead: false };
}

// ---------- matching a parse to the seed ----------------------------------------------------
export const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Name + weekend, never row number: the Sheet is reordered constantly and row keys go wrong silently. */
export function matchToSeed(live, seed) {
  const key = e => `${normName(e.name)}|${e.weekend || ''}`;
  const bucket = arr => { const m = new Map(); for (const e of arr) { const k = key(e); if (!m.has(k)) m.set(k, []); m.get(k).push(e); } return m; };
  const L = bucket(live), S = bucket(seed);
  const pairs = [], liveOnly = [], seedOnly = [];
  for (const [k, ls] of L) {
    const ss = S.get(k) || [];
    const n = Math.min(ls.length, ss.length);
    for (let i = 0; i < n; i++) pairs.push({ live: ls[i], seed: ss[i] });
    for (let i = n; i < ls.length; i++) liveOnly.push(ls[i]);
  }
  for (const [k, ss] of S) { const ls = L.get(k) || []; for (let i = ls.length; i < ss.length; i++) seedOnly.push(ss[i]); }
  return { pairs, liveOnly, seedOnly };
}

const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const ti = v => t(v).toLowerCase();
/**
 * Fields the team edits rarely. A handful of differences here is the Sheet moving on; a large
 * share of them is this parser having drifted, and that is the failure this script exists to catch.
 */
export const STRUCTURAL = {
  name:      e => ti(e.name),        weekend:   e => t(e.weekend),
  startDate: e => t(e.startDate),    endDate:   e => t(e.endDate),
  cityState: e => ti(e.cityState),   location:  e => ti(e.location),
  promoter:  e => ti(e.promoter),    website:   e => ti(e.website),
  vcStatus:  e => t(e.vcStatus),     vcNumber:  e => t(e.vcNumber),
  cost:      e => t(e.cost),         flagLevel: e => `${ti(e.flag)}/${ti(e.level)}`,
  days:      e => (e.days || []).map(ti).join('|'),
  dates:     e => (e.dates || []).map(x => x || '').join('|'),
};
export const VOLATILE = { sheetStatus: e => t(e.sheetStatus), bestCPO: e => ti(e.bestCPO) };

export function diffShifts(live, seed, resolve) {
  const boothsOf = e => (e.booths || []).map(b => ({ label: b.label || '', days: b.days || [], shifts: (b.shifts || []).map(s => ({ label: s.label || '', slots: s.slots || [] })) }));
  const L = boothsOf(live), S = boothsOf(seed), out = [];
  for (let bi = 0; bi < Math.max(L.length, S.length); bi++) {
    const lb = L[bi], sb = S[bi];
    if (!lb || !sb) { out.push({ kind: 'booth', booth: bi, seed: sb ? sb.label : '(none)', live: lb ? lb.label : '(none)' }); continue; }
    for (let si = 0; si < Math.max(lb.shifts.length, sb.shifts.length); si++) {
      const ls = lb.shifts[si], ss = sb.shifts[si];
      if (!ls || !ss) { out.push({ kind: 'shiftRow', booth: bi, boothLabel: lb.label || sb.label, shift: si, seed: ss ? ss.label : '(none)', live: ls ? ls.label : '(none)' }); continue; }
      const days = lb.days.length ? lb.days : sb.days;
      for (let i = 0; i < Math.max(ls.slots.length, ss.slots.length); i++) {
        const a = ls.slots[i] || { rep: '', ft: [] }, b = ss.slots[i] || { rep: '', ft: [] };
        const common = { booth: bi, boothLabel: lb.label || sb.label || '', shift: ls.label || ss.label, day: days[i] ?? `col ${i}`, se: isSEday(days[i]) };
        if (repKey(a.rep, resolve) !== repKey(b.rep, resolve)) out.push({ kind: 'slot', ...common, seed: b.rep || '(open)', live: a.rep || '(open)' });
        const fa = (a.ft || []).map(x => repKey(x, resolve)).sort().join(','), fb = (b.ft || []).map(x => repKey(x, resolve)).sort().join(',');
        if (fa !== fb) out.push({ kind: 'ft', ...common, seed: (b.ft || []).join(' & ') || '(none)', live: (a.ft || []).join(' & ') || '(none)' });
      }
    }
  }
  return out;
}

// ---------- reading the workbook -------------------------------------------------------------
// This repo carries no node_modules on purpose. SheetJS is vendored in the sibling projects.
export const XLSX_PATHS = [
  '/Users/allinalan/automations/rsd-event-analyzer/node_modules/xlsx/xlsx.mjs',
  '/Users/allinalan/automations/rsd-events-intake/node_modules/xlsx/xlsx.mjs',
  '/Users/allinalan/automations/csp-autopilot/node_modules/xlsx/xlsx.mjs',
];
export async function readGrid(file, tab) {
  const found = XLSX_PATHS.find(p => fs.existsSync(p));
  if (!found) die(`no SheetJS on this machine. It is vendored in the sibling projects; none of these exist:\n  ${XLSX_PATHS.join('\n  ')}\nEither restore one of them, or dump the tab to JSON yourself and pass --grid <file.json>.`);
  const XLSX = await import(found);              // a namespace import: it has no default export
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: false });
  const name = tab && tab !== true ? String(tab) : wb.SheetNames[0];
  if (!wb.Sheets[name]) die(`no tab "${name}" in ${path.basename(file)}. Tabs: ${wb.SheetNames.join(', ')}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
}

// ---------- CLI --------------------------------------------------------------------------------
async function main() {
  if (!pos[0] && !flags.grid) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    console.error(src.slice(src.indexOf('/*') + 2, src.indexOf('*/')).trim());
    process.exit(1);
  }
  const grid = flags.grid ? JSON.parse(fs.readFileSync(String(flags.grid), 'utf8')) : await readGrid(pos[0], flags.tab);
  const seasonYear = flags.tab && flags.tab !== true && /^\d{4}$/.test(String(flags.tab)) ? Number(flags.tab) : 2026;
  const { events, warnings, repairs } = parseAll(grid, { seasonYear });
  for (const w of warnings) console.error('warning: ' + w);
  if (repairs) console.error(`${repairs} of ${Object.keys(SHEET_REPAIRS).length} known column-spill repair(s) applied`);

  if (!flags.verify && !flags.diff) {
    if (flags.json) return out(events);
    const staffed = events.reduce((n, e) => n + staffedCount(e), 0);
    return out(`${events.length} events, ${staffed} staffed slots, ${warnings.length} warnings`);
  }

  const seedFile = flags.seed && flags.seed !== true ? String(flags.seed) : path.join(REPO, 'seed', 'events.json');
  if (!fs.existsSync(seedFile)) die(`no ${seedFile} to check against`);
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, 'seed', 'settings.json'), 'utf8'));
  const resolve = makeRepResolver(settings.roster);
  const { pairs, liveOnly, seedOnly } = matchToSeed(events, seed);

  // Any rep on the Sheet the roster plus REP_ALIASES cannot place is a silent mis-read waiting
  // to happen, so name them rather than quietly passing them through.
  const unresolved = new Set();
  for (const e of events) for (const b of e.booths) for (const s of b.shifts) for (const sl of s.slots) {
    const r = str(sl.rep);
    if (r && r !== '__X__' && !settings.roster.some(x => normRep(x) === normRep(resolve(r)))) unresolved.add(r);
  }

  const lines = [];
  lines.push(`parsed ${events.length} events; seed has ${seed.length}; matched ${pairs.length}, sheet-only ${liveOnly.length}, seed-only ${seedOnly.length}`);
  let drift = null;
  for (const [group, defs] of [['structural', STRUCTURAL], ['volatile', VOLATILE]]) {
    lines.push(`\n${group} fields:`);
    for (const [k, f] of Object.entries(defs)) {
      const bad = pairs.filter(p => f(p.live) !== f(p.seed));
      lines.push(`  ${k.padEnd(11)} differs on ${String(bad.length).padStart(4)}`);
      if (group === 'structural' && pairs.length && bad.length > pairs.length * 0.1) drift = drift || k;
      if (bad.length && bad.length <= 8) for (const p of bad.slice(0, 8))
        lines.push(`      r${p.seed.row}→${p.live.row} ${p.seed.name.slice(0, 38)}: ${JSON.stringify(f(p.seed))} → ${JSON.stringify(f(p.live))}`);
    }
  }
  const shiftHits = pairs.map(p => ({ ...p, d: diffShifts(p.live, p.seed, resolve) })).filter(p => p.d.length);
  lines.push(`\nshift-side changes: ${shiftHits.length} event(s), ${shiftHits.reduce((n, p) => n + p.d.length, 0)} entr(ies)`);
  for (const p of shiftHits) {
    lines.push(`  r${p.seed.row}→${p.live.row}  ${p.seed.weekend}  ${p.seed.name}`);
    for (const x of p.d) lines.push(`     [${x.kind}]${x.se ? ' (SE day)' : ''} ${[x.boothLabel, x.shift, x.day].filter(v => v !== '' && v != null).join(' / ')}: ${JSON.stringify(x.seed)} → ${JSON.stringify(x.live)}`);
  }
  if (liveOnly.length) { lines.push('\non the Sheet, no seed event:'); for (const e of liveOnly) lines.push(`  row ${e.row}  ${e.weekend}  ${e.name}`); }
  if (seedOnly.length) { lines.push('\nin the seed, not found on the Sheet:'); for (const e of seedOnly) lines.push(`  r${e.row}  ${e.weekend}  ${e.name}  [${e.id}]`); }
  if (unresolved.size) lines.push(`\nreps the roster cannot place (add to REP_ALIASES or settings.roster): ${[...unresolved].join(', ')}`);

  const text = lines.join('\n');
  if (flags.out && flags.out !== true) { fs.writeFileSync(String(flags.out), text + '\n'); console.error(`written to ${flags.out}`); }
  out(text);
  if (drift) {
    console.error(`\nparse-sheet: "${drift}" differs on more than a tenth of the matched events. That is this parser drifting from the seed's conventions, not the Sheet moving on — fix the parser before writing anything.`);
    process.exit(2);
  }
  if (unresolved.size) process.exit(3);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => die(e.stack || e.message));
