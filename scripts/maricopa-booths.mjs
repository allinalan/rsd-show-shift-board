#!/usr/bin/env node
/*
  maricopa-booths — this year's Maricopa booth spots, read off the promoter's floor plans (Alan, 2026-10-24/26:
  "it can pull the map and find where our booth spots are for every maricopa").

  The plans are public PDFs linked from the promoter's "Download Floor Plans" page (config maricopaMaps.page; the
  contact form in front of it is only a gate, and no password is involved). Each plan prints the exhibitor's name in
  its booth and the booth's numbers at the box's corners, so for every "Cutco" on a plan:
    the booth numbers are the nearest number printed above it and below it in the same column (pdftotext -bbox gives
    every word's place); a wall between the name and a number (a solid line across that column, read off the rendered
    page) means that number is the next booth over, not ours ("1223" alone, not "1223-1225");
    the area (Ag Building, North Hall ...) comes from the venue's number ranges, as the plans print them (config
    maricopaMaps.venues). A number outside every range is written with no area.
  A plan is matched to the board's Maricopa show (config boothSpots) that starts within 3 days of the plan's date.

  What it writes, and only with --apply: a booth still tagged as last year's spot (lib/booth-spots.mjs) gets the
  plan's spot as its name, "Booth #2 (Ag Building) (820-822)", and loses the tag. A booth whose name already holds
  the spot's numbers keeps its name, and loses the tag if it had one (the plan says the spot again this year: what
  "same spot in <year>" does on the board). A name someone set this season is never overwritten: a spot that differs from
  it is reported. A show whose plan has a different number of Cutco booths than the board has booths, or a Cutco
  with no number beside it, is reported and not written (fail closed). Every write is read back.

  The Cutco booths on a plan are taken to be ours when the board has that show; a plan with Cutco booths and no
  Maricopa show on the board that weekend is reported (another Cutco office, or a show the board is missing).

  Usage: node scripts/maricopa-booths.mjs [--apply] [--json] [--date YYYY-MM-DD]
         ... --map <plan.pdf> --start 2027-01-15 --venue Fairgrounds   read one plan from disk, no network
  Needs poppler (pdftotext, pdftoppm: Homebrew on the mini). Plans are kept in out/maricopa-maps/ (gitignored).
  Output: out/maricopa-booths/latest.json, out/reports/maricopa-booths-<date>.md.
  Exit: 0 ok · 1 error · 2 the plans page did not load or listed no plans · 4 poppler missing
*/
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { spotShow, lastYearsSpot } from './lib/booth-spots.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
const MM = CFG.maricopaMaps || {};
const TODAY = opt('--date') || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
const OUT_BASE = process.env.BOARD_OUT_DIR || path.join(REPO, 'out');
const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };
const POPPLER = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const bin = n => POPPLER.map(d => path.join(d, n)).find(f => fs.existsSync(f));

