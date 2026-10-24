#!/usr/bin/env node
/*
  sheet-sync — keep the board true to the Show Shift Schedule (the Google Sheet) while the Sheet is still
  where the team edits. One direction only: Sheet -> board. No AI; a script.

  THREE-WAY. It compares the Sheet now, the Sheet as of the last sync (state/sheet-baseline.json; the
  first run uses seed/events.json, the Sheet the board was seeded from on 2026-09-20) and the board now.
  Only what the Sheet changed since the last sync is carried, and only where the board still holds the
  old value. A shift someone changed on the board is never overwritten; when both sides changed the
  same thing, neither is touched and the report names it.

  WHAT IT CARRIES (Alan, 2026-09-23: "mainly if we add shifts, remove shifts or change names on the
  shifts"): shifts added, removed and re-staffed, trainees, shift rows and booths, day labels, new events,
  and the event's own details (name, place, promoter, cost, dates, column C as sheetStatus; the cost only until
  the event check has taken VectorConnect's, which then stands: costSource VC). Not promoter
  contacts: those are edited on the board (see SCALARS for why).

  VECTORCONNECT WINS. Status never comes from the Sheet: column C is the team's free text (kept as
  sheetStatus, for display) and the VC columns Z/AA froze on 9/9. A rep added to a show VC calls dead is
  held. A date moved away from a VC-booked record is held. An event deleted from the Sheet is flagged,
  never deleted from the board. An event that moved weekends is flagged, never duplicated. Held changes
  stay pending: the baseline keeps the old value, so they come back every run until someone decides.

  FAILS CLOSED. A parser that drifts (a structural field differs on more than a tenth of the matched
  events: a column inserted, a tab rebuilt) or a run that would touch an unusual amount writes nothing.
  A run with no VC pull (the board's "Sync from the Sheet" button) holds a date the Sheet moved on any show
  VectorConnect has a record for: it cannot check the move, so the Wednesday run, which has a pull, decides.

  ONE AT A TIME. --apply takes state/sheet-sync.lock before it reads the baseline, so the Wednesday job and
  a button press can never both write it; the second waits up to three minutes, then gives up (exit 4).

  ON THE RECORD. Every --apply run writes its outcome to sheet_syncs (schema.sql), which the page reads for
  "last synced". --requests <ids> (scripts/sync-requests.mjs, the button's listener) updates those rows;
  otherwise it adds one. Best effort: a missing table is a warning, never a failed sync. --via names what
  started the run in the changelog and the record: service:sheet-sync:button or :auto (the hourly sync).

  TWO BOOKS (Alan, 2026-10-23). The team keeps a Sept-Feb book and a Jan-May book, separate Google Sheets that
  both carry January and February (config/event-check.json `sheets`). Each weekend is fed by one book only, so a
  show never flips between them: until the January meeting the Sept-Feb book feeds through February and the
  Jan-May book from March 1; from the morning of the meeting (`handover.on`) the Jan-May book feeds every weekend
  from January 1. Each book has its own baseline (state/sheet-baseline-<key>.json), and the Jan-May book's
  January-February part stays as it was read on the day it was first loaded, so on handover morning only what
  the team changed in that book since then comes over (Alan's calls on the books' six differences stay as he made
  them). state/sheet-baseline.json is every book's current part in one file, for rsd-shift-picking's coverage
  agent. One run reads every book and writes all of them or none: a book that drifts, runs over the limits or has
  no baseline stops the whole run. --book <key> runs one book alone.

  FIRST LOAD. A new book comes onto the board once, by hand: --first-load <key> (dry), then with --apply. Its
  weekends a book does not feed yet are remembered (the handover), and every other show is created as a
  Prospective show for config `firstLoad.year`, with no reps: the Jan-May 2027 book's March-May rows were still
  2026's, with 2026's picks on them (Alan, 2026-10-23). Those cells are kept in state/sheet-stale-<key>.json and
  never come over while they still say what they said that day; a name the team writes over one does. Days are
  placed from the weekend header and marked estimated (the date research finds the real ones), a row column B or C
  marks out (no dates, cancelled, declined, not allowed, another rep's territory) is Cancelled, column B "Elite" is
  Elite, and the rows `firstLoad.skip` names are last year's copies of shows already on the board. Every show
  written is read back. The held-back cells are kept by board show and used up once the Sheet says anything else
  there; a new row carrying the names of a show gone from that weekend is held, not created.

  ONE SHOW, ONE BOOK. A row matching a show another book feeds today is not linked, two books writing one show in a
  run stop it (exit 6), and a show a book stops feeding that no other book carries is flagged once.

  Usage:
    sheet-sync.mjs [--apply] [--book <key>] [--vc vc-my-events.json] [--force] [--date YYYY-MM-DD]
                   [--tag <t>] [--requests <id,id>] [--via button|auto]
    sheet-sync.mjs --first-load <key> [--apply] [--date YYYY-MM-DD]
    --xlsx / --grid <file> stand in for the first book's download, --xlsx-<key> / --grid-<key> for that book's (the
    tests); given any of them, the books without one are not read.
  Dry by default: prints the plan and writes out/reports/sheet-sync-<date>.{md,json} (sheet-sync-<date>-<tag>
  with --tag); touches neither the board nor the baseline. --apply writes the board, then the baselines.
  Exit: 0 ok · 1 error · 2 parser drift · 3 over the change limits (read the plan, then --force)
        · 4 another sync held the lock for three minutes (nothing read or written)
        · 5 a book has no baseline yet (run --first-load <key>) · 6 two books would write the same show (nothing written)
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseAll, makeRepResolver, repKey, boardStatus, staffedCount, matchToSeed, STRUCTURAL, readGrid, normName } from './parse-sheet.mjs';
import { boardApi } from './lib/board-api.mjs';
import { isMain } from './lib/is-main.mjs';
import { nameScore, statusCategory, effectiveDate, lastDay, inRun, dayDiff, ruleTier } from './lib/match.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const APPLY = flag('--apply'), FORCE = flag('--force');
const TAG = (opt('--tag') || '').replace(/[^A-Za-z0-9_-]/g, '');
const REQUESTS = (opt('--requests') || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
const VIA = (opt('--via') || '').replace(/[^a-z]/g, '');
const ONLY = opt('--book'), FIRST = opt('--first-load');
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
const BOOKS = CFG.sheets;
// BOARD_STATE_DIR / BOARD_OUT_DIR point the tests at temp dirs; production uses the repo's state/ and out/.
const STATE = process.env.BOARD_STATE_DIR || path.join(REPO, 'state');
const COMBINED = path.join(STATE, 'sheet-baseline.json');   // every book's current part: rsd-shift-picking's coverage agent reads it
const baselineFile = b => path.join(STATE, b.baseline), staleFile = b => path.join(STATE, `sheet-stale-${b.key}.json`);
const OUT_BASE = process.env.BOARD_OUT_DIR || path.join(REPO, 'out'), OUT = path.join(OUT_BASE, 'reports');
const phxToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
const TODAY = opt('--date') || phxToday();
const MESA = new RegExp(CFG.mesaPattern, 'i');

const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const clone = o => JSON.parse(JSON.stringify(o));
const isRep = r => !!t(r) && t(r) !== '__X__';
// Promoter contact/phone/email are NOT carried: the parser misreads the Sheet's contact block when a
// cell spills (an extension landed in the e-mail column on 2026-09-23), and the board's contacts were
// corrected by hand at cutover. They are edited on the board. Shift-row labels are not carried either:
// they are positional names the migration numbered ("Shift 2") where the Sheet leaves the cell blank.
const SCALARS = ['name', 'cityState', 'location', 'promoter', 'website', 'cost', 'costNum', 'costBasis', 'bestCPO', 'level', 'flag', 'sheetStatus'];
const DATE_FIELDS = ['startDate', 'endDate'];

// ---------- the books -------------------------------------------------------------------------
/** The weekends a book feeds on a day: `weekends` until `handover.on`, `handover.weekends` from then. */
export const rangeOn = (book, today) => ((book.handover && today >= book.handover.on ? book.handover.weekends : book.weekends) || {});
export const owned = (range, weekend) => { const w = weekend || ''; return (!range.from || w >= range.from) && (!range.to || w <= range.to); };
const keyOf = e => `${normName(e.name)}|${e.weekend || ''}`;
const givenFor = (b, i, kind) => opt(`--${kind}-${b.key}`) || (i === 0 ? opt(`--${kind}`) : null);
const anyGiven = () => BOOKS.some((b, i) => givenFor(b, i, 'grid') || givenFor(b, i, 'xlsx'));

