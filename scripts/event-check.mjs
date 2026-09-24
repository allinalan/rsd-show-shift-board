#!/usr/bin/env node
/*
  event-check — the Wednesday Event Check, against the board instead of the Google Sheet, unattended.

  A rep's name on the board is a promise; a row in VectorConnect is a booking. This finds every staffed
  show whose promise has no booking behind it, writes VC's live status and event number back onto the
  board, and hands the result to rsd-shift-picking, which builds the texts (JP's list, the rep updates)
  and asks Alan before anything goes out.

  Inputs: the board (Supabase) and a VC "My Events" pull (rsd-shift-picking/pull-vc-events.js: Matt Foss,
  filtered on End Date over a window this script computes). Matching lives in lib/match.mjs.

  Writes, only on --apply and only when the VC pull passes its checks:
    upcoming events: vcNumber, vcStatus (verbatim), status (the board's vocabulary), dead, vcCheckedAt
    past events:     vcNumber, vcStatus, vcCheckedAt (a finished show that VC has since closed out must
                     not turn into "Cancelled" on the board)
  Never writes Mesa (handled outside VC), a number two unrelated events both claim, or an event whose
  board VC number is missing from the pull (flagged instead). The Sheet is never written (Alan,
  2026-09-23: the board carries VC status now).

  Usage:
    event-check.mjs --window                         print the VC window for today's scope as JSON
    event-check.mjs --vc <pull.json> [--apply] [--sync-report <sheet-sync.json>] [--status-defs <defs.json>] [--rulings <event-rulings.json>] [--date YYYY-MM-DD]
  --rulings: rsd-shift-picking's data/event-rulings.json. A global (not rep-scoped) "not-worked" ruling
  whose event text is inside the board name and whose dates cover the event means Alan ruled the show is
  not happening: it is dead on the board whatever VC still says (Cochise County Fair 2026, "we could not
  get in"), and the rep texts use the ruling's repReason. VC's own status is kept verbatim beside it.
  Outputs: out/event-check/latest.json (+ a dated copy), out/reports/Event_Check_<label>_<date>.xlsx,
           out/reports/event-check-<date>.md
  Exit: 0 ok · 1 error · 4 the VC pull is unusable (nothing written) · 5 a safety check refused the write
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { boardApi } from './lib/board-api.mjs';
import { matchAll, duplicateClaims, statusCategory, CATEGORY_LABEL, effectiveDate, inRun, addDaysIso, normName } from './lib/match.mjs';
import { boardStatus, isSEday, XLSX_PATHS } from './parse-sheet.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
const TODAY = opt('--date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
const MESA = new RegExp(CFG.mesaPattern, 'i');
const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const OUT_BASE = process.env.BOARD_OUT_DIR || path.join(REPO, 'out');          // tests point this at a temp dir
const OUT_EC = path.join(OUT_BASE, 'event-check'), OUT_R = path.join(OUT_BASE, 'reports');

/** Lead reps on real shifts (SE days are never shifts), as the board spells them. */
export function leadReps(e) {
  const out = [];
  for (const b of e.booths || []) for (const s of b.shifts || []) (s.slots || []).forEach((sl, i) => {
    const r = t(sl && sl.rep);
    if (!r || r === '__X__' || isSEday((b.days || [])[i])) return;
    for (const one of r.split(' / ')) if (t(one) && !out.includes(t(one))) out.push(t(one));
  });
  return out;
}
const shiftCount = e => (e.booths || []).reduce((n, b) => n + (b.shifts || []).reduce((m, s) => m + (s.slots || []).filter((sl, i) => t(sl.rep) && t(sl.rep) !== '__X__' && !isSEday((b.days || [])[i])).length, 0), 0);

function inScope(e) {
  const d = e.weekend || e.startDate;
  return d && d >= addDaysIso(TODAY, -(CFG.scopeDaysBack ?? 60)) && d <= addDaysIso(TODAY, CFG.scopeDaysAhead ?? 200);
}
// VC's own text varies in case ("OK to Book" vs the list's "Ok To Book") and truncates long names
// ("Pending CO - See Timeline"); both are on the list. Anything else is worth telling Alan about.
const onList = (s, list) => { const l = String(s || '').toLowerCase(); return list.some(x => x.toLowerCase() === l || (l.length >= 12 && x.toLowerCase().startsWith(l))); };