/** The plans the promoter's page links to: "January 15-17, 2027 Fairgrounds Show Map" -> { start, venue, href }. */
export function parseMapLinks(html, base = MM.page) {
  const out = [];
  for (const m of String(html).matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = t(m[2].replace(/<[^>]+>/g, ' ').replace(/&#8211;|&ndash;/g, '-').replace(/&amp;/g, '&'));
    const d = text.match(/^([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*(?:[A-Za-z]+\s+)?\d{1,2},?\s+(\d{4})\s+(.*?)\s*show map$/i);
    if (!d) continue;
    const mo = MONTHS.indexOf(d[1].toLowerCase());
    if (mo < 0) continue;
    let href = m[1].replace(/&amp;/g, '&');
    try { href = new URL(href, base).href; } catch (e) { continue; }
    out.push({ text, start: `${d[3]}-${String(mo + 1).padStart(2, '0')}-${String(+d[2]).padStart(2, '0')}`, venue: d[4], href, pdf: /\.pdf(\?|$)/i.test(href) });
  }
  return out;
}

/** pdftotext -bbox output -> pages of words { t, x, y (centres), x0, y0, x1, y1 } in points. */
export function parseBbox(html) {
  return String(html).split(/<page /).slice(1).map((p, i) => {
    const [, w, h] = p.match(/width="([\d.]+)" height="([\d.]+)"/) || [];
    const words = [...p.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map(m => {
      const [x0, y0, x1, y1] = m.slice(1, 5).map(Number);
      return { t: m[5].replace(/&amp;/g, '&'), x: (x0 + x1) / 2, y: (y0 + y1) / 2, x0, y0, x1, y1 };
    });
    return { page: i + 1, width: +w, height: +h, words };
  });
}

/**
 * Every exhibitor booth on one page: [{ page, at: {x, y}, nums: [above, below?], numbers }].
 * wallBetween(page, number, word) -> true when a solid line crosses the column between them (the next booth over).
 * Measured on the January-July 2027 plans: a booth's corner numbers sit 8-20pt above and below the name, at most 16pt
 * to the side; the next column over is 20pt or more away, and a number level with the name (738 beside "Cutco" at 637)
 * belongs to the booth beside it.
 */
export function findSpots(page, { exhibitor = 'Cutco', wallBetween = () => false, maxDx = 18, minDy = 5, maxDy = 24 } = {}) {
  const who = new RegExp(`^${exhibitor}\\b`, 'i');
  const nums = page.words.filter(w => /^\d{2,4}$/.test(w.t));
  const spots = [];
  for (const c of page.words.filter(w => who.test(w.t))) {
    const col = nums.filter(n => Math.abs(n.x - c.x) <= maxDx && Math.abs(n.y - c.y) >= minDy && Math.abs(n.y - c.y) <= maxDy);
    // the nearest column first, then the nearest number in it (822 and 824 stand in one column a hair apart: by x alone, 824 won)
    const best = side => {
      const c2 = col.filter(n => side * (n.y - c.y) > 0); if (!c2.length) return null;
      const dx = Math.min(...c2.map(n => Math.abs(n.x - c.x)));
      return c2.filter(n => Math.abs(n.x - c.x) <= dx + 3).sort((a, b) => Math.abs(a.y - c.y) - Math.abs(b.y - c.y))[0];
    };
    let above = best(-1), below = best(1);
    if (above && below && Math.abs(above.x - below.x) > 4) { (Math.abs(above.x - c.x) <= Math.abs(below.x - c.x)) ? (below = null) : (above = null); }
    if (above && wallBetween(page, above, c)) above = null;
    if (below && wallBetween(page, below, c)) below = null;
    const got = [above, below].filter(Boolean).map(n => +n.t);
    spots.push({ page: page.page, at: { x: Math.round(c.x), y: Math.round(c.y) }, numbers: got });
  }
  return spots;
}

/** The area a booth number is in, from the venue's ranges (config maricopaMaps.venues), or ''. */
export function areaOf(venue, n, venues = MM.venues || {}) {
  const key = Object.keys(venues).find(k => new RegExp(`\\b${k}\\b`, 'i').test(venue));
  for (const [lo, hi, name] of (key && venues[key]) || []) if (n >= lo && n <= hi) return name;
  return '';
}
/** "Booth #2 (Ag Building) (820-822)": the shape the January 2027 names on the Sheet already have. */
export const spotName = (i, spot) => `Booth #${i + 1}${spot.area ? ` (${spot.area})` : ''} (${spot.numbers.join('-')})`;
const holds = (label, numbers) => numbers.every(n => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(String(label || '')));

/**
 * What to do with one show: { writes: [{ booth, from, to }], kept: [...], report: [...], ok }.
 * A booth whose name already holds a spot's numbers keeps it; the other spots go, in order, to the booths still
 * tagged as last year's spot; anything else is reported, never written.
 */
export function planShow(ev, spots) {
  const plan = { id: ev.id, name: ev.name, writes: [], kept: [], report: [], ok: true };
  const bad = spots.filter(s => !s.numbers.length);
  if (bad.length) { plan.ok = false; plan.report.push(`${bad.length} Cutco booth(s) on the plan with no booth number beside them (page ${bad.map(s => s.page).join(', ')}): nothing written for this show`); }
  if (spots.length !== (ev.booths || []).length) { plan.ok = false; plan.report.push(`the plan has ${spots.length} Cutco booth(s), the board has ${(ev.booths || []).length}: nothing written for this show`); }
  const booths = (ev.booths || []).map((b, i) => ({ i, b }));
  const left = [];
  for (const s of spots.filter(s => s.numbers.length)) {
    // the plan says it again this year: a "last year's spot" tag on it comes off (Plan mode's "same spot in <year>")
    const own = booths.find(x => !x.used && holds(x.b.label, s.numbers));
    if (own) { own.used = true; plan.kept.push({ booth: own.i, label: own.b.label, numbers: s.numbers, confirm: lastYearsSpot(own.b) }); } else left.push(s);
  }
  // The spots left go, in order, to the booths still tagged; but with a booth named this season also left over there
  // is no telling which spot is whose, so then none is written (a show is all rolled or all named, unless fixed by hand)
  const named = booths.filter(x => !x.used && !lastYearsSpot(x.b));
  for (const s of left) {
    const to = !named.length && booths.find(x => !x.used && lastYearsSpot(x.b));
    if (to) { to.used = true; plan.writes.push({ booth: to.i, from: to.b.label, to: spotName(to.i, s), spot: s }); continue; }
    plan.report.push(`the plan has Cutco at ${s.area ? s.area + ' ' : ''}${s.numbers.join('-')}, and no booth on the board says so${named.length ? '' : ' or is still last year\'s spot'}`);
  }
  for (const x of booths.filter(x => !x.used)) plan.report.push(`Booth #${x.i + 1} "${x.b.label || '(no name)'}" ${lastYearsSpot(x.b) ? 'is still last year\'s spot, with no Cutco booth left on the plan for it' : 'matches no Cutco booth on the plan (named this season, so left as it is)'}`);
  if (!plan.ok) { plan.writes = []; plan.kept.forEach(k => { k.confirm = false; }); }
  return plan;
}

// ---------- reading a plan ----------------------------------------------------------------------------------
/** A solid line across the column between a number and the name: the rendered page, 2px a point, dark = < 110. */
function makeWallCheck(pdf, tmp) {
  const cache = new Map(), pdftoppm = bin('pdftoppm');
  const img = page => {
    if (!cache.has(page)) {
      const pre = path.join(tmp, `p${page}`);
      execFileSync(pdftoppm, ['-gray', '-r', '144', '-f', String(page), '-l', String(page), '-singlefile', pdf, pre]);
      const buf = fs.readFileSync(pre + '.pgm');
      const hdr = buf.toString('latin1', 0, 64).match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
      cache.set(page, { w: +hdr[1], h: +hdr[2], off: hdr[0].length, buf });
    }
    return cache.get(page);
  };
  // The rows strictly between the number's glyphs and the name's middle, across 18pt centred on the number. A row
  // through the name's own letters (upright or turned on its side) is never 80% dark; a booth wall is.
  return (pg, n, c) => {
    const im = img(pg.page), k = im.w / pg.width;
    const [ya, yb] = n.y < c.y ? [n.y1, c.y] : [c.y, n.y0];
    const y0 = Math.round(ya * k), y1 = Math.round(yb * k);
    const x0 = Math.round((n.x - 9) * k), x1 = Math.round((n.x + 9) * k);
    for (let y = Math.max(0, y0 + 1); y < Math.min(im.h, y1); y++) {
      let dark = 0;
      for (let x = Math.max(0, x0); x < Math.min(im.w, x1); x++) if (im.buf[im.off + y * im.w + x] < 110) dark++;
      if (dark >= 0.8 * (x1 - x0)) return true;
    }
    return false;
  };
}
/** Every Cutco booth on one plan PDF, with its area. */
export function readPlan(pdf, venue, { exhibitor = MM.exhibitor || 'Cutco' } = {}) {
  const pdftotext = bin('pdftotext');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcb-'));
  try {
    const html = execFileSync(pdftotext, ['-bbox', pdf, '-'], { maxBuffer: 64 << 20 }).toString('utf8');
    const wallBetween = makeWallCheck(pdf, tmp);
    return parseBbox(html).flatMap(pg => findSpots(pg, { exhibitor, wallBetween }))
      .map(s => ({ ...s, area: s.numbers.length ? areaOf(venue, s.numbers[0]) : '' }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- main ------------------------------------------------------------------------------------------
async function main() {
  const APPLY = flag('--apply'), JSON_OUT = flag('--json');
  if (!bin('pdftotext') || !bin('pdftoppm')) { console.error('maricopa-booths: poppler is missing (pdftotext, pdftoppm). On the mini: brew install poppler. Nothing read.'); process.exit(4); }
  const mapDir = path.join(OUT_BASE, 'maricopa-maps');
  fs.mkdirSync(mapDir, { recursive: true, mode: 0o700 });

  let maps;
  if (opt('--map')) maps = [{ text: path.basename(opt('--map')), start: opt('--start') || '', venue: opt('--venue') || '', href: '', pdf: true, file: opt('--map') }];
  else {
    let html = '';
    try { const r = await fetch(MM.page, { headers: { 'User-Agent': 'Mozilla/5.0 (RSD Show Shift Board)' } }); if (!r.ok) throw new Error('HTTP ' + r.status); html = await r.text(); }
    catch (e) { console.error(`maricopa-booths: the plans page did not load (${MM.page}): ${e.message}. Nothing read.`); process.exit(2); }
    maps = parseMapLinks(html);
    if (!maps.length) { console.error(`maricopa-booths: the plans page (${MM.page}) lists no "<dates> <venue> Show Map" links any more; it has changed. Nothing read.`); process.exit(2); }
  }

  const { boardApi } = await import('./lib/board-api.mjs');
  const api = boardApi({ actor: process.env.BOARD_ACTOR || 'service:maricopa-booths' });
  const events = (await api.events()).filter(e => spotShow(e.name, CFG.boothSpots));
  const showOn = start => events.filter(e => { const d = e.startDate || e.weekend; return d && Math.abs(dayDiff(d, start)) <= 3; });

  const result = { date: TODAY, mode: APPLY ? 'apply' : 'dry', page: MM.page, maps: [], shows: [], notOnBoard: [], wrote: [], readBack: null };
  for (const m of maps) {
    const rec = { plan: m.text, start: m.start, venue: m.venue, href: m.href, spots: [], note: '' };
    result.maps.push(rec);
    if (!m.pdf) { rec.note = 'not a PDF (a picture): read it by hand'; continue; }
    let file = m.file;
    if (!file) {
      file = path.join(mapDir, path.basename(new URL(m.href).pathname));
      if (!fs.existsSync(file)) {
        const r = await fetch(m.href).catch(e => ({ ok: false, status: e.message }));
        if (!r.ok) { rec.note = `did not download (${r.status})`; continue; }
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()), { mode: 0o600 });
      }
    }
    try { rec.spots = readPlan(file, m.venue); } catch (e) { rec.note = 'could not be read: ' + e.message.split('\n')[0]; continue; }
    if (!rec.spots.length) { rec.note = 'no Cutco booth on this plan'; continue; }
    const evs = showOn(m.start);
    if (!evs.length) { result.notOnBoard.push(rec); rec.note = 'Cutco booths on the plan, but no Maricopa show on the board that weekend'; continue; }
    for (const ev of evs) result.shows.push({ ...planShow(ev, rec.spots), plan: m.text });
  }

  if (APPLY) {
    const bad = [];
    for (const p of result.shows.filter(p => p.ok && (p.writes.length || p.kept.some(k => k.confirm)))) {
      const ev = events.find(e => e.id === p.id);
      const booths = JSON.parse(JSON.stringify(ev.booths));
      const unspot = b => { delete b.rolledLabel; delete b.rolledLabelYear; };
      for (const w of p.writes) { booths[w.booth].label = w.to; unspot(booths[w.booth]); }
      for (const k of p.kept.filter(k => k.confirm)) unspot(booths[k.booth]);
      await api.patchEvent(p.id, { booths });
      const back = await api.row('events', p.id);
      const okBack = back && p.writes.every(w => back.booths[w.booth] && back.booths[w.booth].label === w.to && !lastYearsSpot(back.booths[w.booth]))
        && p.kept.filter(k => k.confirm).every(k => back.booths[k.booth] && !lastYearsSpot(back.booths[k.booth]));
      if (!okBack) bad.push(p.id);
      result.wrote.push({ id: p.id, name: p.name, booths: p.writes.map(w => ({ booth: w.booth + 1, from: w.from, to: w.to })), confirmed: p.kept.filter(k => k.confirm).map(k => k.booth + 1) });
    }
    result.readBack = { ok: result.wrote.length - bad.length, bad };
  }

  const md = [`# Maricopa booth spots from the promoter's plans, ${TODAY} (${result.mode}${APPLY ? '' : ', nothing written'})`, '', `Plans page: ${MM.page}`, ''];
  for (const m of result.maps) md.push(`- **${m.plan}**: ${m.spots.length ? m.spots.map(s => `${s.area ? s.area + ' ' : ''}${s.numbers.join('-') || '(no number)'} (p${s.page})`).join(', ') : ''}${m.note ? ` ${m.spots.length ? '· ' : ''}${m.note}` : ''}`);
  for (const p of result.shows) {
    md.push('', `## ${p.name} (${p.plan})`);
    for (const k of p.kept) md.push(`- Booth #${k.booth + 1} "${k.label}" already says ${k.numbers.join('-')}${k.confirm ? `: the same spot this year, so its "last year's spot" tag ${APPLY ? 'came' : 'would come'} off` : ''}`);
    for (const w of p.writes) md.push(`- Booth #${w.booth + 1}: "${w.from}" -> "${w.to}"${APPLY ? '' : ' (would write)'}`);
    for (const r of p.report) md.push(`- ${r}`);
  }
  if (result.notOnBoard.length) { md.push('', '## Cutco on a plan, no Maricopa show on the board that weekend'); for (const m of result.notOnBoard) md.push(`- ${m.plan}: ${m.spots.map(s => `${s.area ? s.area + ' ' : ''}${s.numbers.join('-')}`).join(', ')}`); }
  if (result.readBack) md.push('', `Read back: ${result.readBack.ok} show(s) as written${result.readBack.bad.length ? `; DIFFERENT: ${result.readBack.bad.join(', ')}` : ''}.`);
  writeJson(path.join(OUT_BASE, 'maricopa-booths', 'latest.json'), result);
  fs.mkdirSync(path.join(OUT_BASE, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(OUT_BASE, 'reports', `maricopa-booths-${TODAY}.md`), md.join('\n') + '\n');
  console.log(JSON_OUT ? JSON.stringify(result, null, 1) : md.join('\n'));
  if (result.readBack && result.readBack.bad.length) process.exit(1);
}

if (isMain(import.meta.url)) main().catch(e => { console.error('maricopa-booths: ' + (e.stack || e)); process.exit(1); });