async function sheetFile(book, i) {
  if (givenFor(book, i, 'xlsx')) return givenFor(book, i, 'xlsx');
  const url = `https://docs.google.com/spreadsheets/d/${book.fileId}/export?format=xlsx`;
  const r = await fetch(url, { redirect: 'follow' });
  const buf = Buffer.from(await r.arrayBuffer());
  // An xlsx is a zip. Anything else (a Google sign-in page, an error page) must never be parsed as "no events".
  if (!r.ok || buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b)
    throw new Error(`the ${book.label} book's export did not come back as a workbook (HTTP ${r.status}, ${buf.length} bytes). Is the Sheet still link-shared? ${url}`);
  fs.mkdirSync(OUT_BASE, { recursive: true });
  const f = path.join(OUT_BASE, `sheet-${book.key}-${TODAY}.xlsx`);
  fs.writeFileSync(f, buf, { mode: 0o600 });
  return f;
}
/** --grid <json>: a pre-dumped grid (tests; this repo is public, so no real Sheet data lives in it). */
async function readBook(book, i) {
  const g = givenFor(book, i, 'grid');
  if (g) return { file: g, grid: JSON.parse(fs.readFileSync(g, 'utf8')) };
  const file = await sheetFile(book, i);
  return { file, grid: await readGrid(file, book.tab) };
}
const parseBook = (book, grid) => parseAll(grid, { seasonYear: book.seasonYear ?? 2026, dateLabels: book.dateLabels || 'keep' });

/**
 * A book's Sheet as of its last sync, or null when it has none yet. Before 2026-10-23 there was one book and its
 * baseline was state/sheet-baseline.json; `legacyBaseline` reads it from there until the book's own file is
 * written (the entries another book put there carry its key and are left out).
 */
function loadBaseline(book) {
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  if (fs.existsSync(baselineFile(book))) return { events: read(baselineFile(book)), source: `state/${book.baseline}` };
  if (book.legacyBaseline && fs.existsSync(COMBINED))
    return { events: read(COMBINED).filter(e => !e.book || e.book === book.key).map(({ book: _b, ...e }) => e), source: 'state/sheet-baseline.json (before the books were split)' };
  if (!book.seedBaseline) return null;
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'seed', 'events.json'), 'utf8'));
  const cf = path.join(REPO, 'seed', 'private', 'event_contacts.json');
  const contacts = fs.existsSync(cf) ? new Map(JSON.parse(fs.readFileSync(cf, 'utf8')).map(c => [c.id, c])) : new Map();
  for (const e of seed) { const c = contacts.get(e.id); if (c) for (const k of ['contact', 'phone', 'email']) if (c[k] != null) e[k] = c[k]; }
  return { events: seed, source: 'seed/events.json (first sync: the Sheet as of 2026-09-20)' };
}
const writePrivate = (f, v) => { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };
/** Which books feed each board show today: id -> Set of book keys (the entries on the weekends each book feeds). */
function fedToday() {
  const fed = new Map();
  for (const b of BOOKS) {
    const lb = loadBaseline(b), range = rangeOn(b, TODAY);
    for (const e of (lb && lb.events) || []) if (e.id && owned(range, e.weekend)) { if (!fed.has(e.id)) fed.set(e.id, new Set()); fed.get(e.id).add(b.key); }
  }
  return fed;
}
/**
 * state/sheet-baseline.json: each book's entries for the weekends it feeds today, tagged with the book, plus once each
 * show no book feeds any more (a Sept-Feb-only show after the handover), so the coverage agent still finds it.
 */
function writeCombined() {
  const fed = fedToday(), all = [], left = new Set();
  for (const b of BOOKS) {
    const lb = loadBaseline(b); if (!lb) continue;
    const range = rangeOn(b, TODAY);
    for (const e of lb.events) {
      if (owned(range, e.weekend)) all.push({ ...e, book: b.key });
      else if (e.id && !fed.has(e.id) && !left.has(e.id)) { all.push({ ...e, book: b.key }); left.add(e.id); }
    }
  }
  writePrivate(COMBINED, all);
}

/**
 * Cells the first load did not carry (last year's picks on a row rolled into this year), kept per board show. While a
 * cell still says exactly that, in that booth, shift row and day, it reads as empty; once the team writes anything else
 * there (a blank included), the entry is used up and the cell is theirs from then on. Tied to the show's board id, so a
 * rename on the Sheet does not set last year's names loose; the place is by label, so a row added elsewhere does not
 * move it.
 */
const cellKey = sl => [sl && sl.rep, ...((sl && sl.ft) || [])].map(x => String(x || '').toLowerCase().replace(/[^a-z0-9_]/g, '')).join('|');
const placeKey = (b, s, d) => [b.label, s.label, (b.days || [])[d]].map(x => t(x).toLowerCase()).join('#');
/** Blank the cells of one show that still hold what the first load left out; returns the entries that matched. */
export function dropStaleFor(e, entries) {
  if (!entries || !entries.length) return [];
  const byPlace = new Map(entries.map(x => [`${x.place}#${x.cell}`, x]));
  const used = [];
  for (const b of e.booths || []) for (const s of b.shifts || []) (s.slots || []).forEach((sl, d) => {
    const x = byPlace.get(`${placeKey(b, s, d)}#${cellKey(sl)}`);
    if (x) { s.slots[d] = { rep: '', ft: [] }; used.push(x); }
  });
  return used;
}
/** Empty every filled cell of a show, and say which ones they were. */
function takeStale(e, id) {
  const cells = [];
  for (const b of e.booths || []) for (const s of b.shifts || []) (s.slots || []).forEach((sl, d) => {
    if (!t(sl && sl.rep) && !((sl && sl.ft) || []).length) return;
    cells.push({ id, place: placeKey(b, s, d), cell: cellKey(sl), rep: t(sl.rep) });
    s.slots[d] = { rep: '', ft: [] };
  });
  return cells;
}

/** A new show on the board from a Sheet row (the sync's new rows and a book's first load). */
function newShowDoc(sheet, { resolve, status, dead = false, tier, startDate, endDate, datesEstimated = false, createdBy, keepReps = true }) {
  const year = Number(String(sheet.weekend || startDate || sheet.startDate || TODAY).slice(0, 4));
  const rep = r => (!keepReps || !isRep(r) && t(r) !== '__X__') ? '' : t(r) === '__X__' ? '__X__' : resolve(t(r));
  return {
    year, season: String(year), source: 'sheet-sync', name: sheet.name, weekend: sheet.weekend, days: sheet.days, dates: sheet.dates,
    startDate: startDate || sheet.startDate || sheet.weekend, endDate: endDate || sheet.endDate || sheet.startDate || sheet.weekend, datesEstimated,
    cityState: sheet.cityState || '', location: sheet.location || '', promoter: sheet.promoter || '', website: sheet.website || '',
    contact: sheet.contact || '', phone: sheet.phone || '', email: sheet.email || '',
    cost: sheet.cost || '', costNum: sheet.costNum ?? null, costBasis: sheet.costBasis || 'date', bestCPO: sheet.bestCPO || '',
    level: sheet.level || '', flag: sheet.flag || '', sheetStatus: sheet.sheetStatus || '', status, dead: !!dead,
    vcNumber: '', vcStatus: '', tier: tier || ruleTier(sheet.name, CFG.tierRules) || 'Traditional', access: 'Unassigned', address: '', setting: '', applyUrl: '', applyBy: '', notes: '',
    skipNext: false, neverWork: false,
    booths: (sheet.booths || []).map(b => ({ ...clone(b), shifts: b.shifts.map(s => ({ ...clone(s), slots: s.slots.map(sl => ({ rep: rep(sl.rep), ft: keepReps ? (sl.ft || []).map(x => resolve(t(x))) : [] })) })) })),
    createdAt: new Date().toISOString(), createdBy,
  };
}
const newId = (sheet, year) => `${year}-${normName(sheet.name).replace(/\s+/g, '-').slice(0, 40)}-s${Math.random().toString(36).slice(2, 7)}`;

// ---------- comparing ---------------------------------------------------------------------------
const sig = e => JSON.stringify((e.booths || []).map(b => [(b.days || []).length, (b.shifts || []).map(s => (s.slots || []).length)]));
const where = (e, b, s, d) => {
  const booth = e.booths[b], shift = booth.shifts[s];
  return [booth.label, shift.label, (booth.days || [])[d]].filter(x => t(x)).join(' / ');
};