async function main() {
  const api = boardApi({ actor: 'service:event-check' });
  const events = (await api.events()).filter(inScope);

  if (flag('--window')) {
    // Effective dates, not raw end dates: a typo'd year on one row (12/12/2027 for a Dec 2026 show) must not
    // stretch the pull a year. VC filters on End Date, so the far end gets room for a multi-week run.
    const effs = events.map(e => effectiveDate(e, CFG.effectiveDateMaxDrift)).filter(Boolean).sort();
    if (!effs.length) throw new Error('no board events in scope; nothing to check');
    const pad = CFG.vcWindowPadDays ?? 30;
    console.log(JSON.stringify({ from: addDaysIso(effs[0], -pad), to: addDaysIso(effs[effs.length - 1], Math.max(pad, 45)), events: events.length, coordinator: CFG.coordinator }));
    return 0;
  }

  const vcPath = opt('--vc');
  if (!vcPath || !fs.existsSync(vcPath)) throw new Error('--vc <pull.json> is required (rsd-shift-picking/pull-vc-events.js writes it)');
  const vc = JSON.parse(fs.readFileSync(vcPath, 'utf8'));
  const rows = (vc.rows || []).map(r => ({ ...r, eventNumber: t(r.eventNumber) }));
  const syncReport = opt('--sync-report') && fs.existsSync(opt('--sync-report')) ? JSON.parse(fs.readFileSync(opt('--sync-report'), 'utf8')) : null;
  const defs = opt('--status-defs') && fs.existsSync(opt('--status-defs')) ? JSON.parse(fs.readFileSync(opt('--status-defs'), 'utf8')) : null;
  const rulings = opt('--rulings') && fs.existsSync(opt('--rulings')) ? (JSON.parse(fs.readFileSync(opt('--rulings'), 'utf8')).rulings || []) : [];
  // the stat system's matching (lib/reconcile.js rulingFor): the ruling's event text inside the name, dates inside [from, to]
  const notHappening = e => { const n = String(e.name || '').toLowerCase(), d = effectiveDate(e, CFG.effectiveDateMaxDrift);
    return rulings.find(r => !r.rep && r.ruling === 'not-worked' && r.event && n.includes(String(r.event).toLowerCase()) && d && d >= (r.from || '0000') && d <= (r.to || '9999')) || null; };
  const result = { date: TODAY, runAt: new Date().toISOString(), mode: flag('--apply') ? 'apply' : 'dry', written: false,
    vc: { pulledAt: vc.pulledAt || null, rows: rows.length, coordinator: vc.coordinator || CFG.coordinator, window: vc.window || null } };

  if (rows.length < (CFG.checkWrite.minVcRows ?? 20)) {
    result.stopped = `the VC pull has ${rows.length} rows (expected well over ${CFG.checkWrite.minVcRows}); refusing to judge anything against it`;
    await write(result, []);
    console.error('event-check: ' + result.stopped);
    return 4;
  }

  // ---- match
  const byId = new Map(events.map(e => [e.id, e]));
  const facts = events.map(e => {
    const reps = leadReps(e);
    const end = e.endDate || e.startDate || e.weekend;
    return { e, reps, staffed: reps.length > 0, mesa: MESA.test(e.name), upcoming: end >= TODAY, past: end < TODAY };
  });
  const toMatch = facts.filter(f => !f.mesa && (f.staffed || t(f.e.vcNumber)));
  const { results, claims } = matchAll(toMatch.map(f => f.e), rows, CFG);
  const dupes = duplicateClaims(claims, byId);
  const suspicious = new Set(dupes.filter(d => !d.legit).flatMap(d => d.ids));

  // ---- judge every checked event
  const out = [];
  const patches = [];
  const statusesSeen = new Map();
  for (const r of rows) statusesSeen.set(r.status, (statusesSeen.get(r.status) || 0) + 1);
  for (const f of toMatch) {
    const e = f.e, m = results.get(e.id) || {};
    const row = m.row || null;
    const beforeStatus = t(e.vcStatus), beforeCat = statusCategory(beforeStatus, { past: f.past });
    let vcStatus = row ? t(row.status) : '', cat = row ? statusCategory(vcStatus, { past: f.past }) : 'no-vc';
    const notes = [];
    if (m.note) notes.push(m.note);
    if (m.numberMissing && !row) { vcStatus = beforeStatus; cat = beforeStatus ? statusCategory(beforeStatus, { past: f.past }) : 'no-vc'; notes.push('last known status kept'); }
    if (suspicious.has(e.id)) notes.push(`VC ${row && row.eventNumber} is also claimed by an unrelated event; not written`);
    const ruled = notHappening(e);
    if (ruled) { cat = 'dead'; notes.push(`Alan's ruling: ${ruled.note || 'not happening'}${row ? ` (VC still shows ${vcStatus})` : ''}`); }
    const openQuestion = !!m.placeholder && !ruled;
    const rec = {
      id: e.id, name: e.name, weekend: e.weekend, startDate: e.startDate, endDate: e.endDate, effective: m.effective || effectiveDate(e),
      upcoming: f.upcoming, staffed: f.staffed, reps: f.reps, shifts: shiftCount(e), sheetStatus: t(e.sheetStatus), boardStatus: t(e.status),
      vcNumber: row ? row.eventNumber : t(e.vcNumber), vcStatus, vcStart: row ? row.startDate : null, vcEnd: row ? row.endDate : null, vcName: row ? row.name : null,
      matchedBy: m.by || null, score: m.score || 0, category: cat, before: { vcStatus: beforeStatus, category: beforeCat, vcNumber: t(e.vcNumber), status: t(e.status) },
      dateMismatch: !!m.dateMismatch, numberMissing: !!m.numberMissing && !row, suspicious: suspicious.has(e.id), openQuestion,
      mismatchRow: m.mismatchRow ? { eventNumber: m.mismatchRow.eventNumber, name: m.mismatchRow.name, startDate: m.mismatchRow.startDate, endDate: m.mismatchRow.endDate, status: m.mismatchRow.status } : null,
      notes, ruling: ruled ? { note: ruled.note || '', reason: ruled.repReason || '' } : null,
    };
    out.push(rec);

    // the write-back
    if (suspicious.has(e.id) || (rec.numberMissing && !ruled)) continue;
    const patch = {};
    if (ruled) {
      // Alan's word outranks VC's status, past or upcoming: the show is not happening.
      if (row && t(e.vcNumber) !== row.eventNumber) patch.vcNumber = row.eventNumber;
      if (row && t(e.vcStatus) !== vcStatus) patch.vcStatus = vcStatus;
      if (t(e.status) !== 'Cancelled') patch.status = 'Cancelled';
      if (!e.dead) patch.dead = true;
      if (Object.keys(patch).length) { patch.vcCheckedAt = TODAY; patches.push({ id: e.id, name: e.name, patch, before: { status: t(e.status), vcStatus: t(e.vcStatus), vcNumber: t(e.vcNumber), dead: !!e.dead } }); }
      continue;
    }
    if (row) {
      if (t(e.vcNumber) !== row.eventNumber) patch.vcNumber = row.eventNumber;
      if (t(e.vcStatus) !== vcStatus) patch.vcStatus = vcStatus;
      if (f.upcoming) {
        const bs = boardStatus(vcStatus, '', rec.shifts);
        if (t(e.status) !== bs.status) patch.status = bs.status;
        if (!!e.dead !== !!bs.dead) patch.dead = !!bs.dead;
      }
    } else if (f.upcoming && f.staffed && !openQuestion && t(e.status) !== 'Booking Request Needed' && !t(e.vcNumber)) {
      patch.status = 'Booking Request Needed';
    }
    if (Object.keys(patch).length) { patch.vcCheckedAt = TODAY; patches.push({ id: e.id, name: e.name, patch, before: { status: t(e.status), vcStatus: t(e.vcStatus), vcNumber: t(e.vcNumber), dead: !!e.dead } }); }
  }

  // ---- alias candidates: an unmatched staffed show sharing a weekend and a city with an unclaimed VC row
  const claimed = new Set([...claims.keys()]);
  const cityOf = s => normName(String(s || '').split(',')[0]);
  // (never a placeholder, and never for Queen Creek, which matches only on its exact date)
  const QCFM = new RegExp(CFG.qcfmPattern, 'i'), placeholder = new Set((CFG.placeholders || []).map(String));
  for (const r of out.filter(x => x.category === 'no-vc' && x.staffed && !x.numberMissing && !x.openQuestion && !QCFM.test(x.name))) {
    const e = byId.get(r.id), city = cityOf(e.cityState);
    r.aliasCandidates = rows.filter(v => !claimed.has(v.eventNumber) && !placeholder.has(v.eventNumber) && inRun(r.effective, v, CFG.dateSlackDays ?? 4) && city && cityOf(v.city) === city)
      .slice(0, 3).map(v => ({ eventNumber: v.eventNumber, name: v.name, startDate: v.startDate, endDate: v.endDate, status: v.status }));
  }

  // ---- safety checks before any write
  const numbered = toMatch.filter(f => t(f.e.vcNumber) && !(CFG.placeholders || []).includes(t(f.e.vcNumber)));
  const found = numbered.filter(f => rows.some(r => r.eventNumber === t(f.e.vcNumber))).length;
  const foundShare = numbered.length ? found / numbered.length : 1;
  const matchedUpcoming = out.filter(r => r.upcoming && r.vcStatus).length;
  const statusChanges = patches.filter(p => 'status' in p.patch).length;
  const refuse = [];
  if (foundShare < (CFG.checkWrite.minNumberFoundShare ?? 0.7)) refuse.push(`only ${found} of ${numbered.length} VC numbers already on the board are in this pull; the pull looks incomplete`);
  if (matchedUpcoming >= 10 && statusChanges > matchedUpcoming * (CFG.checkWrite.maxStatusChangeShare ?? 0.6)) refuse.push(`${statusChanges} status changes against ${matchedUpcoming} matched upcoming shows is implausible`);
  result.checks = { numbered: numbered.length, found, foundShare: +foundShare.toFixed(3), statusChanges, matchedUpcoming };

  let code = 0;
  if (refuse.length) { result.stopped = refuse.join('; ') + '. Nothing written.'; code = 5; }
  else if (flag('--apply')) {
    for (const p of patches) await api.patchEvent(p.id, p.patch);
    result.written = true;
  }
  result.patches = patches.map(p => ({ id: p.id, name: p.name, fields: Object.keys(p.patch).filter(k => k !== 'vcCheckedAt'), before: p.before, after: p.patch }));

  // ---- the numbers Alan leads with, and the rest of the picture
  const live = out.filter(r => r.upcoming && r.staffed);
  result.headline = {
    staffedUpcoming: live.length,
    noBooking: live.filter(r => r.category === 'no-vc' && !r.numberMissing && !r.openQuestion).length,
    notFullyBooked: live.filter(r => r.category !== 'booked').length,
    deadWithReps: live.filter(r => r.category === 'dead').length,
    openQuestions: live.filter(r => r.openQuestion).length,
    mesaExcluded: facts.filter(f => f.mesa && f.staffed && f.upcoming).length,
  };
  result.byCategory = Object.fromEntries(Object.keys(CATEGORY_LABEL).map(k => [k, live.filter(r => r.category === k).length]));
  result.delta = {
    statusMoved: out.filter(r => r.vcStatus && r.before.vcStatus && r.vcStatus !== r.before.vcStatus).map(r => ({ id: r.id, name: r.name, weekend: r.weekend, from: r.before.vcStatus, to: r.vcStatus })),
    resolved: out.filter(r => r.upcoming && r.staffed && r.category === 'booked' && r.before.category !== 'booked').map(r => ({ id: r.id, name: r.name, weekend: r.weekend, from: r.before.vcStatus || 'no VC record', to: r.vcStatus })),
    newlyFlagged: out.filter(r => r.upcoming && r.staffed && r.category !== 'booked' && r.before.category === 'booked').map(r => ({ id: r.id, name: r.name, weekend: r.weekend, from: r.before.vcStatus, to: r.vcStatus || 'no VC record' })),
  };
  result.flags = {
    sheetSaysBooked: live.filter(r => /^booked/i.test(r.sheetStatus) && r.category !== 'booked').map(r => ({ id: r.id, name: r.name, weekend: r.weekend, sheet: r.sheetStatus, vc: r.vcStatus || 'no VC record' })),
    offListStatuses: [...statusesSeen].filter(([s]) => s && !onList(s, CFG.vcStatuses || [])).map(([s, n]) => ({ status: s, count: n })),
    duplicates: dupes.map(d => ({ number: d.number, legit: d.legit, events: d.ids.map(id => byId.get(id)?.name) })),
    numberMissing: out.filter(r => r.numberMissing).map(r => ({ id: r.id, name: r.name, weekend: r.weekend, vcNumber: r.vcNumber, lastKnown: r.vcStatus })),
    dateMismatches: out.filter(r => r.dateMismatch).map(r => ({ id: r.id, name: r.name, weekend: r.weekend, board: `${r.startDate || r.effective}..${r.endDate || ''}`, vc: r.vcStart ? `${r.vcStart}..${r.vcEnd}` : (r.mismatchRow ? `${r.mismatchRow.startDate}..${r.mismatchRow.endDate} (${r.mismatchRow.eventNumber})` : '') })),
    openQuestions: out.filter(r => r.openQuestion).map(r => ({ id: r.id, name: r.name, weekend: r.weekend, note: r.notes.join('; ') })),
    aliasCandidates: out.filter(r => (r.aliasCandidates || []).length).map(r => ({ id: r.id, name: r.name, weekend: r.weekend, candidates: r.aliasCandidates })),
    pastProblems: out.filter(r => !r.upcoming && r.staffed && ['no-vc', 'dead'].includes(r.category)).map(r => ({ id: r.id, name: r.name, weekend: r.weekend, vc: r.vcStatus || 'no VC record' })),
  };
  result.flags.ruledOff = out.filter(r => r.ruling).map(r => ({ id: r.id, name: r.name, weekend: r.weekend, vc: r.vcStatus || 'no VC record', note: r.ruling.note }));
  result.aliasesUsed = out.filter(r => r.matchedBy === 'alias').map(r => ({ board: r.name, vc: r.vcName, number: r.vcNumber }));
  result.sync = syncReport ? { mode: syncReport.mode, wrote: syncReport.wrote, eventsTouched: syncReport.eventsTouched, slotChanges: syncReport.slotChanges,
    held: syncReport.held, conflicts: syncReport.conflicts, flagged: syncReport.flagged, created: syncReport.created, stopped: syncReport.stopped || null, unresolved: syncReport.unresolved } : null;
  result.events = out;
  await write(result, out, defs);
  console.log(summaryMd(result));
  return code;
}

