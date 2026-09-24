#!/usr/bin/env node
/*
  booking-sweep — the board's half of the post-meeting booking sweep (Alan, 2026-09-23).

  rsd-shift-picking's run-booking-sweep.sh runs this two days after a shift-picking meeting (and on each
  day of the follow-up week), right after a fresh VC My Events pull, the Sheet -> board sync and the event
  check, which wrote VC's status onto the board and left out/event-check/latest.json. This sorts every
  staffed upcoming show into what the sweep does with it:

    request   VC has no record for it this season -> a Booking Request. rsd-shift-picking looks up the
              previous record (rebook or new), fills VC's form and submits it after Alan replies "approved".
    email     VC has it as Prospective -> on the list emailed to Cutco's events team (Olean) asking them to book it.
    question  a date disagreement still standing: VC-vs-board mismatches are researched and fixed BEFORE this
              runs (scripts/board-research.mjs, Alan 2026-09-24: the web's date wins, else VC's, with a note on
              the board), so what is left here is what that step could not settle (a multi-week show, a failed
              lookup, a name that does not agree): listed for Alan, nothing changed.
    hold      would be a request, but is not safe to send unattended (reason each).
    pending   a request already submitted and still inside requestPendingDays.
    sponsored covered by a sponsorship Alan arranged with Cutco (the exclude file's "sponsorships": a name, what it is,
              and an "until" date after which the rule lapses and the dates are swept normally again): never requested,
              never on the Olean email, never a question. Queen Creek Family Market, Gold Sponsorship (Alan, 2026-09-24).

  Scope: upcoming, staffed (SE days never count), live (not dead or never-work), not Mesa (outside VC),
  not on the exclude list rsd-shift-picking passes (Alan's direct shows), not ruled off, not a
  placeholder-only date, not a board VC number missing from the pull, not a number two unrelated shows claim.

  Writes nothing (since 2026-09-24: dates are written by scripts/board-research.mjs; rsd-shift-picking marks a
  show "Booking Request Submitted" after VC confirms the request). --apply means "a live run": it then refuses an
  event check that ran dry.

  Usage:
    booking-sweep.mjs --vc <pull.json> [--check <out/event-check/latest.json>] [--exclude-file <json>]
                      [--research <out/research/latest.json>] [--meeting YYYY-MM-DD] [--apply] [--date YYYY-MM-DD]
  --exclude-file: a JSON file with "exclude": [show names], "excludeTiers": [board tiers] and "sponsorships":
  [{ name, kind, until }] (rsd-shift-picking data/booking-sweep-config.json). A sponsorship's name covers every show
  whose name starts with it. A show of an excluded tier (Alan, 2026-09-24: every Elite show) is left out like his
  direct shows: never requested, never on the Olean email, never a question; the team books those itself.
  --research: today's board-research apply output; a date question then says which side the show's own page backs
  (VC is the one to fix) or that the lookup failed, instead of "could not settle".
  Output: out/booking-sweep/latest.json (+ a dated copy; mode 600: requests carry the promoter contacts the
  form needs, so this file never leaves the mini), out/reports/booking-sweep-<date>.md (no contacts).
  Exit: 0 ok · 1 error · 4 no trustworthy event check to work from
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { boardApi } from './lib/board-api.mjs';
import { nameScore, dayDiff, normName, tierOf } from './lib/match.mjs';
import { sellingRun, within, sameRun } from './lib/dates.mjs';
export { sellingRun, within };                     // lib/booking-sweep-exec.js in rsd-shift-picking reads them from here

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
export const SW = { holdDaysBefore: 10, duplicateWindowDays: 60, duplicateMinScore: 0.6, ...(CFG.sweep || {}) };
const TODAY = opt('--date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
const MESA = new RegExp(CFG.mesaPattern, 'i');
const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const OUT_BASE = process.env.BOARD_OUT_DIR || path.join(REPO, 'out');
const OUT_S = path.join(OUT_BASE, 'booking-sweep'), OUT_R = path.join(OUT_BASE, 'reports');

// ---------- helpers ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = iso => `${MON[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
/** "Oct 23-25", "Oct 30-Nov 1", "Oct 23"; what Alan reads in the preview. */
export const fmt = r => (r ? (r.start === r.end ? md(r.start) : r.start.slice(0, 7) === r.end.slice(0, 7) ? `${md(r.start)}-${+r.end.slice(8, 10)}` : `${md(r.start)}-${md(r.end)}`) : 'no usable dates');

