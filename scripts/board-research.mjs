#!/usr/bin/env node
/*
  board-research — the board's side of researching shows on the web (Alan, 2026-09-24).

  Three runs use it, all started by rsd-shift-picking (which owns the VC login, the Claude API calls that do the
  research, the texts and the email):
    date research   7 days before a shift-picking meeting: every upcoming show's DATES
    preflight       2 days before: dates, venue, address, promoter info, and the blanks the booking sweep needs
                    (indoor/outdoor, contact name, street address and ZIP, cost, application link)
    booking sweep   2+ days after: the shows whose dates disagree with VectorConnect

  Alan's date rule (2026-09-24): when the board and VC disagree, research the actual date. The researched date
  wins. When nothing online confirms it, go with VC's date and put a note on the board. A show whose board days
  sit inside VC's run (VC often carries a set-up day) is not a disagreement.

    board-research.mjs targets --mode dates|full|mismatches --check <out/event-check/latest.json> [--exclude-file <json>] [--skip-tiers Elite,...]
                               [--out <file>] [--date YYYY-MM-DD]
    board-research.mjs apply --targets <file> --research <file> --mode dates|full [--label date-research|preflight|booking-sweep]
                             [--apply] [--max-date-changes N] [--date YYYY-MM-DD]

  targets: upcoming, live (not dead or never-work), not Mesa (outside VC), not on the exclude list, not of a tier in
  --skip-tiers (Alan, 2026-09-24: Elite events are handled by the team, never researched; they are counted). Each target
  carries what the research needs (and, for the preflight, the promoter contacts: the file is mode 600, machine-
  local). Refuses an event check that is not from today or did not trust its VC data (exit 4).

  targets --mode mismatches (the booking sweep): only shows whose board days are not inside VC's run, multi-week
  shows left out (never moved; the sweep lists them for Alan).
  apply, dates (every mode):
    - the research found this year's dates (a page states them; a quote is kept) -> they win: if the board's days
      are not inside them, the show moves (lib/dates.mjs planMove: days that still happen keep their reps, a day
      that moves to the same weekday carries its reps, a day that is gone is reported with its reps)
    - not found online, and VC disagrees with the board -> the board moves to VC's dates, noted on the board
    - not found, no disagreement -> nothing changes (listed when the dates are still last year's +364 guess)
    - a cancellation found online is reported, never written; a failed lookup changes nothing (it is not "not
      found"); a multi-week show on one VC record is reported, never moved
    Every change writes datesNote (shown on the board), datesSource and datesMoved. More than --max-date-changes
    (default 25) at once is refused and nothing is written (exit 5).
  apply, full (the preflight) also: blanks are filled from the event's or promoter's own pages (venue, address,
    city/state, promoter, website, application link and deadline, contact name/phone/e-mail, indoor/outdoor,
    cost); venue, promoter, website and application link are corrected when the official page says otherwise;
    an existing contact, cost, address or indoor/outdoor answer is never overwritten, only reported.
  Output: out/research/latest.json (+ dated copy, 600), out/reports/<label>-<date>.md (no contacts).
  Exit: 0 ok · 1 error · 4 no trustworthy event check · 5 refused (too many date changes; nothing written)
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { boardApi } from './lib/board-api.mjs';
import { normName, dayDiff } from './lib/match.mjs';
import { sellingRun, within, sameRun, planMove, runDays, isSE } from './lib/dates.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = f => argv.includes(f);
const opt = (f, d = null) => { const i = argv.indexOf(f); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
const TODAY = opt('--date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
const MESA = new RegExp(CFG.mesaPattern, 'i');
const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const OUT_BASE = process.env.BOARD_OUT_DIR || path.join(REPO, 'out');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = iso => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
export const fmt = r => (r ? (r.start === r.end ? md(r.start) : r.start.slice(0, 7) === r.end.slice(0, 7) ? `${md(r.start)}-${+r.end.slice(8, 10)}` : `${md(r.start)}-${md(r.end)}`) : 'no usable dates');
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

// ---------- targets ----------
async function targets() {
  const mode = opt('--mode');
  if (!['dates', 'full', 'mismatches'].includes(mode)) throw new Error('--mode dates|full|mismatches');
  const checkPath = opt('--check') || path.join(OUT_BASE, 'event-check', 'latest.json');
  const check = fs.existsSync(checkPath) ? JSON.parse(fs.readFileSync(checkPath, 'utf8')) : null;
  if (!check || check.stopped || check.date !== TODAY) { console.error(`board-research: no trustworthy event check from today (${!check ? 'none' : check.stopped ? 'it stopped: ' + check.stopped : 'it is from ' + check.date})`); return 4; }
  const excl = opt('--exclude-file') && fs.existsSync(opt('--exclude-file')) ? (JSON.parse(fs.readFileSync(opt('--exclude-file'), 'utf8')).exclude || []) : [];
  const exclude = new Set(excl.map(normName));
  const skipTiers = new Set(String(opt('--skip-tiers') || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  const skipped = [];
  const recById = new Map((check.events || []).map(r => [r.id, r]));
  // one VC record claimed by several shows = a multi-week show: researched, never moved
  const claims = new Map();
  for (const r of check.events || []) if (r.vcNumber && r.category !== 'no-vc' && r.upcoming) claims.set(r.vcNumber, (claims.get(r.vcNumber) || 0) + 1);
  const api = boardApi({ actor: 'service:board-research' });
  const out = [];
  for (const e of await api.events()) {
    const run = sellingRun(e);
    const end = e.endDate || e.startDate || e.weekend || '';
    if (!end || end < TODAY || e.dead || e.neverWork || MESA.test(e.name || '') || exclude.has(normName(e.name))) continue;
    if (skipTiers.has(t(e.tier).toLowerCase())) { skipped.push({ id: e.id, name: t(e.name), tier: t(e.tier) }); continue; }
    const r = recById.get(e.id);
    const vc = r && r.vcStart && r.category !== 'no-vc' ? { number: r.vcNumber, name: r.vcName, status: r.vcStatus, start: r.vcStart, end: r.vcEnd || r.vcStart } : null;
    const mismatch = !!(vc && run && !within(run, { start: vc.start, end: vc.end }));
    if (mismatch === false && mode === 'mismatches') continue;
    if (r && (r.ruling || r.category === 'dead')) continue;
    const tgt = { id: e.id, name: t(e.name), weekend: e.weekend, run, datesEstimated: !!e.datesEstimated, cityState: t(e.cityState), location: t(e.location),
      address: t(e.address), promoter: t(e.promoter), website: t(e.website), applyUrl: t(e.applyUrl), applyBy: t(e.applyBy), cost: t(e.cost), setting: t(e.setting),
      staffed: !!(r && r.staffed), reps: r ? r.reps || [] : [], vc, mismatch, multiWeek: !!(vc && (claims.get(vc.number) || 0) > 1), lastYear: e.lastYear || null };
    if (mode === 'full') Object.assign(tgt, { contact: t(e.contact), phone: t(e.phone), email: t(e.email) });
    if (mode === 'mismatches' && tgt.multiWeek) continue;          // never moved anyway: the sweep asks Alan about it
    out.push(tgt);
  }
  // research order: disagreements first, then guessed dates, then staffed shows soonest first, then the rest
  const rank = x => (x.mismatch ? 0 : x.datesEstimated ? 1 : x.staffed ? 2 : 3);
  out.sort((a, b) => rank(a) - rank(b) || String(a.weekend).localeCompare(String(b.weekend)));
  const file = opt('--out');
  const payload = { date: TODAY, mode, count: out.length, targets: out, skippedTiers: skipped };
  if (file) writeJson(file, payload); else console.log(JSON.stringify(payload, null, 1));
  console.error(`board-research targets (${mode}): ${out.length} show(s)${mode !== 'mismatches' ? `, ${out.filter(x => x.mismatch).length} disagree with VC` : ''}`);
  return 0;
}

// ---------- apply ----------
const validRun = d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.start || '') && /^\d{4}-\d{2}-\d{2}$/.test(d.end || '') && d.start <= d.end && dayDiff(d.end, d.start) <= 21;
const official = g => g && g.confidence === 'official' && /^https?:\/\//i.test(t(g.sourceUrl));
const differs = (a, b) => { const x = normName(a), y = normName(b); return !!x && !!y && x !== y && !x.includes(y) && !y.includes(x); };
// the same site is not a correction: http vs https, www, a trailing slash (a website: any page on the same host)
const urlKey = (u, withPath) => { try { const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); return x.hostname.replace(/^www\./i, '').toLowerCase() + (withPath ? x.pathname.replace(/\/+$/, '').toLowerCase() : ''); } catch (e) { return null; } };
export const sameUrl = (a, b, withPath = true) => { const x = urlKey(t(a), withPath), y = urlKey(t(b), withPath); return !!x && x === y; };

/** The decision for one show's dates. Pure: returns { kind, truth?, basis?, source?, why? }. */
export function decideDates(tgt, res, run) {
  const vcRun = tgt.vc ? { start: tgt.vc.start, end: tgt.vc.end } : null;
  if (!res || res.notResearched) return { kind: 'not-researched' };
  if (!res.ok) return { kind: 'failed', why: res.error || 'the lookup failed' };
  const d = res.result && res.result.dates;
  if (d && d.cancelled && /^https?:\/\//i.test(t(d.sourceUrl))) return { kind: 'cancelled', source: d.sourceUrl, why: t(d.evidence) || t(d.note) };
  const found = d && d.found && validRun(d) && d.confidence !== 'none' && /^https?:\/\//i.test(t(d.sourceUrl)) && t(d.evidence)
    && (!run || Math.abs(dayDiff(d.start, run.start)) <= 150);
  if (found) {
    const truth = { start: d.start, end: d.end };
    // VC disagrees unless its run covers the show's (a VC set-up day is fine; VC holding one day of two is not)
    if (run && within(run, truth)) return { kind: 'confirmed', truth, basis: 'researched', source: d.sourceUrl, confidence: d.confidence, vcDisagrees: !!(vcRun && !within(truth, vcRun)) };
    return { kind: 'move', truth, basis: 'researched', source: d.sourceUrl, confidence: d.confidence };
  }
  if (vcRun && run && !within(run, vcRun)) return { kind: 'move', truth: vcRun, basis: 'vc' };
  return { kind: 'unconfirmed', why: d && d.notYetAnnounced ? "this year's dates aren't announced yet" : 'no page online confirms the dates' };
}

/** The preflight's field decisions for one show. Pure: returns { patch, changes: [{field, from, to, source}], notes: [...] }. */
export function decideFields(e, R) {
  const patch = {}, changes = [], notes = [];
  if (!R) return { patch, changes, notes };
  const set = (field, to, source, from = t(e[field])) => { patch[field] = to; changes.push({ field, from, to, source }); };
  const fill = (field, value, g) => { const v = t(value); if (v && !t(e[field]) && official(g)) set(field, v, g.sourceUrl); };
  const correct = (field, value, g, same = null) => {
    const v = t(value);
    if (!v || !official(g)) return;
    if (!t(e[field])) set(field, v, g.sourceUrl);
    else if (same ? !same(e[field], v) : differs(e[field], v)) set(field, v, g.sourceUrl);
  };
  const report = (field, value, g) => { const v = t(value); if (v && t(e[field]) && differs(e[field], v) && official(g)) notes.push({ field, board: t(e[field]), found: v, source: g.sourceUrl }); };
  if (R.venue) correct('location', R.venue.value, R.venue);
  if (R.address) {
    const a = R.address, full = [t(a.street), [t(a.city), [t(a.state), t(a.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');
    if (t(a.street) && t(a.zip)) { fill('address', full, a); report('address', full, a); }
    if (t(a.city) && t(a.state)) fill('cityState', `${t(a.city)}, ${t(a.state)}`, a);
  }
  if (R.promoter) {
    const p = R.promoter;
    correct('promoter', p.name, p); correct('website', p.website, p, (a, b) => sameUrl(a, b, false));
    fill('contact', p.contactName, p); fill('phone', p.phone, p); fill('email', p.email, p);
    report('contact', p.contactName, p); report('phone', p.phone, p);
  }
  if (R.application) {
    correct('applyUrl', R.application.url, R.application, (a, b) => sameUrl(a, b, true));
    if (/^\d{4}-\d{2}-\d{2}$/.test(t(R.application.deadline))) correct('applyBy', R.application.deadline, R.application);
  }
  if (R.indoorOutdoor && ['indoor', 'outdoor', 'both'].includes(R.indoorOutdoor.value) && t(R.indoorOutdoor.evidence)) {
    const g = { confidence: 'official', sourceUrl: R.indoorOutdoor.sourceUrl };
    if (/^https?:\/\//i.test(t(g.sourceUrl))) { fill('setting', R.indoorOutdoor.value, g); report('setting', R.indoorOutdoor.value, g); }
  }
  if (R.boothCost) {
    const n = parseFloat(String(R.boothCost.amount || '').replace(/[$,\s]/g, ''));
    const g = { confidence: 'official', sourceUrl: R.boothCost.sourceUrl };
    if (n > 0 && /^https?:\/\//i.test(t(g.sourceUrl))) {
      const money = `$${Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)}`;
      if (!t(e.cost)) set('cost', money, g.sourceUrl);
      else if (parseFloat(String(e.cost).replace(/[$,\s]/g, '')) !== n) notes.push({ field: 'cost', board: t(e.cost), found: money, source: g.sourceUrl, note: t(R.boothCost.note) });
    }
  }
  return { patch, changes, notes };
}

async function apply() {
  const mode = opt('--mode'), label = opt('--label', mode === 'full' ? 'preflight' : 'date-research');
  if (!['dates', 'full'].includes(mode)) throw new Error('--mode dates|full');
  const tf = opt('--targets'), rf = opt('--research');
  if (!tf || !fs.existsSync(tf) || !rf || !fs.existsSync(rf)) throw new Error('--targets <file> and --research <file> are required');
  const T = JSON.parse(fs.readFileSync(tf, 'utf8')), RS = JSON.parse(fs.readFileSync(rf, 'utf8'));
  const results = RS.results || {};
  const api = boardApi({ actor: `service:${label}` });
  const byId = new Map((await api.events()).map(e => [e.id, e]));
  const out = { date: TODAY, label, mode, apply: flag('--apply'), written: false, researched: 0, confirmed: 0, skippedTiers: T.skippedTiers || [], changes: [], vcDisagrees: [], unconfirmed: [], cancelled: [], failed: [],
    notResearched: [], questions: [], fieldChanges: [], fieldNotes: [], usage: RS.usage || null, cost: RS.cost ?? null, capped: RS.capped || 0, maxCost: RS.maxCost ?? null,
    model: RS.model || null, meeting: RS.meeting || null, perMeeting: RS.perMeeting ?? null, spentBefore: RS.spentBefore ?? null,
    reused: Object.values(results).filter(x => x && x.reused).length };
  const moves = [], fieldPatches = [];
  for (const tgt of T.targets || []) {
    const e = byId.get(tgt.id);
    if (!e) continue;
    const run = sellingRun(e), res = results[tgt.id];
    if (res && res.ok) out.researched++;
    const d = decideDates(tgt, res, run);
    const base = { id: tgt.id, name: tgt.name, run, staffed: tgt.staffed, reps: tgt.reps, vc: tgt.vc };
    if (d.kind === 'not-researched') out.notResearched.push(base);
    else if (d.kind === 'failed') out.failed.push({ ...base, why: d.why });
    else if (d.kind === 'cancelled') out.cancelled.push({ ...base, source: d.source, why: d.why });
    else if (d.kind === 'unconfirmed') { if (tgt.datesEstimated || tgt.mismatch) out.unconfirmed.push({ ...base, why: d.why, estimated: tgt.datesEstimated }); }
    else if (d.kind === 'confirmed') {
      out.confirmed++;
      if (d.vcDisagrees) out.vcDisagrees.push({ ...base, web: d.truth, source: d.source });
      if (e.datesEstimated) fieldPatches.push({ id: e.id, patch: { datesEstimated: false, datesNote: `Dates confirmed on ${host(d.source)} (checked ${TODAY})`, datesSource: { basis: 'researched', url: d.source, checkedAt: TODAY } } });
    } else if (d.kind === 'move') {
      if (tgt.multiWeek) { out.questions.push({ ...base, why: `one VC record covers several weeks; ${d.basis === 'vc' ? "VC's" : 'the researched'} dates are ${fmt(d.truth)}, the board has ${fmt(run)}. Multi-week shows are never moved unattended` }); continue; }
      const plan = planMove(e, d.truth);
      if (plan.error) { out.questions.push({ ...base, why: `${d.basis === 'vc' ? "VC's" : 'the researched'} dates are ${fmt(d.truth)}, the board has ${fmt(run)}, but ${plan.error}` }); continue; }
      const note = d.basis === 'vc'
        ? `Dates per VectorConnect ${tgt.vc ? tgt.vc.number : ''}; not confirmed online (moved from ${fmt(run)}, checked ${TODAY})`
        : `Dates moved from ${fmt(run)} to ${fmt(d.truth)} per ${host(d.source)} (checked ${TODAY})`;
      moves.push({ e, tgt, d, plan, note });
    }
    if (mode === 'full' && res && res.ok) {
      const f = decideFields(e, res.result);
      if (Object.keys(f.patch).length) fieldPatches.push({ id: e.id, patch: f.patch });
      for (const c of f.changes) out.fieldChanges.push({ id: e.id, name: tgt.name, ...c, private: ['contact', 'phone', 'email'].includes(c.field) });
      for (const n of f.notes) out.fieldNotes.push({ id: e.id, name: tgt.name, ...n });
    }
  }
  const max = opt('--max-date-changes') !== null ? Number(opt('--max-date-changes')) : 25;
  let code = 0;
  if (moves.length > max) {
    out.stopped = `${moves.length} date changes at once is more than ${max}; that looks systematic, so no dates were moved (fields were${flag('--apply') ? '' : ' not'} written)`;
    for (const m of moves) out.questions.push({ id: m.tgt.id, name: m.tgt.name, run: sellingRun(m.e), why: `would move to ${fmt(m.d.truth)} (${m.d.basis === 'vc' ? 'VC' : host(m.d.source)}), held: too many changes at once` });
    moves.length = 0; code = 5;
  }
  for (const m of moves) {
    const p = m.plan.patch;
    const change = { id: m.tgt.id, name: m.tgt.name, from: sellingRun(m.e), to: m.d.truth, basis: m.d.basis, source: m.d.source || null, host: m.d.source ? host(m.d.source) : null,
      vcNumber: m.tgt.vc ? m.tgt.vc.number : '', vcStatus: m.tgt.vc ? m.tgt.vc.status : '', vcRun: m.tgt.vc ? { start: m.tgt.vc.start, end: m.tgt.vc.end } : null,
      staffed: m.tgt.staffed, affected: m.plan.affected, added: m.plan.added, removed: m.plan.removed, note: m.note, applied: false,
      // the show as the Wednesday check will see it after the move (rsd-shift-picking records what reps were told from it)
      after: { startDate: p.startDate, endDate: p.endDate, weekend: p.weekend, first: p.dates.filter((d, i) => d && !isSE(p.days[i]))[0] || p.startDate } };
    if (flag('--apply')) {
      const cur = (await api.events()).find(x => x.id === m.e.id);
      if (!cur || !sameRun(sellingRun(cur), change.from)) { out.questions.push({ id: change.id, name: change.name, why: 'the board changed while the research ran; left alone' }); continue; }
      const snapshot = { startDate: cur.startDate, endDate: cur.endDate, weekend: cur.weekend, days: cur.days, dates: cur.dates, booths: cur.booths, datesEstimated: cur.datesEstimated ?? false };
      await api.patchEvent(m.e.id, { ...m.plan.patch, datesNote: m.note, datesSource: { basis: m.d.basis, url: m.d.source || null, vcNumber: change.vcNumber || null, checkedAt: TODAY },
        datesMoved: { from: change.from, to: change.to, at: TODAY, basis: m.d.basis, by: `service:${label}` } });
      const after = (await api.events()).find(x => x.id === m.e.id);
      const nr = after && sellingRun(after);
      if (nr && within(nr, change.to)) change.applied = true;
      else { await api.patchEvent(m.e.id, snapshot); out.questions.push({ id: change.id, name: change.name, why: `the move to ${fmt(change.to)} did not read back right (${fmt(nr)}), so it was put back` }); continue; }
    }
    out.changes.push(change);
  }
  if (flag('--apply')) for (const p of fieldPatches) await api.patchEvent(p.id, p.patch);
  out.written = flag('--apply') && (out.changes.some(c => c.applied) || fieldPatches.length > 0);
  out.counts = { targets: (T.targets || []).length, researched: out.researched, reused: out.reused, confirmed: out.confirmed, changes: out.changes.length, vcDisagrees: out.vcDisagrees.length,
    unconfirmed: out.unconfirmed.length, cancelled: out.cancelled.length, failed: out.failed.length, notResearched: out.notResearched.length, questions: out.questions.length,
    fieldChanges: out.fieldChanges.length, fieldNotes: out.fieldNotes.length };
  const dir = path.join(OUT_BASE, 'research');
  writeJson(path.join(dir, 'latest.json'), out); writeJson(path.join(dir, `${label}-${TODAY}.json`), out);
  fs.mkdirSync(path.join(OUT_BASE, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(OUT_BASE, 'reports', `${label}-${TODAY}.md`), summaryMd(out) + '\n');
  console.log(summaryMd(out));
  return code;
}

export function summaryMd(r) {
  const c = r.counts || {}, L = [`# ${r.label}, ${r.date} (${r.apply ? (r.written ? 'board updated' : 'nothing to write') : 'dry'})`, ''];
  if (r.stopped) L.push(`**STOPPED:** ${r.stopped}`, '');
  const n = (k, one, many = one + 's') => `${k} ${k === 1 ? one : many}`;
  if ((r.skippedTiers || []).length) L.push(`Not researched, the team handles them: ${r.skippedTiers.map(x => `${x.name} (${x.tier})`).join(', ')}.`, '');
  L.push(`${n(c.targets, 'show')}, ${c.researched} researched${c.reused ? ` (${c.reused} already known from earlier runs, not looked up again)` : ''}: ${n(c.confirmed, 'date')} confirmed, ${c.changes} moved, ${c.unconfirmed} not confirmed online, ${n(c.failed, 'lookup')} failed.`);
  const sec = (title, xs, line) => { if (xs && xs.length) { L.push('', `## ${title}`); for (const x of xs) L.push('- ' + line(x)); } };
  sec('Dates moved', r.changes, x => `${x.name}: ${fmt(x.from)} -> ${fmt(x.to)} (${x.basis === 'vc' ? `VectorConnect ${x.vcNumber}, not confirmed online` : x.host})${x.affected.length ? `; reps: ${x.affected.map(a => `${a.rep} ${a.to ? `${a.from}->${a.to}` : `${a.from} gone`}`).join(', ')}` : ''}${x.applied ? '' : ' (not applied)'}`);
  sec('VectorConnect disagrees with the event\'s own page (fix VC)', r.vcDisagrees, x => `${x.name}: VC ${x.vc.number} has ${fmt({ start: x.vc.start, end: x.vc.end })}, ${host(x.source)} says ${fmt(x.web)}`);
  sec('Cancelled, per the web (not changed on the board)', r.cancelled, x => `${x.name}: ${x.why} (${host(x.source)})`);
  sec('Not confirmed online', r.unconfirmed, x => `${x.name} ${fmt(x.run)}: ${x.why}${x.estimated ? " (still last year's +364 guess)" : ''}`);
  sec('Questions (nothing changed)', r.questions, x => `${x.name}: ${x.why}`);
  sec('Lookups that failed (nothing changed)', r.failed, x => `${x.name}: ${x.why}`);
  sec('Filled or corrected on the board', r.fieldChanges, x => `${x.name}: ${x.field} ${x.private ? '(contact detail)' : `"${x.from || '(blank)'}" -> "${x.to}"`} per ${host(x.source)}`);
  sec('Different online, left alone', r.fieldNotes, x => `${x.name}: ${x.field} ${['contact', 'phone', 'email'].includes(x.field) ? '(contact detail)' : `board "${x.board}", online "${x.found}"`} per ${host(x.source)}`);
  return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = { targets, apply }[cmd];
  if (!run) { console.error('usage: board-research.mjs targets|apply ... (see the header)'); process.exit(64); }
  run().then(c => process.exit(c)).catch(e => { console.error('board-research: ' + (e.stack || e.message)); process.exit(1); });
}
