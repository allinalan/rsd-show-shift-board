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
  and the event's own details (name, place, promoter, cost, dates, column C as sheetStatus). Not promoter
  contacts: those are edited on the board (see SCALARS for why).

  VECTORCONNECT WINS. Status never comes from the Sheet: column C is the team's free text (kept as
  sheetStatus, for display) and the VC columns Z/AA froze on 9/9. A rep added to a show VC calls dead is
  held. A date moved away from a VC-booked record is held. An event deleted from the Sheet is flagged,
  never deleted from the board. An event that moved weekends is flagged, never duplicated. Held changes
  stay pending: the baseline keeps the old value, so they come back every run until someone decides.

  FAILS CLOSED. A parser that drifts (a structural field differs on more than a tenth of the matched
  events: a column inserted, a tab rebuilt) or a run that would touch an unusual amount writes nothing.

  Usage:
    sheet-sync.mjs [--apply] [--xlsx file] [--vc vc-my-events.json] [--force] [--date YYYY-MM-DD]
  Dry by default: prints the plan and writes out/reports/sheet-sync-<date>.{md,json}; touches neither the
  board nor the baseline. --apply writes the board, then the baseline.
  Exit: 0 ok · 1 error · 2 parser drift · 3 over the change limits (read the plan, then --force)
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseAll, makeRepResolver, repKey, boardStatus, staffedCount, matchToSeed, STRUCTURAL, readGrid, normName } from './parse-sheet.mjs';
import { boardApi } from './lib/board-api.mjs';
import { nameScore, statusCategory, effectiveDate, inRun, dayDiff, ruleTier } from './lib/match.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const APPLY = flag('--apply'), FORCE = flag('--force');
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
// BOARD_STATE_DIR / BOARD_OUT_DIR point the tests at temp dirs; production uses the repo's state/ and out/.
const STATE = process.env.BOARD_STATE_DIR || path.join(REPO, 'state'), BASELINE = path.join(STATE, 'sheet-baseline.json');
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

// ---------- the Sheet -------------------------------------------------------------------------
async function sheetFile() {
  if (opt('--xlsx')) return opt('--xlsx');
  const url = `https://docs.google.com/spreadsheets/d/${CFG.sheet.fileId}/export?format=xlsx`;
  const r = await fetch(url, { redirect: 'follow' });
  const buf = Buffer.from(await r.arrayBuffer());
  // An xlsx is a zip. Anything else (a Google sign-in page, an error page) must never be parsed as "no events".
  if (!r.ok || buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b)
    throw new Error(`the Sheet export did not come back as a workbook (HTTP ${r.status}, ${buf.length} bytes). Is the Sheet still link-shared? ${url}`);
  fs.mkdirSync(OUT_BASE, { recursive: true });
  const f = path.join(OUT_BASE, `sheet-${TODAY}.xlsx`);
  fs.writeFileSync(f, buf, { mode: 0o600 });
  return f;
}

function loadBaseline() {
  if (fs.existsSync(BASELINE)) return { events: JSON.parse(fs.readFileSync(BASELINE, 'utf8')), source: 'state/sheet-baseline.json' };
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'seed', 'events.json'), 'utf8'));
  const cf = path.join(REPO, 'seed', 'private', 'event_contacts.json');
  const contacts = fs.existsSync(cf) ? new Map(JSON.parse(fs.readFileSync(cf, 'utf8')).map(c => [c.id, c])) : new Map();
  for (const e of seed) { const c = contacts.get(e.id); if (c) for (const k of ['contact', 'phone', 'email']) if (c[k] != null) e[k] = c[k]; }
  return { events: seed, source: 'seed/events.json (first sync: the Sheet as of 2026-09-20)' };
}

// ---------- comparing ---------------------------------------------------------------------------
const sig = e => JSON.stringify((e.booths || []).map(b => [(b.days || []).length, (b.shifts || []).map(s => (s.slots || []).length)]));
const where = (e, b, s, d) => {
  const booth = e.booths[b], shift = booth.shifts[s];
  return [booth.label, shift.label, (booth.days || [])[d]].filter(x => t(x)).join(' / ');
};