// ---------- the sweep ----------
async function main() {
  const checkPath = opt('--check') || path.join(OUT_BASE, 'event-check', 'latest.json');
  const research = (() => { const f = opt('--research'); try { const j = f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; return j && j.date === TODAY ? j : null; } catch (e) { return null; } })();
  const webBacksBoard = id => research && (research.vcDisagrees || []).find(x => x.id === id);
  const lookupFailed = id => research && (research.failed || []).find(x => x.id === id);
  const vcPath = opt('--vc');
  const result = { date: TODAY, runAt: new Date().toISOString(), meeting: opt('--meeting'), mode: flag('--apply') ? 'apply' : 'dry', written: false,
    requests: [], holds: [], email: [], questions: [], pending: [], excluded: [], sponsored: [], skipped: [], claimedVc: [] };
  const stop = async (why, code) => { result.stopped = why; await write(result); console.error('booking-sweep: ' + why); return code; };

  if (!fs.existsSync(checkPath)) return stop(`no event check result at ${checkPath}; run the event check first`, 4);
  const check = JSON.parse(fs.readFileSync(checkPath, 'utf8'));
  if (check.stopped) return stop(`the event check did not trust its VC data (${check.stopped}); nothing swept`, 4);
  if (check.date !== TODAY) return stop(`the event check is from ${check.date}, not today (${TODAY}); run it first`, 4);
  if (flag('--apply') && check.mode !== 'apply') return stop('the event check ran dry, so the board does not carry today\'s VC status; not sweeping for real on it', 4);
  if (!vcPath || !fs.existsSync(vcPath)) throw new Error('--vc <pull.json> is required (the same My Events pull the event check used)');
  const vc = (JSON.parse(fs.readFileSync(vcPath, 'utf8')).rows || []).map(r => ({ ...r, eventNumber: t(r.eventNumber) }));
  const exJson = opt('--exclude-file') && fs.existsSync(opt('--exclude-file')) ? JSON.parse(fs.readFileSync(opt('--exclude-file'), 'utf8')) : {};
  const exclude = new Set((exJson.exclude || []).map(normName));
  const excludeTiers = new Set((exJson.excludeTiers || []).map(x => t(x).toLowerCase()).filter(Boolean));
  const sponsorships = (exJson.sponsorships || []).filter(s => t(s.name));
  const sponsorOf = (name, run) => sponsorships.find(s => { const k = normName(s.name), n = normName(name); return (n === k || n.startsWith(k + ' ')) && (!s.until || !run || run.start <= s.until); }) || null;
  const placeholders = new Set((CFG.placeholders || []).map(String));
  const vcByNumber = new Map(vc.map(v => [v.eventNumber, v]));
  const vcPlace = n => { const v = vcByNumber.get(n); return v ? [t(v.city), t(v.state)].filter(Boolean).join(', ') : ''; };

  const api = boardApi({ actor: 'service:booking-sweep' });
  const byId = new Map((await api.events()).map(e => [e.id, e]));
  const recs = (check.events || []).filter(r => r.upcoming && r.staffed);

  // VC numbers a checked show already claims: a "duplicate" there belongs to that show, not this one
  const claimed = new Map();
  for (const r of check.events || []) if (r.vcNumber && r.category !== 'no-vc') { if (!claimed.has(r.vcNumber)) claimed.set(r.vcNumber, []); claimed.get(r.vcNumber).push(r.id); }
  result.claimedVc = [...claimed.keys()];
  // A multi-week show is one VC record claimed by several weekly rows: judged as one run, never auto-moved.
  const groupOf = r => (r.vcNumber && (claimed.get(r.vcNumber) || []).filter(id => recs.some(x => x.id === id)).length > 1 ? r.vcNumber : null);
  const groupsDone = new Set(), emailed = new Set();

  for (const r of recs) {
    const e = byId.get(r.id);
    const base = { id: r.id, name: r.name, weekend: r.weekend, reps: r.reps || [], cityState: e ? t(e.cityState) : '' };
    if (!e) { result.skipped.push({ ...base, why: 'no longer on the board' }); continue; }
    if (e.dead || e.neverWork) { result.skipped.push({ ...base, why: 'dead or never-work on the board' }); continue; }
    if (MESA.test(r.name)) continue;
    if (exclude.has(normName(r.name))) { result.excluded.push(base); continue; }
    if (excludeTiers.has(t(tierOf(e, CFG.tierRules)).toLowerCase())) { result.excluded.push({ ...base, tier: t(tierOf(e, CFG.tierRules)) }); continue; }
    if (r.ruling || r.category === 'dead') { result.skipped.push({ ...base, why: r.ruling ? "not happening (Alan's ruling)" : `dead in VC (${r.vcStatus})` }); continue; }
    const run = sellingRun(e);
    base.run = run;
    const sp = sponsorOf(r.name, run);
    if (sp) { result.sponsored.push({ ...base, covers: t(sp.name), kind: t(sp.kind) || 'sponsorship', until: sp.until || null }); continue; }
    if (r.openQuestion) { result.questions.push({ ...base, kind: 'placeholder', why: `only the placeholder VC record${(r.notes || []).join(' ').match(/placeholder (\d+)/) ? ' ' + (r.notes || []).join(' ').match(/placeholder (\d+)/)[1] : ''} covers ${fmt(run)}. Request it, or is it booked?` }); continue; }
    if (r.numberMissing) { result.questions.push({ ...base, kind: 'number-missing', why: `the board carries VC# ${r.vcNumber}, which is not in today's pull` }); continue; }
    if (r.suspicious) { result.questions.push({ ...base, kind: 'duplicate-number', why: `VC# ${r.vcNumber} is also claimed by an unrelated show` }); continue; }

    if (r.category === 'no-vc') {
      if (r.requestPending) { result.pending.push({ ...base, requestedAt: r.vcRequestedAt }); continue; }
      if (r.mismatchRow) {
        const m = r.mismatchRow;
        result.questions.push({ ...base, kind: 'vc-other-dates', vcNumber: m.eventNumber, why: `VC has ${m.eventNumber} ${m.name} on ${fmt({ start: m.startDate, end: m.endDate })} (${m.status}), the board has ${fmt(run)}. Not requested: fix the dates, or it is a different show` });
        continue;
      }
      const why = [];
      if (!run) why.push('the board has no usable selling-day dates for it');
      else if (dayDiff(run.start, TODAY) < SW.holdDaysBefore) why.push(`starts ${run.start}, too close to request unattended`);
      if (e.datesEstimated) why.push("its dates are still last year's +364 guess (the preflight confirms them)");
      const dup = run ? vc.filter(v => !claimed.has(v.eventNumber) && !placeholders.has(v.eventNumber) && nameScore(e.name, v.name) >= SW.duplicateMinScore && Math.abs(dayDiff(v.startDate, run.start)) <= SW.duplicateWindowDays) : [];
      if (dup.length) why.push(`VC already has ${dup.slice(0, 2).map(v => `${v.eventNumber} ${v.name} on ${fmt({ start: v.startDate, end: v.endDate })} (${v.status})`).join(' and ')}: a date or name mismatch, not a missing booking?`);
      if ((r.aliasCandidates || []).length) why.push(`VC has ${r.aliasCandidates.map(c => `${c.eventNumber} ${c.name} (${c.status})`).join('; ')} that weekend in the same city: renamed?`);
      const req = { ...base, fields: requestFields(e) };
      if (why.length) result.holds.push({ ...req, why });
      else result.requests.push(req);
      continue;
    }

    // VC has a record for it
    const vcRun = r.vcStart ? { start: r.vcStart, end: r.vcEnd || r.vcStart } : null;
    const prospective = /^prospective$/i.test(t(r.vcStatus));
    const g = groupOf(r);
    if (g) {
      if (groupsDone.has(g)) continue;
      groupsDone.add(g);
      const members = recs.filter(x => x.vcNumber === g && byId.get(x.id));
      const runs = members.map(x => sellingRun(byId.get(x.id))).filter(Boolean);
      const union = runs.length === members.length ? { start: runs.map(x => x.start).sort()[0], end: runs.map(x => x.end).sort().slice(-1)[0] } : null;
      const gbase = { ...base, id: members.map(x => x.id).join(','), ids: members.map(x => x.id), name: r.name, reps: [...new Set(members.flatMap(x => x.reps || []))], run: union };
      if (prospective && !emailed.has(g)) { emailed.add(g); result.email.push({ ...gbase, vcNumber: g, vcName: r.vcName, vcPlace: vcPlace(g), vcStatus: r.vcStatus, vcRun, datesDiffer: !within(union, vcRun) }); }
      if (vcRun && !within(union, vcRun)) result.questions.push({ ...gbase, kind: 'multi-week', vcNumber: g, vcStatus: r.vcStatus, vcRun, why: `one VC record covers its ${members.length} weeks: VC has ${fmt(vcRun)} (${r.vcStatus}), the board has ${fmt(union)}. Multi-week shows are never changed unattended` });
      continue;
    }
    if (prospective && !emailed.has(r.vcNumber)) { emailed.add(r.vcNumber); result.email.push({ ...base, vcNumber: r.vcNumber, vcName: r.vcName, vcPlace: vcPlace(r.vcNumber), vcStatus: r.vcStatus, vcRun, datesDiffer: !!run && !within(run, vcRun) }); }
    if (!vcRun || within(run, vcRun)) continue;
    if (!run) { result.questions.push({ ...base, kind: 'no-board-dates', vcNumber: r.vcNumber, vcStatus: r.vcStatus, vcRun, why: `VC has ${fmt(vcRun)} (${r.vcStatus}), and the board has no usable dates to compare` }); continue; }
    // the date research ran before this and fixes what it can: whatever still disagrees, it could not settle,
    // or the show's own page backs the board (then VC is the one that is wrong)
    const w = webBacksBoard(r.id), fl = lookupFailed(r.id);
    const why = w ? `VC has ${fmt(vcRun)}, but ${host(w.source)} says ${fmt(w.web)}, which is what the board has: VC is the one to fix`
      : fl ? `VC has ${fmt(vcRun)}, the board has ${fmt(run)}. The date research's lookup failed (${fl.why}), so nothing was changed`
      : `VC has ${fmt(vcRun)}, the board has ${fmt(run)}. The date research could not settle it (see its report)`;
    result.questions.push({ ...base, kind: w ? 'vc-wrong' : 'dates', vcNumber: r.vcNumber, vcStatus: r.vcStatus, vcRun, why, ...(w ? { source: w.source } : {}) });
  }

  const code = 0;
  result.counts = Object.fromEntries(['requests', 'holds', 'email', 'questions', 'pending', 'excluded', 'sponsored', 'skipped'].map(k => [k, result[k].length]));
  await write(result);
  console.log(summaryMd(result));
  return code;
}