export function planEvent({ base, sheet, board, resolve, vcRow, today, noVcPull = false }) {
  const slotKey = sl => repKey(sl && sl.rep, resolve) + '|' + ((sl && sl.ft) || []).map(x => repKey(x, resolve)).sort().join(',');
  const out = (raw) => { const s = t(raw); return !s || s === '__X__' ? s : resolve(s); };
  const outSlot = sl => ({ rep: out(sl && sl.rep), ft: ((sl && sl.ft) || []).map(out) });
  const patch = {}, held = [], conflicts = [], changes = [], keepBase = { fields: new Set(), slots: new Set(), whole: false };
  const upcoming = (lastDay(board) || '') >= today;                    // the show's own days, not a stale End Date cell
  const vcStatus = vcRow ? vcRow.status : board.vcStatus;
  const deadByVc = upcoming && !!t(vcStatus) && statusCategory(vcStatus) === 'dead';

  // scalar fields
  for (const f of SCALARS) {
    // a cost the event check took from VectorConnect is VC's (Alan, 2026-10-06): the Sheet's cost cell is not carried
    // over it and is never a conflict, the way column C never overrules VC's status
    if ((f === 'cost' || f === 'costNum') && t(board.costSource) === 'VC') continue;
    const s = t(sheet[f]), b0 = t(base[f]), bd = t(board[f]);
    if (s === b0 || bd === s) continue;
    // column C is the Sheet's own words (the board never edits sheetStatus), so the Sheet's change always carries: the
    // two books' differing column C must not turn into a standing conflict on handover morning
    if (bd === b0 || f === 'sheetStatus') { patch[f] = sheet[f] ?? ''; changes.push(`${f}: ${JSON.stringify(b0)} -> ${JSON.stringify(s)}`); }
    else { conflicts.push(`${f}: the Sheet changed it to ${JSON.stringify(s)} but the board already says ${JSON.stringify(bd)}`); keepBase.fields.add(f); }
  }

  // dates: carried like the rest, unless VectorConnect has the booking somewhere else. A start date far from
  // the event's own banner-resolved days is a stale cell, not a move (the Queen Creek October rows carry 11/1,
  // the placeholder's date, for markets on 10/10 and 10/24): it is never copied onto the board.
  const firstDay = (sheet.dates || []).filter(Boolean).sort()[0];
  // a blank Start Date cell is no date at all, never a move: it does not blank the board's dates (fill-dates or a
  // book's first load put one there)
  const staleStart = !!(firstDay && sheet.startDate && Math.abs(dayDiff(sheet.startDate, firstDay)) > 7) || !t(sheet.startDate);
  const datesArrayChanged = JSON.stringify(sheet.dates || []) !== JSON.stringify(base.dates || []);
  const dateChanged = (!staleStart && DATE_FIELDS.some(f => t(sheet[f]) !== t(base[f]))) || datesArrayChanged;
  let datesHeld = false;
  if (dateChanged) {
    // dates the board marks estimated (a roll-forward, a book's first load) are a placeholder, not anyone's edit:
    // the Sheet's real date replaces them
    const estimated = board.datesEstimated === true;
    const boardUntouched = estimated || DATE_FIELDS.every(f => t(board[f]) === t(base[f]));
    const alreadySame = DATE_FIELDS.every(f => t(board[f]) === t(sheet[f]));
    if (alreadySame) { if (estimated && !staleStart) { patch.datesEstimated = false; changes.push('dates: the Sheet confirms them (no longer estimated)'); } }
    else if (!boardUntouched) { conflicts.push(`dates: the Sheet moved them to ${sheet.startDate}..${sheet.endDate} but the board was edited to ${board.startDate}..${board.endDate}`); datesHeld = true; }
    else {
      const eff = effectiveDate({ weekend: sheet.weekend, startDate: sheet.startDate, dates: sheet.dates });
      if (vcRow && !deadByVc && statusCategory(vcRow.status) !== 'no-vc' && !inRun(eff, vcRow, CFG.dateSlackDays ?? 4)) {
        held.push(`dates: the Sheet moved it to ${sheet.startDate}..${sheet.endDate}, but VectorConnect has ${vcRow.eventNumber} on ${vcRow.startDate}..${vcRow.endDate} (${vcRow.status})`);
        datesHeld = true;
      } else if (!vcRow && noVcPull && t(board.vcNumber) && !(CFG.placeholders || []).includes(t(board.vcNumber)) && !deadByVc && statusCategory(board.vcStatus) !== 'no-vc') {
        held.push(`dates: the Sheet moved it to ${sheet.startDate}..${sheet.endDate}; VectorConnect has a record for it (${t(board.vcNumber)}, ${t(board.vcStatus) || 'no status'}) and this run had no VC pull to check the move against, so the Wednesday sync decides`);
        datesHeld = true;
      } else if (staleStart) {
        patch.dates = sheet.dates || [];
        changes.push(`days: ${(base.dates || []).filter(Boolean).join(', ')} -> ${(sheet.dates || []).filter(Boolean).join(', ')} (${t(sheet.startDate) ? `the Sheet's start date ${sheet.startDate} is stale` : 'the Sheet has no start date'}; not copied)`);
      } else {
        for (const f of DATE_FIELDS) patch[f] = sheet[f] || '';
        patch.dates = sheet.dates || [];
        if (estimated) patch.datesEstimated = false;
        changes.push(`dates: ${estimated ? `${board.startDate}..${board.endDate} (estimated)` : `${base.startDate}..${base.endDate}`} -> ${sheet.startDate}..${sheet.endDate}`);
      }
    }
    if (datesHeld) { for (const f of [...DATE_FIELDS, 'dates']) keepBase.fields.add(f); }
  }
  // a Start Date cell emptied on the Sheet: the board keeps its date, and so does the baseline, so the date the team
  // types next is a move from the one the board has, not a "board edited" conflict
  if (!t(sheet.startDate) && t(base.startDate)) for (const f of DATE_FIELDS) keepBase.fields.add(f);

  // shifts
  let slotChanges = 0;
  const slotsOf = e => JSON.stringify((e.booths || []).map(b => b.shifts.map(s => s.slots.map(slotKey))));
  const sameShape = sig(base) === sig(sheet) && sig(sheet) === sig(board);
  // The Sheet already has the board's rows and reps (a row removed on the board, then on the Sheet too): settled,
  // and the baseline moves on to it. Without this the old shape stayed the baseline and the show never synced again.
  const agreed = !sameShape && sig(sheet) === sig(board) && slotsOf(sheet) === slotsOf(board);
  if (agreed) {
    // nothing to carry and nothing held
  } else if (sameShape) {
    const booths = clone(board.booths || []); let touched = false;
    (sheet.booths || []).forEach((sb, b) => {
      const bb = base.booths[b], db = booths[b];
      for (const k of ['label']) if (t(sb[k]) !== t(bb[k]) && t(db[k]) === t(bb[k])) { db[k] = sb[k]; touched = true; changes.push(`booth ${b + 1} label -> ${JSON.stringify(sb[k])}`); }
      if (JSON.stringify(sb.days) !== JSON.stringify(bb.days) && JSON.stringify(db.days) === JSON.stringify(bb.days) && !datesHeld) {
        db.days = sb.days; db.dates = sb.dates; touched = true; changes.push(`booth ${b + 1} days -> ${sb.days.join(', ')}`);
      } else if (!datesHeld && JSON.stringify(sb.dates) !== JSON.stringify(bb.dates) && JSON.stringify(db.dates) === JSON.stringify(bb.dates)) { db.dates = sb.dates; touched = true; changes.push(`booth ${b + 1} dates -> ${(sb.dates || []).filter(Boolean).join(', ')}`); }
      (sb.shifts || []).forEach((ss, s) => {
        const bs = bb.shifts[s], ds = db.shifts[s];
        (ss.slots || []).forEach((sl, d) => {
          const k0 = slotKey(bs.slots[d]), ks = slotKey(sl), kd = slotKey(ds.slots[d]);
          if (ks === k0 || kd === ks) return;
          const label = `${where(sheet, b, s, d)}: ${JSON.stringify(t(bs.slots[d] && bs.slots[d].rep) || '(open)')} -> ${JSON.stringify(t(sl.rep) || '(open)')}`;
          if (kd !== k0) { conflicts.push(`${label}, but the board already has ${JSON.stringify(t(ds.slots[d] && ds.slots[d].rep) || '(open)')}`); keepBase.slots.add(`${b}.${s}.${d}`); return; }
          const adds = isRep(sl.rep) && repKey(sl.rep, resolve) !== repKey(ds.slots[d] && ds.slots[d].rep, resolve);
          if (adds && deadByVc) { held.push(`${label}: VectorConnect says ${vcStatus}, so no rep goes on it`); keepBase.slots.add(`${b}.${s}.${d}`); return; }
          ds.slots[d] = outSlot(sl); slotChanges++; touched = true; changes.push(label);
        });
      });
    });
    if (touched) patch.booths = booths;
  } else if (sig(sheet) !== sig(base)) {
    // The Sheet added or removed shift rows, booths or days. Safe only if the board still matches the old shape.
    const boardAsBase = sig(board) === sig(base) && slotsOf(board) === slotsOf(base);
    const addsReps = (sheet.booths || []).some(b => b.shifts.some(s => s.slots.some(sl => isRep(sl.rep))));
    if (!boardAsBase) { conflicts.push('the Sheet changed the shift rows, and the board\'s shifts no longer match the Sheet\'s last version (edited on the board, or set from the other book): make the two match'); keepBase.whole = true; }
    else if (deadByVc && addsReps) { held.push(`the Sheet rebuilt the shift rows with reps on them, but VectorConnect says ${vcStatus}`); keepBase.whole = true; }
    else if (datesHeld) { held.push('the Sheet rebuilt the shift rows along with a date change that is held'); keepBase.whole = true; }
    else {
      patch.booths = (sheet.booths || []).map(b => ({ ...clone(b), shifts: b.shifts.map(s => ({ ...clone(s), slots: s.slots.map(outSlot) })) }));
      patch.days = sheet.days || []; patch.dates = sheet.dates || [];
      const count = e => (e.booths || []).reduce((n, b) => n + b.shifts.reduce((m, s) => m + s.slots.filter(sl => isRep(sl.rep)).length, 0), 0);
      slotChanges += Math.max(1, Math.abs(count(sheet) - count(base)));
      changes.push(`shift rows rebuilt: ${sig(base)} -> ${sig(sheet)}`);
    }
  } else {
    const sheetAsBase = slotsOf(sheet) === slotsOf(base);
    if (!sheetAsBase) { conflicts.push('the Sheet changed shifts, and the board\'s shift rows (rows, booths or days) differ from the Sheet\'s (edited on the board, or set from the other book): make the two match'); keepBase.whole = true; }
  }
  if (keepBase.whole) { delete patch.booths; delete patch.days; delete patch.dates; }
  return { patch, held, conflicts, changes, slotChanges, keepBase };
}

/** The next baseline for one event: the Sheet's version, except wherever something was held. */
function nextBase(base, sheet, keep) {
  if (keep.whole) return clone(base);
  const nb = clone(sheet);
  for (const f of keep.fields) nb[f] = base[f];
  for (const k of keep.slots) { const [b, s, d] = k.split('.').map(Number); nb.booths[b].shifts[s].slots[d] = clone(base.booths[b].shifts[s].slots[d]); }
  return nb;
}

// ---------- one at a time -------------------------------------------------------------------------------
const LOCK = path.join(STATE, 'sheet-sync.lock');
const LOCK_WAIT_MS = Number(process.env.BOARD_SYNC_LOCK_WAIT_MS ?? 180000), LOCK_STALE_MS = 15 * 60000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** The lock, or null while another live sync holds it. A lock whose process is gone, or older than 15 minutes, is taken over. */
function tryLock() {
  fs.mkdirSync(STATE, { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try { fs.writeFileSync(LOCK, mine, { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held = {}; try { held = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { /* half-written: judge by age */ }
    let age = 0; try { age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { return tryLock(); }   // released between the two calls
    if (age < LOCK_STALE_MS && (!held.pid || alive(held.pid))) return null;
    fs.writeFileSync(LOCK, mine, { mode: 0o600 });
    if (fs.readFileSync(LOCK, 'utf8') !== mine) return null;       // two runs took over the same stale lock: the last writer has it
  }
  return () => { try { if (JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid === process.pid) fs.unlinkSync(LOCK); } catch { /* gone already */ } };
}
async function takeLock() {
  const t0 = Date.now();
  for (;;) {
    const release = tryLock();
    if (release || Date.now() - t0 >= LOCK_WAIT_MS) return release;
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ---------- on the record ---------------------------------------------------------------------------------
const cap = (a, n = 40) => (a || []).slice(0, n);
/** What the page shows about a run: counts and the lists, capped. Never promoter contacts (SCALARS has none). */
export const syncSummary = r => ({
  date: r.date, wrote: !!r.wrote, stopped: r.stopped || null, error: r.error || null,
  parsed: r.parsed ?? null, eventsTouched: r.eventsTouched ?? 0, slotChanges: r.slotChanges ?? 0, noVcPull: !!r.noVcPull,
  books: (r.books || []).map(b => ({ label: b.label, parsed: b.parsed ?? null, eventsTouched: b.eventsTouched ?? 0, slotChanges: b.slotChanges ?? 0, created: b.created ?? 0, lastYearsNamesHeldBack: b.staleDropped ?? 0 })),
  counts: Object.fromEntries(['applied', 'created', 'held', 'conflicts', 'flagged', 'duplicates', 'unresolved'].map(k => [k, (r[k] || []).length])),
  applied: cap(r.applied).map(a => ({ name: a.name, weekend: a.weekend, changes: cap(a.changes, 20) })),
  created: cap(r.created).map(c => ({ name: c.name, weekend: c.weekend, staffed: c.staffed, status: c.status })),
  held: cap(r.held).map(h => ({ name: h.name, weekend: h.weekend, why: h.why })),
  conflicts: cap(r.conflicts).map(c => ({ name: c.name, weekend: c.weekend, why: c.why })),
  flagged: cap(r.flagged), unresolved: cap(r.unresolved),
});
async function record(api, startedAt, r) {
  const status = r.stopped ? 'stopped' : r.wrote ? 'done' : 'failed';
  const row = { status, finished_at: new Date().toISOString(), result: syncSummary(r) };
  try {
    if (REQUESTS.length) {
      const moved = await api.syncs.move(REQUESTS, 'running', row);
      if (!moved || !moved.length) console.error(`sheet-sync: requests ${REQUESTS.join(',')} were no longer running; the result is in the report only`);
    } else await api.syncs.add({ requested_by: api.actor, started_at: startedAt, ...row });
  } catch (e) {
    // no sheet_syncs yet (schema.sql not re-run since 2026-09-28): the Wednesday job stays exactly as quiet as before
    if (/\b404\b|PGRST205|42P01/.test(e.message)) return;
    console.error(`sheet-sync: the run is not on the page's record (sheet_syncs: ${e.message.slice(0, 160)}). The sync itself ${r.wrote ? 'wrote the board' : 'is unaffected'}.`);
  }
}

// ---------- the run -----------------------------------------------------------------------------------
async function main() {
  const api = boardApi({ actor: 'service:sheet-sync' + (FIRST ? ':first-load' : VIA ? ':' + VIA : '') });
  const startedAt = new Date().toISOString();
  let release = null;
  if (APPLY) {
    release = await takeLock();
    if (!release) {
      let held = ''; try { held = fs.readFileSync(LOCK, 'utf8'); } catch { /* released just now */ }
      console.error(`sheet-sync: another sync still held ${LOCK} after ${Math.round(LOCK_WAIT_MS / 1000)} s (${held}). Nothing read or written.`);
      return 4;
    }
  }
  try { return FIRST ? await firstLoad(api, startedAt) : await run(api, startedAt); }
  catch (e) { if (APPLY) await record(api, startedAt, { date: TODAY, error: String(e.message || e).slice(0, 400) }); throw e; }
  finally { if (release) release(); }
}

/**
 * A row whose Start Date cell is blank or from another edition (the Jan-May 2027 book's March-May rows kept 2026's)
 * will have its dates and cost corrected wholesale when the team gets to it. That is the Sheet moving on, not the
 * parser drifting, so those fields of those rows are not counted toward the drift guard; a column moved still shows
 * in the place, promoter and website fields.
 */
const ROLLED_FIELDS = new Set(['startDate', 'endDate', 'dates', 'cost']);
const lastYearRow = e => { const first = (e.dates || []).filter(Boolean).sort()[0]; return !t(e.startDate) || !!(first && Math.abs(dayDiff(e.startDate, first)) > 7); };

/** A new show's dates: the Start Date cell when it belongs to the show's own days, else the days the weekend header gives. */
function datesFor(sheet, year = null) {
  const all = (sheet.dates || []).filter(Boolean).sort(), cell = t(sheet.startDate), end = t(sheet.endDate);
  const near = !!cell && (!all.length || Math.abs(dayDiff(cell, all[0])) <= 7) && (!year || cell.startsWith(String(year)));
  if (near) return { startDate: cell, endDate: end && dayDiff(end, cell) >= 0 && dayDiff(end, cell) <= 21 ? end : (all[all.length - 1] || cell), cellUsed: true };
  if (all.length) return { startDate: all[0], endDate: all[all.length - 1], cellUsed: false };
  return { startDate: sheet.weekend || '', endDate: sheet.weekend || '', cellUsed: false };
}

/**
 * What one book would change on the board: the three-way merge over the weekends it feeds today. `stale` is the
 * book's held-back cells (by board id); `fed` says which books feed each board show today (fedToday()).
 */
function planBook({ book, sheetEvents, baseEvents, boardById, boardByKey, resolve, vcByNumber, noVcPull, stale = [], fed = new Map() }) {
  const range = rangeOn(book, TODAY), mine = e => owned(range, e.weekend);
  const sheetIn = sheetEvents.filter(mine), baseIn = baseEvents.filter(mine);
  const { pairs, liveOnly, seedOnly } = matchToSeed(sheetIn, baseIn);
  const elsewhere = id => [...(fed.get(id) || [])].some(k => k !== book.key);   // another book feeds this show today

  // the drift guard: a structural field that moved on most events is the parser (or the Sheet's layout), not the team.
  // A show coming in on handover morning (its baseline set aside since the first load) is not counted: three months of
  // the team's edits are not the parser drifting, and the shows compared every run still catch a moved column.
  const drift = [];
  const counted = pairs.filter(p => !p.seed.frozen);
  for (const [k, f] of Object.entries(STRUCTURAL)) {
    const bad = counted.filter(p => !(ROLLED_FIELDS.has(k) && (lastYearRow(p.seed) || lastYearRow(p.live))) && f(p.live) !== f(p.seed)).length;
    if (counted.length >= 20 && bad > counted.length * (CFG.sync.structuralDriftShare ?? 0.1)) drift.push(`${book.label}: ${k} differs on ${bad} of ${counted.length}`);
  }

  // Two identical rows for one market on one day (a row copied up and the old one left behind) are one event:
  // same name, weekend, days and staffing. The board keeps one; the extra row is reported, never added.
  const staffKey = e => JSON.stringify((e.booths || []).map(b => (b.shifts || []).map(x => (x.slots || []).map(sl => repKey(sl.rep, resolve)))));
  const sameDays = (a, b) => JSON.stringify((a.dates || []).filter(Boolean)) === JSON.stringify((b.dates || []).filter(Boolean));
  const duplicates = [];
  for (const x of liveOnly) {
    const twin = sheetIn.find(o => o !== x && !liveOnly.includes(o) && normName(o.name) === normName(x.name) && o.weekend === x.weekend && sameDays(o, x) && staffKey(o) === staffKey(x));
    if (twin) duplicates.push({ sheet: x, twin });
  }
  const dupSet = new Set(duplicates.map(d => d.sheet));

  // last year's cells, by show; a show's names for matching include them (its board copy is blank)
  const staleBy = new Map();
  for (const x of stale) { if (!staleBy.has(x.id)) staleBy.set(x.id, []); staleBy.get(x.id).push(x); }
  const repSet = e => new Set([...(e.booths || []).flatMap(b => b.shifts.flatMap(s => s.slots.map(sl => repKey(sl.rep, resolve)))),
    ...(staleBy.get(e.id) || []).map(x => repKey(x.rep, resolve))].filter(k => k && k !== '__X__'));

  // renames (same weekend) and moves (same name, another weekend) among the unmatched. Only against events the
  // board still has, or a row the first load skipped (it stays skipped): an old-weekend event someone deleted on the
  // board is settled, and the Sheet's row is new.
  const renames = [], moves = [];
  for (const s of [...liveOnly]) {
    if (dupSet.has(s)) continue;
    let best = null;
    for (const b of seedOnly) {
      if (!b.skipped && (!b.id || !boardById.get(b.id))) continue;
      if (renames.some(r => r.base === b) || moves.some(m => m.base === b)) continue;
      if (normName(s.name) === normName(b.name) && s.weekend !== b.weekend) { best = { kind: 'move', b }; break; }
      if (s.weekend === b.weekend) {
        const A = repSet(s), B = repSet(b); const overlap = [...A].filter(x => B.has(x)).length;
        const score = nameScore(s.name, b.name);
        if (score >= 0.5 || (overlap >= 2 && overlap >= 0.6 * Math.max(A.size, B.size))) if (!best || score > (best.score || 0)) best = { kind: 'rename', b, score };
      }
    }
    if (!best) continue;
    (best.kind === 'move' ? moves : renames).push({ sheet: s, base: best.b });
  }
  const pairedSheet = new Set([...renames, ...moves].map(x => x.sheet)), pairedBase = new Set([...renames, ...moves].map(x => x.base));

  const plan = { label: book.label, key: book.key, applied: [], held: [], conflicts: [], created: [], flagged: [], heldBack: [], orphans: [],
    duplicates: duplicates.map(d => ({ name: d.sheet.name, weekend: d.sheet.weekend, rows: [d.twin.row, d.sheet.row] })) };
  // The weekends another book feeds today stay as they are (the Jan-May book's January-February until the handover),
  // marked frozen for the drift guard. A show no book feeds any more (a Sept-Feb-only show after the handover) is said once.
  const newBaseline = [];
  for (const e of baseEvents) {
    if (mine(e)) continue;
    const c = { ...clone(e), frozen: true };
    if (c.id && !c.orphanNoted && !fed.has(c.id) && boardById.has(c.id)) {
      c.orphanNoted = true;   // run() says it, unless another book takes the show in the same run
      plan.orphans.push({ id: c.id, text: `${c.name} (${c.weekend}) is only in the ${book.label} book, which no longer feeds that weekend${book.handover ? ` (since ${book.handover.on})` : ''}: changes to it on a Sheet no longer reach the board. Add it to the book that feeds it, or keep it up to date on the board (said once).` });
    }
    newBaseline.push(c);
  }
  let eventsTouched = 0, slotChanges = 0, staleDropped = 0;
  const writes = [], seenIds = new Set(), usedStale = new Set();

  for (const { live: sheet, seed: base } of [...pairs, ...renames.map(r => ({ live: r.sheet, seed: r.base }))]) {
    // a row the first load named as last year's copy of a show the board already has: followed, never written
    if (base.skipped) { newBaseline.push({ ...clone(sheet), id: null, skipped: base.skipped }); continue; }
    const board = base.id ? boardById.get(base.id) : null;
    if (!board) {
      // Deleted on the board on purpose, still on the Sheet. Say so once; never re-create it behind anyone's back.
      if (base.id && !base.boardDeleted) plan.flagged.push(`${sheet.name} (${sheet.weekend}) is still on the ${book.label} Sheet, but ${base.id} was deleted on the board. Not re-created (said once; put it back with board.mjs add if that was a mistake).`);
      if (base.id) newBaseline.push({ ...clone(sheet), id: base.id, boardDeleted: true });
      continue;
    }
    // one show, one book: if another book feeds this show today, this one leaves it alone
    if (elsewhere(board.id)) { plan.flagged.push(`${sheet.name} (${sheet.weekend}): the other book feeds this show today (${board.id}), so the ${book.label} book does not write it.`); newBaseline.push(clone(base)); continue; }
    seenIds.add(board.id);
    const used = dropStaleFor(sheet, staleBy.get(board.id));
    if (used.length) { staleDropped += used.length; used.forEach(x => usedStale.add(x)); plan.heldBack.push({ name: board.name, weekend: board.weekend, reps: [...new Set(used.map(x => x.rep).filter(isRep))] }); }
    // a placeholder record (00092192) books no particular date, so it can neither hold nor bless a date change
    const vcRow = board.vcNumber && !(CFG.placeholders || []).includes(String(board.vcNumber)) ? vcByNumber.get(String(board.vcNumber)) || null : null;
    const r = planEvent({ base, sheet, board, resolve, vcRow, today: TODAY, noVcPull });
    if (Object.keys(r.patch).length) { eventsTouched++; slotChanges += r.slotChanges; writes.push({ id: board.id, patch: r.patch }); plan.applied.push({ id: board.id, name: board.name, weekend: board.weekend, changes: r.changes }); }
    for (const h of r.held) plan.held.push({ id: board.id, name: board.name, weekend: board.weekend, why: h });
    for (const c of r.conflicts) plan.conflicts.push({ id: board.id, name: board.name, weekend: board.weekend, why: c });
    newBaseline.push({ ...nextBase(base, sheet, r.keepBase), id: board.id });
  }

  for (const { sheet, base } of moves) {
    if (base.skipped) { newBaseline.push({ ...clone(sheet), id: null, skipped: base.skipped }); continue; }   // a skipped row stays skipped wherever it goes
    plan.held.push({ id: base.id, name: base.name, weekend: base.weekend, why: `moved on the ${book.label} Sheet from the ${base.weekend} weekend to the ${sheet.weekend} weekend (start ${sheet.startDate || '?'}). Not moved on the board: say which is right.` });
    newBaseline.push(clone(base));
  }
  for (const base of seedOnly) {
    if (pairedBase.has(base)) continue;
    const b = base.id && boardById.get(base.id);
    if (!b) continue;                                        // deleted on both sides (or a skipped row gone): settled
    plan.flagged.push(`${base.name} (${base.weekend}) is no longer on the ${book.label} Sheet but is still on the board${b.vcNumber ? ` (VC ${b.vcNumber}, ${b.vcStatus || 'no status'})` : ''}. Not deleted: delete it on the board, or put it back on the Sheet.`);
    newBaseline.push(clone(base));
  }
  for (const sheet of liveOnly) {
    if (pairedSheet.has(sheet) || dupSet.has(sheet)) continue;
    const existing = boardByKey.get(keyOf(sheet));
    if (existing) {
      // one show, one book: a row matching a show another book feeds today is not linked (it links once that book lets go)
      if (elsewhere(existing.id)) { plan.flagged.push(`${sheet.name} (${sheet.weekend}) on the ${book.label} Sheet is a show the other book feeds today (${existing.id}): not linked, so the two books never both write it.`); continue; }
      // added on both sides independently: carry only what fills a blank on the board. What the two disagree on stays
      // blank in the baseline too, so it comes back as a conflict until someone decides (with the board's values there,
      // the next run took the Sheet's change over the board's)
      const fresh = { name: sheet.name, weekend: sheet.weekend, booths: (existing.booths || []).map(b => ({ ...b, shifts: b.shifts.map(s => ({ ...s, slots: s.slots.map(() => ({ rep: '', ft: [] })) })) })) };
      const r = planEvent({ base: fresh, sheet, board: existing, resolve, vcRow: existing.vcNumber ? vcByNumber.get(String(existing.vcNumber)) : null, today: TODAY, noVcPull });
      if (Object.keys(r.patch).length) { eventsTouched++; slotChanges += r.slotChanges; writes.push({ id: existing.id, patch: r.patch }); plan.applied.push({ id: existing.id, name: existing.name, weekend: existing.weekend, changes: r.changes }); }
      for (const c of r.conflicts) plan.conflicts.push({ id: existing.id, name: existing.name, weekend: existing.weekend, why: c });
      newBaseline.push({ ...nextBase(fresh, sheet, r.keepBase), id: existing.id });
      continue;
    }
    // A new row on a weekend where a show this book carries has gone missing, with names that show had: most likely
    // that show renamed past recognition ("Spring Fest 2026" -> "Spring Fest 2027"). Creating it could put last year's
    // names on the board as a staffed show; it waits for a person instead (and comes back each run until then).
    const reps = repSet(sheet);
    const lookalike = reps.size && seedOnly.find(b => !pairedBase.has(b) && b.weekend === sheet.weekend && [...repSet(b)].some(k => reps.has(k)));
    if (lookalike) {
      plan.held.push({ id: lookalike.id || null, name: sheet.name, weekend: sheet.weekend, why: `new on the ${book.label} Sheet, but it has names that ${lookalike.name} (gone from that weekend) had, so it may be that show renamed: not created. Put the old name back on the Sheet, or add it on the board.` });
      continue;
    }
    const staffed = staffedCount(sheet);
    const st = MESA.test(sheet.name) ? boardStatus('', sheet.sheetStatus, staffed) : { status: staffed > 0 ? 'Booking Request Needed' : 'Prospective', dead: false };
    const d = datesFor(sheet);
    const doc = newShowDoc(sheet, { resolve, status: st.status, dead: st.dead, tier: ruleTier(sheet.name, CFG.tierRules) || sheet.tierTag || 'Traditional',
      startDate: d.startDate, endDate: d.endDate, createdBy: 'service:sheet-sync' });
    if (t(sheet.startDate) && !d.cellUsed) doc.datesStale = true;            // the page marks it "est.": the row kept another edition's date
    const id = newId(sheet, doc.year);
    eventsTouched++; slotChanges += staffed;
    writes.push({ id, create: doc });
    plan.created.push({ id, name: sheet.name, weekend: sheet.weekend, staffed, status: st.status });
    newBaseline.push({ ...clone(sheet), id });
  }

  // a held-back cell is used up once its show was read and the cell said something else (a blank included); a show not
  // read this run (moved, gone, fed by the other book) keeps its entries
  const staleLeft = stale.filter(x => !seenIds.has(x.id) || usedStale.has(x));
  const over = [];
  if (eventsTouched > (CFG.sync.maxEventsTouched ?? 40)) over.push(`${book.label}: ${eventsTouched} events would change (limit ${CFG.sync.maxEventsTouched})`);
  if (slotChanges > (CFG.sync.maxSlotChanges ?? 250)) over.push(`${book.label}: ${slotChanges} shift changes (limit ${CFG.sync.maxSlotChanges})`);
  return { ...plan, range, inRange: sheetIn.length, matched: pairs.length, renames: renames.length, moves: moves.length, eventsTouched, slotChanges, drift, over, writes, newBaseline, staleLeft, staleDropped, staleUsedUp: stale.length - staleLeft.length };
}

async function run(api, startedAt) {
  if (ONLY && !BOOKS.some(b => b.key === ONLY)) throw new Error(`no book "${ONLY}" in config sheets (${BOOKS.map(b => b.key).join(', ')})`);
  const given = anyGiven();
  const books = BOOKS.map((b, i) => ({ book: b, i })).filter(({ book: b, i }) => (!ONLY || b.key === ONLY) && (!given || givenFor(b, i, 'grid') || givenFor(b, i, 'xlsx')));
  const [boardEvents, settings] = await Promise.all([api.events(), api.settings()]);
  const known = [...(settings.roster || []), ...(settings.former || [])];   // a rep who left is still known (their old shifts)
  const resolve = makeRepResolver(known);
  const boardById = new Map(boardEvents.map(e => [e.id, e]));
  const boardByKey = new Map(boardEvents.map(e => [keyOf(e), e]));
  const vc = opt('--vc') && fs.existsSync(opt('--vc')) ? JSON.parse(fs.readFileSync(opt('--vc'), 'utf8')) : null;
  const noVcPull = !vc;
  const vcByNumber = new Map(((vc && vc.rows) || []).map(r => [String(r.eventNumber), r]));
  const fed = fedToday();                                    // every book's, read or not this run (one show, one book)

  const results = [], missing = [], unresolved = new Set(), files = [];
  const roster = new Set(known.map(r => repKey(r, null)));
  for (const { book, i } of books) {
    const lb = loadBaseline(book);
    if (!lb) { missing.push(book); continue; }
    const { file, grid } = await readBook(book, i);
    files.push(path.basename(file));
    const { events: sheetEvents, warnings } = parseBook(book, grid);
    const stale = fs.existsSync(staleFile(book)) ? JSON.parse(fs.readFileSync(staleFile(book), 'utf8')) : [];
    const r = planBook({ book, sheetEvents, baseEvents: lb.events, boardById, boardByKey, resolve, vcByNumber, noVcPull, stale, fed });
    // reps nobody can place are carried as written, and named (last year's held-back names are not carried, so not named)
    for (const e of sheetEvents) if (owned(r.range, e.weekend)) for (const b of e.booths || []) for (const s of b.shifts) for (const sl of s.slots) {
      const x = t(sl.rep); if (isRep(x) && !roster.has(repKey(resolve(x), null))) unresolved.add(x);
    }
    results.push({ ...r, parsed: sheetEvents.length, warnings: warnings.map(w => `${book.label}: ${w}`), baseline: lb.source, hadStale: fs.existsSync(staleFile(book)) });
  }
  // a show a book let go of is flagged only if no book took it in this same run (the Jan-May book linking it on handover morning)
  const nowFed = new Set(results.flatMap(r => r.newBaseline.filter(e => e.id && owned(r.range, e.weekend)).map(e => e.id)));
  for (const r of results) r.flagged.push(...r.orphans.filter(o => !nowFed.has(o.id)).map(o => o.text));
  // a show two books would both write in one run (the guards above should make this impossible): nothing is written,
  // because the second write would silently replace the first
  const writers = new Map();
  for (const r of results) for (const w of r.writes) { if (!writers.has(w.id)) writers.set(w.id, new Set()); writers.get(w.id).add(r.label); }
  const twice = [...writers].filter(([, s]) => s.size > 1).map(([id, s]) => `${id} (${[...s].join(' and ')})`);

  const cat = k => results.flatMap(r => r[k] || []), sum = k => results.reduce((n, r) => n + (r[k] || 0), 0);
  const result = {
    date: TODAY, mode: APPLY ? 'apply' : 'dry', noVcPull, sheetFile: files.join(', '),
    baseline: results.map(r => `${r.label}: ${r.baseline}`).join('; '),
    books: results.map(r => ({ label: r.label, key: r.key, weekends: r.range, parsed: r.parsed, inRange: r.inRange, matched: r.matched, eventsTouched: r.eventsTouched, slotChanges: r.slotChanges, created: r.created.length, staleDropped: r.staleDropped, staleUsedUp: r.staleUsedUp })),
    parsed: sum('parsed'), matched: sum('matched'), renames: sum('renames'), moves: sum('moves'), eventsTouched: sum('eventsTouched'), slotChanges: sum('slotChanges'),
    drift: cat('drift'), over: cat('over'),
    applied: cat('applied'), held: cat('held'), conflicts: cat('conflicts'), created: cat('created'), flagged: cat('flagged'), duplicates: cat('duplicates'),
    heldBack: cat('heldBack'), unresolved: [...unresolved], warnings: cat('warnings'), wrote: false,
  };

  let code = 0;
  if (missing.length) { result.stopped = `${missing.map(b => `the ${b.label} book has no baseline yet (run sheet-sync.mjs --first-load ${b.key}, then again with --apply)`).join('; ')}. Nothing written.`; code = 5; }
  else if (result.drift.length) { result.stopped = `parser drift: ${result.drift.join('; ')}. Nothing written. Fix parse-sheet.mjs (or the column map) first.`; code = 2; }
  else if (twice.length) { result.stopped = `two books would both write the same show: ${twice.join('; ')}. Nothing written (one write would replace the other). Say which book feeds it.`; code = 6; }
  else if (result.over.length && !FORCE) { result.stopped = `over the limits: ${result.over.join('; ')}. Nothing written. Read the plan; re-run with --force if it is right.`; code = 3; }
  else if (APPLY) {
    for (const r of results) for (const w of r.writes) {
      if (w.create) await api.createEvent(w.id, w.create);
      else await api.patchEvent(w.id, w.patch);
    }
    for (const r of results) {
      const b = BOOKS.find(x => x.key === r.key);
      writePrivate(baselineFile(b), r.newBaseline);
      if (r.hadStale) writePrivate(staleFile(b), r.staleLeft);
    }
    writeCombined();
    result.wrote = true;
  }

  // the report
  const md = [];
  md.push(`# Sheet -> board sync, ${TODAY} (${result.mode}${result.wrote ? ', written' : ', nothing written'})`, '');
  md.push(`${result.eventsTouched} event(s) changed, ${result.slotChanges} shift change(s); ${result.created.length} new; ${result.held.length} held; ${result.conflicts.length} conflict(s); ${result.flagged.length} flagged.${noVcPull ? ' No VC pull on this run: date moves on shows VC has a record for are held.' : ''}`);
  for (const r of results) md.push(`- ${r.label} book: parsed ${r.parsed} events, ${r.inRange} on the weekends it feeds (${r.range.from || 'the start'} to ${r.range.to || 'the end'}); baseline ${r.baseline}${r.staleDropped ? `; ${r.staleDropped} cell(s) still holding last year's picks read as empty` : ''}${r.staleUsedUp ? `; ${r.staleUsedUp} of last year's cells now changed on the Sheet (theirs from now on)` : ''}.`);
  if (result.stopped) md.push('', `**STOPPED:** ${result.stopped}`);
  const each = (title, k, line) => { const rows = results.filter(r => (r[k] || []).length); if (!rows.length) return; md.push('', title); for (const r of rows) { if (results.length > 1) md.push(`### ${r.label} book`); for (const x of r[k]) md.push(line(x)); } };
  each('## Held (VectorConnect or a move says no; comes back next run until decided)', 'held', h => `- ${h.weekend} ${h.name}: ${h.why}`);
  each('## Conflicts (the Sheet and the board both changed it; neither touched)', 'conflicts', c => `- ${c.weekend} ${c.name}: ${c.why}`);
  each('## Flagged', 'flagged', f => `- ${f}`);
  each('## The same event twice on the Sheet (the board keeps one; tidy the Sheet when convenient)', 'duplicates', d => `- ${d.weekend} ${d.name}: rows ${d.rows.join(' and ')}, same day, same staffing`);
  each('## New events', 'created', c => `- ${c.weekend} ${c.name} (${c.staffed} shift(s), ${c.status}) [${c.id}]`);
  if (result.applied.length) { md.push('', '## Changed'); for (const r of results) { if (!r.applied.length) continue; if (results.length > 1) md.push(`### ${r.label} book`); for (const a of r.applied) { md.push(`- ${a.weekend} ${a.name}`); for (const c of a.changes) md.push(`    - ${c}`); } } }
  each('## Last year\'s names still on the Sheet, not on the board (a rep who took the same slot again only shows once the cell is cleared and typed again)', 'heldBack', h => `- ${h.weekend} ${h.name}: ${h.reps.join(', ') || '(x or set-up marks)'}`);
  if (result.unresolved.length) md.push('', `Names the roster cannot place (carried as written): ${result.unresolved.join(', ')}`);
  if (result.warnings.length) md.push('', `Parser warnings: ${result.warnings.join('; ')}`);
  fs.mkdirSync(OUT, { recursive: true });
  const stem = `sheet-sync-${TODAY}${TAG ? '-' + TAG : ''}`;
  fs.writeFileSync(path.join(OUT, `${stem}.md`), md.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, `${stem}.json`), JSON.stringify(result, null, 1));
  if (APPLY) await record(api, startedAt, result);
  if (flag('--json')) console.log(JSON.stringify(result, null, 1)); else console.log(md.join('\n'));
  return code;
}

// ---------- a book's first load ---------------------------------------------------------------------------
async function firstLoad(api, startedAt) {
  const book = BOOKS.find(b => b.key === FIRST);
  if (!book) throw new Error(`no book "${FIRST}" in config sheets (${BOOKS.map(b => b.key).join(', ')})`);
  const FL = book.firstLoad;
  if (!FL || !FL.year) throw new Error(`the ${book.label} book has no firstLoad settings in config/event-check.json`);
  if (fs.existsSync(baselineFile(book))) throw new Error(`the ${book.label} book is already on the board (state/${book.baseline} exists): the hourly sync carries it from here, and a first load runs once`);
  const i = BOOKS.indexOf(book);
  const { file, grid } = await readBook(book, i);
  const [boardEvents, settings] = await Promise.all([api.events(), api.settings()]);
  const resolve = makeRepResolver([...(settings.roster || []), ...(settings.former || [])]);
  const { events: sheetEvents, warnings } = parseBook(book, grid);
  const range = rangeOn(book, TODAY);
  const boardById = new Map(boardEvents.map(e => [e.id, e])), boardByKey = new Map(boardEvents.map(e => [keyOf(e), e]));
  // the shows the other books already put on the board, by the name and weekend their Sheet gives them
  const linkIds = new Map();
  for (const ob of BOOKS) if (ob !== book) { const lb = loadBaseline(ob); for (const e of (lb && lb.events) || []) if (e.id && boardById.has(e.id) && !linkIds.has(keyOf(e))) linkIds.set(keyOf(e), e.id); }
  for (const e of boardEvents) if (!linkIds.has(keyOf(e))) linkIds.set(keyOf(e), e.id);
  const skip = new Map((FL.skip || []).map(s => [`${normName(s.name)}|${s.weekend}`, s.why]));
  const dead = new RegExp(FL.deadPattern || '(?!)', 'i');
  const fed = fedToday();                                    // the other books' shows, by board id

  const plan = { later: [], unlinked: [], skipped: [], linked: [], created: [] };
  const baseline = [], stale = [], writes = [];
  for (const sheet of sheetEvents) {
    const k = keyOf(sheet);
    if (!owned(range, sheet.weekend)) {
      // a weekend another book feeds until the handover: remember the show as this book has it today, write nothing
      const id = linkIds.get(k);
      if (id) { baseline.push({ ...clone(sheet), id, frozen: true }); plan.later.push({ name: sheet.name, weekend: sheet.weekend, id }); }
      else plan.unlinked.push({ name: sheet.name, weekend: sheet.weekend });
      continue;
    }
    if (skip.has(k)) { baseline.push({ ...clone(sheet), id: null, skipped: skip.get(k) }); plan.skipped.push({ name: sheet.name, weekend: sheet.weekend, why: skip.get(k) }); continue; }
    const existing = boardByKey.get(k);
    if (existing && fed.has(existing.id)) {
      // one show, one book: another book feeds this show on the board today; this row is left off, and said so
      const why = `the ${[...fed.get(existing.id)].join(', ')} book feeds this show on the board (${existing.id})`;
      baseline.push({ ...clone(sheet), id: null, skipped: why }); plan.skipped.push({ name: sheet.name, weekend: sheet.weekend, why }); continue;
    }
    if (existing) { baseline.push({ ...clone(sheet), id: existing.id }); plan.linked.push({ name: sheet.name, weekend: sheet.weekend, id: existing.id }); continue; }
    // a new show from last year's row: none of its picks are this year's (the cells are kept, by the new show's id)
    const row = clone(sheet);
    const id = newId(row, Number(String(row.weekend || '').slice(0, 4)) || FL.year);
    const cells = takeStale(row, id);
    stale.push(...cells);
    const d = datesFor(row, FL.year);
    const out = dead.test(row.sheetStatus) || dead.test(row.levelCell || '');
    const doc = newShowDoc(row, { resolve, status: out ? 'Cancelled' : 'Prospective', dead: out, tier: ruleTier(row.name, CFG.tierRules) || row.tierTag || 'Traditional',
      startDate: d.startDate, endDate: d.endDate, datesEstimated: !d.cellUsed, createdBy: 'service:sheet-sync:first-load', keepReps: false });
    writes.push({ id, doc });
    // the baseline keeps the Sheet's own cells (blank or last year's): staying that way is no change, and the team's
    // real date coming in replaces the board's estimate (planEvent: estimated board dates are nobody's edit)
    baseline.push({ ...row, id });
    plan.created.push({ id, name: row.name, weekend: row.weekend, status: doc.status, tier: doc.tier, startDate: doc.startDate, endDate: doc.endDate, estimated: doc.datesEstimated, cost: doc.cost, notCarried: [...new Set(cells.map(c => c.rep).filter(r => r && r !== '__X__'))] });
  }

  // What the handover will leave behind or trip on, said now: the other books' shows on the weekends this book takes over
  // that it does not have (nothing syncs them after the handover), and remembered shows whose shift rows differ from
  // the board's (a change to their shifts on this book is a conflict until the two match)
  const laterIds = new Set(plan.later.map(x => x.id));
  plan.onlyInOther = [];
  if (book.handover) for (const ob of BOOKS) if (ob !== book) for (const e of (loadBaseline(ob) || { events: [] }).events)
    if (e.id && boardById.has(e.id) && owned(rangeOn(ob, TODAY), e.weekend) && owned(book.handover.weekends, e.weekend) && !owned(range, e.weekend) && !laterIds.has(e.id))
      plan.onlyInOther.push({ name: e.name, weekend: e.weekend, book: ob.label, id: e.id });
  plan.shapeDiffers = plan.later.filter(x => { const s = sheetEvents.find(e => keyOf(e) === keyOf(x)); return s && sig(s) !== sig(boardById.get(x.id)); });
  const result = { date: TODAY, mode: APPLY ? 'apply' : 'dry', book: book.label, sheetFile: path.basename(file), weekends: range, parsed: sheetEvents.length,
    ...plan, staleCells: stale.length, warnings, wrote: false, readBack: null };
  let code = 0;
  if (writes.length > (FL.maxCreate ?? 150)) { result.stopped = `${writes.length} new shows is more than firstLoad.maxCreate (${FL.maxCreate ?? 150}). Nothing written.`; code = 3; }
  else if (APPLY) {
    for (const w of writes) await api.createEvent(w.id, w.doc);
    writePrivate(staleFile(book), stale);
    writePrivate(baselineFile(book), baseline);
    // the other books' baselines move to their own files before the combined one is rewritten (the first time only)
    for (const ob of BOOKS) if (ob !== book && !fs.existsSync(baselineFile(ob))) { const lb = loadBaseline(ob); if (lb) writePrivate(baselineFile(ob), lb.events); }
    writeCombined();
    result.wrote = true;
    // every show written is read back
    const bad = [];
    for (const w of writes) {
      const back = await api.row('events', w.id);
      const filled = back && (back.booths || []).some(b => b.shifts.some(s => s.slots.some(sl => t(sl.rep) || (sl.ft || []).length)));
      if (!back || back.name !== w.doc.name || back.weekend !== w.doc.weekend || back.status !== w.doc.status || back.startDate !== w.doc.startDate || filled) bad.push(w.id);
    }
    result.readBack = { checked: writes.length, ok: writes.length - bad.length, bad };
    if (bad.length) code = 1;
    await record(api, startedAt, { date: TODAY, wrote: true, parsed: sheetEvents.length, eventsTouched: writes.length, slotChanges: 0, noVcPull: true,
      created: plan.created.map(c => ({ name: c.name, weekend: c.weekend, staffed: 0, status: c.status })), applied: [], held: [], conflicts: [],
      flagged: bad.length ? [`${bad.length} new show(s) did not read back as written: ${bad.join(', ')}`] : [], unresolved: [], duplicates: [], books: [{ label: book.label, parsed: sheetEvents.length, created: writes.length }] });
  }

  const md = [`# ${book.label} book: first load onto the board, ${TODAY} (${result.mode}${result.wrote ? ', written' : ', nothing written'})`, ''];
  md.push(`Parsed ${result.parsed} shows. It feeds the weekends from ${range.from || 'the start'} to ${range.to || 'the end'} today${book.handover ? ` (from ${book.handover.weekends.from || 'the start'} on ${book.handover.on})` : ''}.`);
  md.push(`${plan.created.length} new on the board (${plan.created.filter(c => c.status === 'Cancelled').length} of them Cancelled), ${plan.skipped.length} skipped, ${plan.linked.length} already on the board, ${plan.later.length} remembered for the handover, ${plan.unlinked.length} the board has no match for. ${stale.length} filled cell(s) from last year not carried.`);
  if (result.stopped) md.push('', `**STOPPED:** ${result.stopped}`);
  if (result.readBack) md.push('', `Read back: ${result.readBack.ok} of ${result.readBack.checked} as written${result.readBack.bad.length ? `; NOT as written: ${result.readBack.bad.join(', ')}` : ''}.`);
  if (plan.created.length) { md.push('', '## New on the board'); for (const c of plan.created) md.push(`- ${c.weekend} ${c.name}: ${c.status}${c.tier !== 'Traditional' ? `, ${c.tier}` : ''}, ${c.startDate}${c.endDate !== c.startDate ? '..' + c.endDate : ''}${c.estimated ? ' (est.)' : ''}${c.cost ? `, ${c.cost}` : ''}${c.notCarried.length ? `; last year's names not carried: ${c.notCarried.join(', ')}` : ''} [${c.id}]`); }
  if (plan.skipped.length) { md.push('', '## Skipped'); for (const s of plan.skipped) md.push(`- ${s.weekend} ${s.name}: ${s.why}`); }
  if (plan.linked.length) { md.push('', '## Already on the board (followed from now on, nothing written)'); for (const s of plan.linked) md.push(`- ${s.weekend} ${s.name} [${s.id}]`); }
  if (plan.later.length) { md.push('', `## Remembered for the handover (${plan.later.length} shows another book feeds until then)`); md.push(plan.later.map(s => `${s.weekend} ${s.name}`).join('; ')); }
  if (plan.unlinked.length) { md.push('', '## On this book for a weekend another book feeds, with no show on the board to match (created on handover morning if still there)'); for (const s of plan.unlinked) md.push(`- ${s.weekend} ${s.name}`); }
  if (plan.onlyInOther.length) { md.push('', `## Only in the other book, on weekends this book takes over${book.handover ? ` on ${book.handover.on}` : ''} (nothing syncs them after that unless they are added here)`); for (const s of plan.onlyInOther) md.push(`- ${s.weekend} ${s.name} (${s.book} book) [${s.id}]`); }
  if (plan.shapeDiffers.length) { md.push('', '## Remembered shows whose shift rows differ between this book and the board (after the handover, a change to their shifts here is a conflict until the two match)'); for (const s of plan.shapeDiffers) md.push(`- ${s.weekend} ${s.name} [${s.id}]`); }
  if (warnings.length) md.push('', `Parser warnings: ${warnings.join('; ')}`);
  fs.mkdirSync(OUT, { recursive: true });
  const stem = `sheet-first-load-${book.key}-${TODAY}`;
  fs.writeFileSync(path.join(OUT, `${stem}.md`), md.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, `${stem}.json`), JSON.stringify(result, null, 1));
  if (flag('--json')) console.log(JSON.stringify(result, null, 1)); else console.log(md.join('\n'));
  return code;
}

if (isMain(import.meta.url)) {
  main().then(c => process.exit(c)).catch(e => { console.error('sheet-sync: ' + (e.stack || e.message)); process.exit(1); });
}