export function planEvent({ base, sheet, board, resolve, vcRow, today }) {
  const slotKey = sl => repKey(sl && sl.rep, resolve) + '|' + ((sl && sl.ft) || []).map(x => repKey(x, resolve)).sort().join(',');
  const out = (raw) => { const s = t(raw); return !s || s === '__X__' ? s : resolve(s); };
  const outSlot = sl => ({ rep: out(sl && sl.rep), ft: ((sl && sl.ft) || []).map(out) });
  const patch = {}, held = [], conflicts = [], changes = [], keepBase = { fields: new Set(), slots: new Set(), whole: false };
  const upcoming = (board.endDate || board.startDate || board.weekend || '') >= today;
  const vcStatus = vcRow ? vcRow.status : board.vcStatus;
  const deadByVc = upcoming && !!t(vcStatus) && statusCategory(vcStatus) === 'dead';

  // scalar fields
  for (const f of SCALARS) {
    const s = t(sheet[f]), b0 = t(base[f]), bd = t(board[f]);
    if (s === b0 || bd === s) continue;
    if (bd === b0) { patch[f] = sheet[f] ?? ''; changes.push(`${f}: ${JSON.stringify(b0)} -> ${JSON.stringify(s)}`); }
    else { conflicts.push(`${f}: the Sheet changed it to ${JSON.stringify(s)} but the board already says ${JSON.stringify(bd)}`); keepBase.fields.add(f); }
  }

  // dates: carried like the rest, unless VectorConnect has the booking somewhere else. A start date far from
  // the event's own banner-resolved days is a stale cell, not a move (the Queen Creek October rows carry 11/1,
  // the placeholder's date, for markets on 10/10 and 10/24): it is never copied onto the board.
  const firstDay = (sheet.dates || []).filter(Boolean).sort()[0];
  const staleStart = !!(firstDay && sheet.startDate && Math.abs(dayDiff(sheet.startDate, firstDay)) > 7);
  const datesArrayChanged = JSON.stringify(sheet.dates || []) !== JSON.stringify(base.dates || []);
  const dateChanged = (!staleStart && DATE_FIELDS.some(f => t(sheet[f]) !== t(base[f]))) || datesArrayChanged;
  let datesHeld = false;
  if (dateChanged) {
    const boardUntouched = DATE_FIELDS.every(f => t(board[f]) === t(base[f]));
    const alreadySame = DATE_FIELDS.every(f => t(board[f]) === t(sheet[f]));
    if (alreadySame) { /* nothing to do */ }
    else if (!boardUntouched) { conflicts.push(`dates: the Sheet moved them to ${sheet.startDate}..${sheet.endDate} but the board was edited to ${board.startDate}..${board.endDate}`); datesHeld = true; }
    else {
      const eff = effectiveDate({ weekend: sheet.weekend, startDate: sheet.startDate, dates: sheet.dates });
      if (vcRow && !deadByVc && statusCategory(vcRow.status) !== 'no-vc' && !inRun(eff, vcRow, CFG.dateSlackDays ?? 4)) {
        held.push(`dates: the Sheet moved it to ${sheet.startDate}..${sheet.endDate}, but VectorConnect has ${vcRow.eventNumber} on ${vcRow.startDate}..${vcRow.endDate} (${vcRow.status})`);
        datesHeld = true;
      } else if (staleStart) {
        patch.dates = sheet.dates || [];
        changes.push(`days: ${(base.dates || []).filter(Boolean).join(', ')} -> ${(sheet.dates || []).filter(Boolean).join(', ')} (the Sheet's start date ${sheet.startDate} is stale; not copied)`);
      } else {
        for (const f of DATE_FIELDS) patch[f] = sheet[f] || '';
        patch.dates = sheet.dates || [];
        changes.push(`dates: ${base.startDate}..${base.endDate} -> ${sheet.startDate}..${sheet.endDate}`);
      }
    }
    if (datesHeld) { for (const f of [...DATE_FIELDS, 'dates']) keepBase.fields.add(f); }
  }

  // shifts
  let slotChanges = 0;
  const sameShape = sig(base) === sig(sheet) && sig(sheet) === sig(board);
  if (sameShape) {
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
    const boardAsBase = sig(board) === sig(base) && JSON.stringify((board.booths || []).map(b => b.shifts.map(s => s.slots.map(slotKey)))) ===
                                                     JSON.stringify((base.booths || []).map(b => b.shifts.map(s => s.slots.map(slotKey))));
    const addsReps = (sheet.booths || []).some(b => b.shifts.some(s => s.slots.some(sl => isRep(sl.rep))));
    if (!boardAsBase) { conflicts.push('the Sheet changed the shift rows, and the board\'s shifts were edited too'); keepBase.whole = true; }
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
    const sheetAsBase = JSON.stringify((sheet.booths || []).map(b => b.shifts.map(s => s.slots.map(slotKey)))) ===
                        JSON.stringify((base.booths || []).map(b => b.shifts.map(s => s.slots.map(slotKey))));
    if (!sheetAsBase) { conflicts.push('the board\'s shift rows were edited, and the Sheet changed shifts too'); keepBase.whole = true; }
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

// ---------- the run -----------------------------------------------------------------------------------
async function main() {
  const api = boardApi({ actor: 'service:sheet-sync' });
  // --grid <json>: a pre-dumped grid (tests; this repo is public, so no real Sheet data lives in it)
  const file = opt('--grid') ? opt('--grid') : await sheetFile();
  const [boardEvents, settings] = await Promise.all([api.events(), api.settings()]);
  const grid = opt('--grid') ? JSON.parse(fs.readFileSync(opt('--grid'), 'utf8')) : await readGrid(file, CFG.sheet.tab);
  const seasonYear = /^\d{4}$/.test(String(CFG.sheet.tab)) ? Number(CFG.sheet.tab) : 2026;
  const { events: sheetEvents, warnings } = parseAll(grid, { seasonYear });
  const resolve = makeRepResolver(settings.roster || []);
  const { events: baseEvents, source: baseSource } = loadBaseline();
  const boardById = new Map(boardEvents.map(e => [e.id, e]));
  const boardByKey = new Map(boardEvents.map(e => [`${normName(e.name)}|${e.weekend || ''}`, e]));
  const vc = opt('--vc') && fs.existsSync(opt('--vc')) ? JSON.parse(fs.readFileSync(opt('--vc'), 'utf8')) : null;
  const vcByNumber = new Map(((vc && vc.rows) || []).map(r => [String(r.eventNumber), r]));

  const { pairs, liveOnly, seedOnly } = matchToSeed(sheetEvents, baseEvents);

  // the drift guard: a structural field that moved on most events is the parser (or the Sheet's layout), not the team
  const drift = [];
  for (const [k, f] of Object.entries(STRUCTURAL)) {
    const bad = pairs.filter(p => f(p.live) !== f(p.seed)).length;
    if (pairs.length >= 20 && bad > pairs.length * (CFG.sync.structuralDriftShare ?? 0.1)) drift.push(`${k} differs on ${bad} of ${pairs.length}`);
  }

  // Two identical rows for one market on one day (a row copied up and the old one left behind) are one event:
  // same name, weekend, days and staffing. The board keeps one; the extra row is reported, never added.
  const staffKey = e => JSON.stringify((e.booths || []).map(b => (b.shifts || []).map(x => (x.slots || []).map(sl => repKey(sl.rep, resolve)))));
  const sameDays = (a, b) => JSON.stringify((a.dates || []).filter(Boolean)) === JSON.stringify((b.dates || []).filter(Boolean));
  const duplicates = [];
  for (const x of liveOnly) {
    const twin = sheetEvents.find(o => o !== x && !liveOnly.includes(o) && normName(o.name) === normName(x.name) && o.weekend === x.weekend && sameDays(o, x) && staffKey(o) === staffKey(x));
    if (twin) duplicates.push({ sheet: x, twin });
  }
  const dupSet = new Set(duplicates.map(d => d.sheet));

  // renames (same weekend) and moves (same name, another weekend) among the unmatched. Only against events the
  // board still has: an old-weekend event someone deleted on the board is settled, and the Sheet's row is new.
  const renames = [], moves = [];
  const repSet = e => new Set((e.booths || []).flatMap(b => b.shifts.flatMap(s => s.slots.map(sl => repKey(sl.rep, resolve)).filter(k => k && k !== '__X__'))));
  for (const s of [...liveOnly]) {
    if (dupSet.has(s)) continue;
    let best = null;
    for (const b of seedOnly) {
      if (!b.id || !boardById.get(b.id)) continue;
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

  const plan = { applied: [], held: [], conflicts: [], created: [], flagged: [], unresolved: [], warnings,
    duplicates: duplicates.map(d => ({ name: d.sheet.name, weekend: d.sheet.weekend, rows: [d.twin.row, d.sheet.row] })) };
  const newBaseline = [];
  let eventsTouched = 0, slotChanges = 0;
  const writes = [];

  for (const { live: sheet, seed: base } of [...pairs, ...renames.map(r => ({ live: r.sheet, seed: r.base }))]) {
    const board = base.id ? boardById.get(base.id) : null;
    if (!board) {
      // Deleted on the board on purpose, still on the Sheet. Say so once; never re-create it behind anyone's back.
      if (base.id && !base.boardDeleted) plan.flagged.push(`${sheet.name} (${sheet.weekend}) is still on the Sheet, but ${base.id} was deleted on the board. Not re-created (said once; put it back with board.mjs add if that was a mistake).`);
      if (base.id) newBaseline.push({ ...clone(sheet), id: base.id, boardDeleted: true });
      continue;
    }
    // a placeholder record (00092192) books no particular date, so it can neither hold nor bless a date change
    const vcRow = board.vcNumber && !(CFG.placeholders || []).includes(String(board.vcNumber)) ? vcByNumber.get(String(board.vcNumber)) || null : null;
    const r = planEvent({ base, sheet, board, resolve, vcRow, today: TODAY });
    if (Object.keys(r.patch).length) { eventsTouched++; slotChanges += r.slotChanges; writes.push({ id: board.id, patch: r.patch }); plan.applied.push({ id: board.id, name: board.name, weekend: board.weekend, changes: r.changes }); }
    for (const h of r.held) plan.held.push({ id: board.id, name: board.name, weekend: board.weekend, why: h });
    for (const c of r.conflicts) plan.conflicts.push({ id: board.id, name: board.name, weekend: board.weekend, why: c });
    newBaseline.push({ ...nextBase(base, sheet, r.keepBase), id: board.id });
  }

  for (const { sheet, base } of moves) {
    plan.held.push({ id: base.id, name: base.name, weekend: base.weekend, why: `moved on the Sheet from the ${base.weekend} weekend to the ${sheet.weekend} weekend (start ${sheet.startDate || '?'}). Not moved on the board: say which is right.` });
    newBaseline.push(clone(base));
  }
  for (const base of seedOnly) {
    if (pairedBase.has(base)) continue;
    const b = base.id && boardById.get(base.id);
    if (!b) continue;                                        // deleted on both sides: settled
    plan.flagged.push(`${base.name} (${base.weekend}) is no longer on the Sheet but is still on the board${b.vcNumber ? ` (VC ${b.vcNumber}, ${b.vcStatus || 'no status'})` : ''}. Not deleted: delete it on the board, or put it back on the Sheet.`);
    newBaseline.push(clone(base));
  }
  for (const sheet of liveOnly) {
    if (pairedSheet.has(sheet) || dupSet.has(sheet)) continue;
    const existing = boardByKey.get(`${normName(sheet.name)}|${sheet.weekend || ''}`);
    if (existing) {
      // added on both sides independently: carry only what fills a blank on the board
      const r = planEvent({ base: { booths: (existing.booths || []).map(b => ({ ...b, shifts: b.shifts.map(s => ({ ...s, slots: s.slots.map(() => ({ rep: '', ft: [] })) })) })) }, sheet, board: existing, resolve, vcRow: existing.vcNumber ? vcByNumber.get(String(existing.vcNumber)) : null, today: TODAY });
      if (Object.keys(r.patch).length) { eventsTouched++; slotChanges += r.slotChanges; writes.push({ id: existing.id, patch: r.patch }); plan.applied.push({ id: existing.id, name: existing.name, weekend: existing.weekend, changes: r.changes }); }
      for (const c of r.conflicts) plan.conflicts.push({ id: existing.id, name: existing.name, weekend: existing.weekend, why: c });
      newBaseline.push({ ...nextBase({ ...sheet, booths: existing.booths }, sheet, r.keepBase), id: existing.id });
      continue;
    }
    const staffed = staffedCount(sheet);
    const mesa = MESA.test(sheet.name);
    const st = mesa ? boardStatus('', sheet.sheetStatus, staffed) : { status: staffed > 0 ? 'Booking Request Needed' : 'Prospective', dead: false };
    const year = Number(String(sheet.weekend || sheet.startDate || TODAY).slice(0, 4));
    const slug = normName(sheet.name).replace(/\s+/g, '-').slice(0, 40);
    const id = `${year}-${slug}-s${Math.random().toString(36).slice(2, 7)}`;
    const doc = {
      year, season: String(year), source: 'sheet-sync', name: sheet.name, weekend: sheet.weekend, days: sheet.days, dates: sheet.dates,
      startDate: sheet.startDate || sheet.weekend, endDate: sheet.endDate || sheet.startDate || sheet.weekend, datesEstimated: false,
      cityState: sheet.cityState || '', location: sheet.location || '', promoter: sheet.promoter || '', website: sheet.website || '',
      contact: sheet.contact || '', phone: sheet.phone || '', email: sheet.email || '',
      cost: sheet.cost || '', costNum: sheet.costNum ?? null, costBasis: sheet.costBasis || 'date', bestCPO: sheet.bestCPO || '',
      level: sheet.level || '', flag: sheet.flag || '', sheetStatus: sheet.sheetStatus || '', status: st.status, dead: !!st.dead,
      vcNumber: '', vcStatus: '', tier: ruleTier(sheet.name, CFG.tierRules) || 'Traditional', access: 'Unassigned', address: '', setting: '', applyUrl: '', applyBy: '', notes: '',
      skipNext: false, neverWork: false,
      booths: (sheet.booths || []).map(b => ({ ...clone(b), shifts: b.shifts.map(s => ({ ...clone(s), slots: s.slots.map(sl => ({ rep: isRep(sl.rep) || t(sl.rep) === '__X__' ? (t(sl.rep) === '__X__' ? '__X__' : resolve(t(sl.rep))) : '', ft: (sl.ft || []).map(x => resolve(t(x))) })) })) })),
      createdAt: new Date().toISOString(), createdBy: 'service:sheet-sync',
    };
    eventsTouched++; slotChanges += staffed;
    writes.push({ id, create: doc });
    plan.created.push({ id, name: sheet.name, weekend: sheet.weekend, staffed, status: st.status });
    newBaseline.push({ ...clone(sheet), id });
  }

  // reps nobody can place are carried as written, and named
  const roster = new Set((settings.roster || []).map(r => repKey(r, null)));
  const unresolved = new Set();
  for (const e of sheetEvents) for (const b of e.booths || []) for (const s of b.shifts) for (const sl of s.slots) {
    const r = t(sl.rep); if (isRep(r) && !roster.has(repKey(resolve(r), null))) unresolved.add(r);
  }
  plan.unresolved = [...unresolved];

  const over = [];
  if (eventsTouched > (CFG.sync.maxEventsTouched ?? 40)) over.push(`${eventsTouched} events would change (limit ${CFG.sync.maxEventsTouched})`);
  if (slotChanges > (CFG.sync.maxSlotChanges ?? 250)) over.push(`${slotChanges} shift changes (limit ${CFG.sync.maxSlotChanges})`);

  const result = {
    date: TODAY, mode: APPLY ? 'apply' : 'dry', baseline: baseSource, sheetFile: path.basename(file),
    parsed: sheetEvents.length, matched: pairs.length, renames: renames.length, moves: moves.length,
    eventsTouched, slotChanges, drift, over, ...plan, wrote: false,
  };

  let code = 0;
  if (drift.length) { result.stopped = `parser drift: ${drift.join('; ')}. Nothing written. Fix parse-sheet.mjs (or the column map) first.`; code = 2; }
  else if (over.length && !FORCE) { result.stopped = `over the limits: ${over.join('; ')}. Nothing written. Read the plan; re-run with --force if it is right.`; code = 3; }
  else if (APPLY) {
    for (const w of writes) {
      if (w.create) await api.createEvent(w.id, w.create);
      else await api.patchEvent(w.id, w.patch);
    }
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(BASELINE + '.tmp', JSON.stringify(newBaseline, null, 1), { mode: 0o600 });
    fs.renameSync(BASELINE + '.tmp', BASELINE);
    result.wrote = true;
  }

  // the report
  const md = [];
  md.push(`# Sheet -> board sync, ${TODAY} (${result.mode}${result.wrote ? ', written' : ', nothing written'})`, '');
  md.push(`Parsed ${result.parsed} events from the Sheet (${CFG.sheet.label}, tab ${CFG.sheet.tab}); baseline: ${baseSource}.`);
  md.push(`${eventsTouched} event(s) changed, ${slotChanges} shift change(s); ${plan.created.length} new; ${plan.held.length} held; ${plan.conflicts.length} conflict(s); ${plan.flagged.length} flagged.`);
  if (result.stopped) md.push('', `**STOPPED:** ${result.stopped}`);
  if (plan.held.length) { md.push('', '## Held (VectorConnect or a move says no; comes back next run until decided)'); for (const h of plan.held) md.push(`- ${h.weekend} ${h.name}: ${h.why}`); }
  if (plan.conflicts.length) { md.push('', '## Conflicts (the Sheet and the board both changed it; neither touched)'); for (const c of plan.conflicts) md.push(`- ${c.weekend} ${c.name}: ${c.why}`); }
  if (plan.flagged.length) { md.push('', '## Flagged'); for (const f of plan.flagged) md.push(`- ${f}`); }
  if (plan.duplicates.length) { md.push('', '## The same event twice on the Sheet (the board keeps one; tidy the Sheet when convenient)'); for (const d of plan.duplicates) md.push(`- ${d.weekend} ${d.name}: rows ${d.rows.join(' and ')}, same day, same staffing`); }
  if (plan.created.length) { md.push('', '## New events'); for (const c of plan.created) md.push(`- ${c.weekend} ${c.name} (${c.staffed} shift(s), ${c.status}) [${c.id}]`); }
  if (plan.applied.length) { md.push('', '## Changed'); for (const a of plan.applied) { md.push(`- ${a.weekend} ${a.name}`); for (const c of a.changes) md.push(`    - ${c}`); } }
  if (plan.unresolved.length) md.push('', `Names the roster cannot place (carried as written): ${plan.unresolved.join(', ')}`);
  if (warnings.length) md.push('', `Parser warnings: ${warnings.join('; ')}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `sheet-sync-${TODAY}.md`), md.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, `sheet-sync-${TODAY}.json`), JSON.stringify(result, null, 1));
  if (flag('--json')) console.log(JSON.stringify(result, null, 1)); else console.log(md.join('\n'));
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(c => process.exit(c)).catch(e => { console.error('sheet-sync: ' + (e.stack || e.message)); process.exit(1); });
}