// ---------- outputs ----------------------------------------------------------------------------
function fmtRange(a, b) {
  if (!a) return '';
  const d = s => { const [y, m, dd] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)); };
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const x = d(a), y = b ? d(b) : x;
  if (+x === +y) return `${M[x.getUTCMonth()]} ${x.getUTCDate()}`;
  return x.getUTCMonth() === y.getUTCMonth() ? `${M[x.getUTCMonth()]} ${x.getUTCDate()}-${y.getUTCDate()}` : `${M[x.getUTCMonth()]} ${x.getUTCDate()}-${M[y.getUTCMonth()]} ${y.getUTCDate()}`;
}

export function summaryMd(r) {
  const h = r.headline || {}, md = [];
  md.push(`# Event check, ${r.date} (${r.mode}${r.written ? ', board updated' : ', board not written'})`, '');
  if (r.stopped) md.push(`**STOPPED:** ${r.stopped}`, '');
  if (h.staffedUpcoming != null) {
    md.push(`**${h.noBooking}** staffed upcoming shows have no booking in VectorConnect. **${h.notFullyBooked}** of ${h.staffedUpcoming} are not fully booked.`);
    md.push(`${h.deadWithReps} dead show(s) still have reps on them. Mesa Swapmeet excluded (${h.mesaExcluded} staffed weekends). VC pull: ${r.vc.rows} rows for ${r.vc.coordinator}.`);
    if (h.openQuestions) md.push(`${h.openQuestions} open question(s) (placeholder records), not counted as missing.`);
    md.push('', '## Since last week');
    md.push(`Resolved ${r.delta.resolved.length}, newly flagged ${r.delta.newlyFlagged.length}, status moved on ${r.delta.statusMoved.length}.`);
    for (const x of r.delta.resolved) md.push(`- resolved: ${x.weekend} ${x.name} (${x.from} -> ${x.to})`);
    for (const x of r.delta.newlyFlagged) md.push(`- newly flagged: ${x.weekend} ${x.name} (${x.from} -> ${x.to})`);
    const cats = Object.entries(r.byCategory).filter(([k, n]) => n && k !== 'booked');
    if (cats.length) { md.push('', '## Not fully booked, by what unblocks it'); for (const [k, n] of cats) md.push(`- ${CATEGORY_LABEL[k]}: ${n}`); }
    const f = r.flags;
    if (f.sheetSaysBooked.length) { md.push('', '## Column C says Booked, VectorConnect does not'); for (const x of f.sheetSaysBooked) md.push(`- ${x.weekend} ${x.name}: VC ${x.vc}`); }
    if (f.offListStatuses.length) md.push('', `Statuses not on the definitions list: ${f.offListStatuses.map(x => `${x.status} (${x.count})`).join(', ')}`);
    if ((f.ruledOff || []).length) { md.push('', "## Not happening by Alan's ruling (dead on the board whatever VC shows)"); for (const x of f.ruledOff) md.push(`- ${x.weekend} ${x.name}: VC ${x.vc}. ${x.note}`); }
    if (f.numberMissing.length) { md.push('', '## Board VC number not in this pull'); for (const x of f.numberMissing) md.push(`- ${x.weekend} ${x.name}: ${x.vcNumber} (last known ${x.lastKnown || 'none'})`); }
    const bad = f.duplicates.filter(d => !d.legit);
    if (bad.length) { md.push('', '## One VC number, two unrelated events (not written)'); for (const d of bad) md.push(`- ${d.number}: ${d.events.join(' / ')}`); }
    if (f.aliasCandidates.length) { md.push('', '## Possible name changes (confirm, and they match silently from then on)'); for (const x of f.aliasCandidates) md.push(`- ${x.weekend} ${x.name} -> ${x.candidates.map(c => `${c.eventNumber} ${c.name} (${c.status})`).join('; ')}`); }
    if (f.openQuestions.length) { md.push('', '## Open questions'); for (const x of f.openQuestions) md.push(`- ${x.weekend} ${x.name}: ${x.note}`); }
  }
  if (r.sync) md.push('', `Sheet -> board sync: ${r.sync.eventsTouched} event(s), ${r.sync.slotChanges} shift change(s)${r.sync.wrote ? '' : ' (not written)'}; ${r.sync.held.length} held, ${r.sync.conflicts.length} conflict(s), ${r.sync.flagged.length} flagged.`);
  return md.join('\n');
}