/** What the booking form needs from the board. Contacts are merged in by board-api (never in git). */
function requestFields(e) {
  const pick = k => t(e[k]);
  return { name: t(e.name), cityState: pick('cityState'), location: pick('location'), address: pick('address'), promoter: pick('promoter'),
    contact: pick('contact'), phone: pick('phone'), email: pick('email'), website: pick('website'), applyUrl: pick('applyUrl'), applyBy: pick('applyBy'),
    cost: pick('cost'), costNum: e.costNum ?? null, costBasis: pick('costBasis') || 'date', setting: pick('setting'), notes: t(e.notes), tier: pick('tier'),
    lastYearVcNumber: t(e.lastYear && e.lastYear.vcNumber), datesEstimated: !!e.datesEstimated };
}

// ---------- outputs ----------
export function summaryMd(r) {
  const md = [`# Booking sweep, ${r.date}${r.meeting ? ` (meeting ${r.meeting})` : ''} (${r.mode})`, ''];
  if (r.stopped) md.push(`**STOPPED:** ${r.stopped}`, '');
  const c = r.counts || {};
  md.push(`${c.requests ?? 0} to request, ${c.holds ?? 0} held, ${c.email ?? 0} Prospective for the Olean email, ${c.questions ?? 0} question(s), ${c.pending ?? 0} request(s) already with Olean.`);
  const sec = (title, xs, line) => { if (xs && xs.length) { md.push('', `## ${title}`); for (const x of xs) md.push('- ' + line(x)); } };
  sec('Requests (submitted only after Alan approves)', r.requests, x => `${fmt(x.run)} ${x.name} (${x.reps.join(', ')})`);
  sec('Held', r.holds, x => `${fmt(x.run)} ${x.name}: ${x.why.join('; ')}`);
  sec('Prospective in VC (the Olean email)', r.email, x => `${x.vcNumber} ${x.name}: VC ${fmt(x.vcRun)}${x.datesDiffer ? `, board ${fmt(x.run)}` : ''}`);
  sec('Questions for Alan (nothing changed)', r.questions, x => `${x.name}: ${x.why}`);
  sec('Requests already with Olean', r.pending, x => `${x.name}: submitted ${x.requestedAt}`);
  sec('Covered by a sponsorship (not requested, not on the Olean email)', r.sponsored, x => `${fmt(x.run)} ${x.name}: ${x.kind}${x.until ? ` (the rule runs through ${x.until})` : ''}`);
  sec('Left out (the team books these itself: Alan\'s direct shows and Elite shows)', r.excluded, x => `${x.name}${x.tier ? ` (${x.tier})` : ''}`);
  return md.join('\n');
}

async function write(result) {
  fs.mkdirSync(OUT_S, { recursive: true, mode: 0o700 }); fs.mkdirSync(OUT_R, { recursive: true });
  for (const f of [path.join(OUT_S, 'latest.json'), path.join(OUT_S, `${result.date}.json`)]) {
    fs.writeFileSync(f + '.tmp', JSON.stringify(result, null, 1), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
  }
  fs.writeFileSync(path.join(OUT_R, `booking-sweep-${result.date}.md`), summaryMd(result) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(c => process.exit(c)).catch(e => { console.error('booking-sweep: ' + (e.stack || e.message)); process.exit(1); });
}