async function loadXlsx() {
  const p = XLSX_PATHS.find(x => fs.existsSync(x));
  return p ? import(p) : null;
}

async function write(result, out, defs) {
  fs.mkdirSync(OUT_EC, { recursive: true }); fs.mkdirSync(OUT_R, { recursive: true });
  fs.writeFileSync(path.join(OUT_EC, 'latest.json'), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(OUT_EC, `${result.date}.json`), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(OUT_R, `event-check-${result.date}.md`), summaryMd(result) + '\n');
  await writeXlsx(result, out, defs).catch(e => { result.xlsxError = e.message; fs.writeFileSync(path.join(OUT_EC, 'latest.json'), JSON.stringify(result, null, 1)); });
}

async function writeXlsx(r, out, defs) {
  if (!out.length) return;
  const XLSX = await loadXlsx();
  if (!XLSX) { r.xlsxError = 'no SheetJS on this machine (see parse-sheet XLSX_PATHS); workbook skipped'; return; }
  const wb = XLSX.utils.book_new();
  const add = (name, rows, widths) => { const ws = XLSX.utils.aoa_to_sheet(rows); if (widths) ws['!cols'] = widths.map(w => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); };
  const live = out.filter(x => x.upcoming && x.staffed);
  const h = r.headline;
  add('Summary', [
    [`Event check ${r.date}`], [],
    ['Staffed upcoming shows with NO booking in VectorConnect', h.noBooking],
    ['Staffed upcoming shows NOT fully booked', h.notFullyBooked],
    ['Staffed upcoming shows checked', h.staffedUpcoming],
    ['Dead shows with reps still on them', h.deadWithReps],
    ['Open questions (placeholder records)', h.openQuestions],
    ['Mesa Market Place Swapmeet weekends excluded (handled outside VC)', h.mesaExcluded],
    [], ['What unblocks it', 'Count'], ...Object.entries(r.byCategory).map(([k, n]) => [CATEGORY_LABEL[k], n]),
    [], ['VC pull', `${r.vc.rows} rows, ${r.vc.coordinator}, End Date ${r.vc.window ? r.vc.window.from + ' to ' + r.vc.window.to : '?'}`],
    ['Board written', r.written ? 'yes' : `no${r.stopped ? ': ' + r.stopped : ''}`],
    [], ['A name on the board is a promise, not a booking. Prospective and OK to Book are not committed shows.'],
  ], [70, 60]);
  const order = ['no-vc', 'dead', 'contract', 'coi', 'promoter', 'olean', 'not-committed', 'detail', 'other'];
  const nfb = live.filter(x => x.category !== 'booked').sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || String(a.weekend).localeCompare(String(b.weekend)));
  add('NOT Fully Booked', [['What unblocks it', 'Weekend', 'Event', 'Dates', 'Reps', 'VC #', 'VC status', 'Board status', 'Note'],
    ...nfb.map(x => [CATEGORY_LABEL[x.category], x.weekend, x.name, fmtRange(x.startDate || x.effective, x.endDate), x.reps.join(', '), x.vcNumber, x.vcStatus, x.boardStatus, x.notes.join('; ')])], [30, 11, 44, 14, 28, 10, 34, 26, 50]);
  add('All Staffed Events', [['Weekend', 'Event', 'Reps', 'VC #', 'VC status', 'What it is', 'Matched by', 'Upcoming', 'Note'],
    ...out.filter(x => x.staffed).map(x => [x.weekend, x.name, x.reps.join(', '), x.vcNumber, x.vcStatus, CATEGORY_LABEL[x.category], x.matchedBy || '', x.upcoming ? 'yes' : 'past', x.notes.join('; ')])], [11, 44, 30, 10, 34, 28, 10, 8, 50]);
  add('Dead Shows - Reps Staffed', [['Weekend', 'Event', 'Reps still on it', 'VC #', 'VC status'],
    ...out.filter(x => x.staffed && x.category === 'dead').map(x => [x.weekend, x.name, x.reps.join(', '), x.vcNumber, x.vcStatus])], [11, 44, 30, 10, 34]);
  add('Column C vs VectorConnect', [['Direction', 'Weekend', 'Event', 'Column C (Sheet)', 'VectorConnect'],
    ...live.filter(x => /^booked/i.test(x.sheetStatus) && x.category !== 'booked').map(x => ['C says Booked, VC does not (dangerous)', x.weekend, x.name, x.sheetStatus, x.vcStatus || 'no VC record']),
    ...live.filter(x => x.category === 'booked' && x.sheetStatus && !/^booked/i.test(x.sheetStatus)).map(x => ['C is behind (cosmetic)', x.weekend, x.name, x.sheetStatus, x.vcStatus])], [38, 11, 44, 30, 34]);
  add('Name Changes', [['Kind', 'Board name', 'VectorConnect', 'VC #', 'Status'],
    ...r.aliasesUsed.map(a => ['confirmed alias', a.board, a.vc, a.number, '']),
    ...r.flags.aliasCandidates.flatMap(x => x.candidates.map(c => ['candidate: ask Alan', x.name, c.name, c.eventNumber, c.status]))], [22, 44, 44, 10, 30]);
  add('Date Mismatches', [['Weekend', 'Event', 'Board dates', 'VectorConnect dates'], ...r.flags.dateMismatches.map(x => [x.weekend, x.name, x.board, x.vc])], [11, 44, 24, 40]);
  const defMap = new Map(((defs && defs.statuses) || []).map(d => [d.status, d.definition]));
  const seen = new Map(); for (const x of out) if (x.vcStatus) seen.set(x.vcStatus, (seen.get(x.vcStatus) || 0) + 1);
  add('Status Reference', [['Status', 'Checked shows', 'On the definitions list', 'Definition'],
    ...[...seen].sort((a, b) => b[1] - a[1]).map(([s, n]) => [s, n, onList(s, CFG.vcStatuses || []) ? 'yes' : 'NO', defMap.get(s) || ''])], [44, 14, 22, 80]);
  if (r.sync) add('Sheet Sync', [['What', 'Weekend', 'Event', 'Detail'],
    ...r.sync.held.map(x => ['held', x.weekend, x.name, x.why]), ...r.sync.conflicts.map(x => ['conflict', x.weekend, x.name, x.why]),
    ...r.sync.flagged.map(x => ['flagged', '', '', x]), ...r.sync.created.map(x => ['new event', x.weekend, x.name, `${x.staffed} shift(s), ${x.status}`])], [10, 11, 44, 90]);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(path.join(OUT_R, `Event_Check_${CFG.sheet.label}_${r.date}.xlsx`), buf);
  r.xlsx = `out/reports/Event_Check_${CFG.sheet.label}_${r.date}.xlsx`;
  fs.writeFileSync(path.join(OUT_EC, 'latest.json'), JSON.stringify(r, null, 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(c => process.exit(c)).catch(e => { console.error('event-check: ' + (e.stack || e.message)); process.exit(1); });
}
