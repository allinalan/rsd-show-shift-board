#!/usr/bin/env node
/*
  sheet-mirror — the board -> Sheet mirror (stage 3, docs/stage-3-january.md; Alan 2026-10-27: the January 13, 2027
  meeting is the first one run on the board). Until the cutover it writes only its own copies of the two books.

    sheet-mirror.mjs status
        Is there a Google key, which copies exist, when each was last written.
    sheet-mirror.mjs setup-copies
        Makes the mirror's own copy of each book (a new spreadsheet holding only that book's tab, "Mirror copy · ..."),
        once; state/mirror-copies.json says which. Needs the key (node scripts/authorize-sheets.mjs, Alan, once).
    sheet-mirror.mjs write [--book sept-feb|jan-may] [--force]
        Renders the board over the book's weekends from stage3.mirrorFrom, reads it back in memory with this repo's
        parser (any difference from the board writes nothing), then replaces the copy's rows from the first owned banner
        down, in one batch, and reads every cell and font color back (a difference is exit 2). Cells changed in the copy
        since the last write are listed (the board wins). More than 40 shows changed since the last write is exit 3
        (--force by hand). MIRROR-PAUSED in the repo root stops it; state/sheet-mirror.lock keeps two runs apart.

    sheet-mirror.mjs compare [--book sept-feb|jan-may] [--feed <live-feed.json>] [--json]
        Lays the board out the way the mirror will write it (lib/mirror-render.mjs) over each book's weekends from
        config stage3.mirrorFrom, puts it in place of the team's rows in a copy of the tab held in memory, and reads both
        with rsd-shift-picking's own parser (lib/schedule.js): who works which day of which show, dead or not, tentative,
        Key or Traditional. Also reads the rendered rows back with this repo's parser and compares them with the board.
        The real tabs come from the Picking Feed's last pull (rsd-shift-picking data/live-feed.json, values and font
        colors). Reads only; the report goes to out/mirror/compare-<date>.md and .json (600: it names reps).
*/
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { boardApi } from './lib/board-api.mjs';
import { renderWeekends } from './lib/mirror-render.mjs';
import { ownedStart, composeTab, comparePicking, compareBoard, sameShow } from './lib/mirror-compare.mjs';
import { makeRepResolver } from './parse-sheet.mjs';
import { sheetsApi, cellData, cellBack, TOKEN_FILE } from './lib/sheets-api.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), cmd = args[0];
const opt = (f, d = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const flag = f => args.includes(f);
const die = (m, code = 1) => { console.error('sheet-mirror: ' + m); process.exit(code); };
const PICKING = process.env.RSD_SHIFT_PICKING || path.join(os.homedir(), 'automations', 'rsd-shift-picking');
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
const STATE = process.env.BOARD_STATE_DIR || path.join(REPO, 'state');
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(w => w.length > 1);
// the board spells a rep its own way ("Foss", "Matt A."), the picking order by full name ("Matt Foss"): any word in common
const samePerson = (a, b) => { const B = new Set(words(b)); return words(a).some(w => B.has(w)); };
const showDays = e => new Set([...(e.dates || []), ...(e.booths || []).flatMap(b => b.dates || [])].filter(Boolean));

/** Why a shift reads differently on the mirror: what the board, the team's row and the sync's own records say. */
function explainer(events, realEvents, start, stale) {
  const boardOn = (date, event) => events.filter(e => sameShow(e.name, event) && (showDays(e).has(date) || (e.startDate && e.startDate <= date && date <= (e.endDate || e.startDate))));
  return (kind, r, m) => {
    if (kind === 'real') {
      const shows = boardOn(r.date, r.event);
      if (!shows.length) return 'the board has no such show that day';
      if (stale.some(x => shows.some(s => s.id === x.id) && samePerson(x.rep || x.cell, r.repName))) return "last year's name still in the team's row: the board leaves it out (Jan-May first load, 2026-10-23)";
      return 'on the Sheet, not on the board: the two disagree';
    }
    if (kind === 'mirror') {
      const theirs = realEvents.filter(e => e.row > start && sameShow(e.event, m.event));
      if (theirs.length && theirs.every(e => !e.startDate)) return "the team's row has no Start Date, so the picking order skips it today";
      if (theirs.length && !theirs.some(e => (e.dates || []).includes(m.date))) return "the board has it on a day the team's row does not";
      return 'on the board, not on the Sheet: the two disagree';
    }
    const why = [];
    if (r.dead !== m.dead) why.push(`column C on the Sheet says ${JSON.stringify(r.status || '')}, the board says ${JSON.stringify(m.status || '')}`);
    if (r.scheduledType !== m.scheduledType) why.push(`${r.scheduledType || 'no type'} on the Sheet, ${m.scheduledType || 'no type'} from the board's tier`);
    if (r.tentative !== m.tentative) why.push(r.tentative ? 'a blue name on the Sheet (blue is not carried)' : 'tentative on the mirror');
    if (r.nonSelling !== m.nonSelling) why.push('the day label says set-up or SE on one side only');
    return why.join('; ');
  };
}

function config() {
  const c = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'event-check.json'), 'utf8'));
  const s3 = c.stage3 || {}; if (!s3.mirrorFrom || !Array.isArray(s3.mirror)) die('config/event-check.json has no stage3.mirrorFrom / stage3.mirror');
  return s3.mirror.map(m => { const book = (c.sheets || []).find(b => b.key === m.book); if (!book) die(`stage3.mirror names a book config.sheets does not have: ${m.book}`); return { ...book, from: s3.mirrorFrom, to: m.to }; });
}

async function compare() {
  const books = config().filter(b => !opt('--book') || b.key === opt('--book'));
  const feedFile = opt('--feed') || path.join(PICKING, 'data', 'live-feed.json');
  let feed; try { feed = JSON.parse(fs.readFileSync(feedFile, 'utf8')); } catch (e) { die(`cannot read the Picking Feed's last pull (${feedFile}): ${e.code || e.message}`); }
  const { parseSchedule } = createRequire(import.meta.url)(path.join(PICKING, 'lib', 'schedule.js'));
  const api = boardApi({ actor: 'service:sheet-mirror' });
  const [events, settings] = await Promise.all([api.events(), api.settings()]);
  if (events.length < 50) die(`only ${events.length} shows came back from the board, so nothing was compared`);
  const resolve = makeRepResolver([...(settings.roster || []), ...(settings.former || [])]);
  const report = { at: new Date().toISOString(), feedPulledAt: feed.pulledAt || null, books: [] };
  for (const book of books) {
    const wb = Object.values(feed.workbooks || {}).find(w => w && w.title && w.title.toLowerCase().startsWith(book.label.toLowerCase() + ' show shift schedule'));
    const real = wb && (wb.sheets || []).find(s => String(s.name).trim() === String(book.tab));
    if (!real) die(`the Picking Feed's pull has no "${book.label} Show Shift Schedule · ${book.tab}" tab`);
    const start = ownedStart(real.values, book, book.from);
    if (start < 0) die(`${book.label} · ${book.tab}: no weekend banner on or after ${book.from}`);
    const rendered = renderWeekends(events, { from: book.from, to: book.to });
    const mirror = composeTab(real, rendered, start);
    const sourceName = `${wb.title} · ${real.name}`;
    const realP = parseSchedule(real, { sourceName, fontColors: real.fontColors });
    // a name no Start Date fill can match: none may apply to a mirrored weekend (stage 3 item 5)
    const mirrorP = parseSchedule(mirror, { sourceName: `mirror of ${book.label} ${book.tab}`, fontColors: mirror.fontColors });
    // last year's names the sync's first load left out (only a book that had a first load has the list); a list that
    // should be there and is not is said in the report, never passed over
    let stale = []; const staleFile = path.join(STATE, `sheet-stale-${book.key}.json`);
    if (book.firstLoad) { try { stale = JSON.parse(fs.readFileSync(staleFile, 'utf8')); } catch (e) { rendered.notes.push(`the sync's list of last year's names (${staleFile}) could not be read (${e.code || e.message}), so they are not told apart below`); } }
    const picking = comparePicking(realP.shifts, mirrorP.shifts, { from: book.from, to: book.to, explain: explainer(events, realP.events, start + 1, stale) });
    const roundTrip = compareBoard(events, rendered, { from: book.from, to: book.to, seasonYear: book.seasonYear ?? 2026, resolve });
    report.books.push({ book: book.key, label: book.label, tab: book.tab, from: book.from, to: book.to, startRow: start + 1, realRows: real.values.length - start,
      mirrorRows: rendered.rows.length, shows: rendered.shows.length, notes: rendered.notes, picking, roundTrip,
      warnings: { real: realP.warnings.map(w => w.type), mirror: mirrorP.warnings.map(w => w.type) } });
  }
  const dir = path.join(process.env.BOARD_OUT_DIR || path.join(REPO, 'out'), 'mirror'); fs.mkdirSync(dir, { recursive: true });
  const md = [`# Mirror compare, ${TODAY}`, '', `Board read ${report.at}; the Picking Feed's tabs as pulled ${report.feedPulledAt || '(unknown)'}.`, ''];
  for (const b of report.books) {
    const p = b.picking;
    md.push(`## ${b.label} · ${b.tab}, weekends ${b.from} to ${b.to} (the team's rows from row ${b.startRow}: ${b.realRows}; the mirror's: ${b.mirrorRows}, ${b.shows} shows)`, '',
      `Picking order: ${p.same} shift(s) read the same; ${p.onlyReal.length} only on the real Sheet; ${p.onlyMirror.length} only on the mirror; ${p.changed.length} read differently.`,
      `Round trip (board -> mirror -> this repo's parser): ${b.roundTrip.length ? b.roundTrip.length + ' difference(s)' : 'the same'}.`, '');
    const line = s => `- ${s.date} ${s.event}: ${s.rep}${s.fields ? ' (' + Object.entries(s.fields).map(([f, v]) => `${f} ${JSON.stringify(v.real)} -> ${JSON.stringify(v.mirror)}`).join(', ') + ')' : ''}`;
    const grouped = (title, list) => { if (!list.length) return; md.push(`### ${title}`);
      const by = new Map(); for (const s of list) { const k = s.why || '(no reason found)'; (by.get(k) || by.set(k, []).get(k)).push(s); }
      for (const [why, xs] of by) md.push(`**${why}** (${xs.length})`, ...xs.map(line), '');
    };
    md.push(`(${p.renamed} shift(s) paired under a show the two name differently, such as Maricopa's booth rows; counted as the same.)`, '');
    grouped('Only on the real Sheet', p.onlyReal); grouped('Only on the mirror', p.onlyMirror); grouped('Read differently', p.changed);
    if (b.roundTrip.length) md.push('### Round trip', ...b.roundTrip.map(x => `- ${x}`), '');
    if (b.notes.length) md.push('### What the Sheet cannot hold exactly', ...b.notes.map(x => `- ${x}`), '');
  }
  const stem = path.join(dir, `compare-${TODAY}`);
  fs.writeFileSync(stem + '.json', JSON.stringify(report, null, 1), { mode: 0o600 });
  fs.writeFileSync(stem + '.md', md.join('\n') + '\n', { mode: 0o600 });
  if (flag('--json')) console.log(JSON.stringify(report, null, 1));
  else console.log(report.books.map(b => `${b.label} · ${b.tab}: ${b.picking.same} same, ${b.picking.onlyReal.length} only real, ${b.picking.onlyMirror.length} only mirror, ${b.picking.changed.length} read differently; round trip ${b.roundTrip.length} difference(s)`).join('\n') + `\nreport: ${stem}.md`);
}

// ---------- the copies and the write ----------
const COPIES = () => path.join(STATE, 'mirror-copies.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writePrivate = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };
const books = () => config();
const a1 = (tab, r0, r1) => `'${String(tab).replace(/'/g, "''")}'!A${r0 + 1}:AA${r1}`;

async function setupCopies() {
  const copies = readJson(COPIES(), {});
  const api = sheetsApi({ read: books().map(b => b.fileId), write: Object.values(copies).map(c => c.id) });
  for (const b of books()) {
    if (copies[b.key]) { try { await api.meta(copies[b.key].id); console.log(`${b.label}: copy already there, ${copies[b.key].id}`); continue; } catch (e) { die(`${b.label}: the copy in ${COPIES()} (${copies[b.key].id}) cannot be read (${e.message}); look at it before making another`); } }
    const m = await api.meta(b.fileId);
    const tab = (m.sheets || []).map(x => x.properties).find(p => String(p.title).trim() === String(b.tab));
    if (!tab) die(`${b.label}: the book has no tab "${b.tab}"`);
    const made = await api.create(`Mirror copy · ${m.properties.title} · ${b.tab}`);
    const copied = await api.copyTo(b.fileId, tab.sheetId, made.spreadsheetId);
    const first = (made.sheets || [])[0] && made.sheets[0].properties.sheetId;
    await api.batchUpdate(made.spreadsheetId, [
      { updateSheetProperties: { properties: { sheetId: copied.sheetId, title: String(b.tab), index: 0 }, fields: 'title,index' } },
      ...(first !== undefined && first !== copied.sheetId ? [{ deleteSheet: { sheetId: first } }] : [])]);
    copies[b.key] = { id: made.spreadsheetId, title: made.properties.title, from: b.fileId, tab: String(b.tab), madeAt: new Date().toISOString() };
    writePrivate(COPIES(), copies);
    console.log(`${b.label}: made ${made.spreadsheetId} ("${made.properties.title}")`);
  }
}

function takeLock() {
  const f = path.join(STATE, 'sheet-mirror.lock'); fs.mkdirSync(STATE, { recursive: true });
  try { fs.writeFileSync(f, `${process.pid} ${new Date().toISOString()}`, { flag: 'wx', mode: 0o600 }); } catch (e) {
    const age = Date.now() - fs.statSync(f).mtimeMs; if (age < 10 * 60e3) die(`another mirror run holds ${f} (${Math.round(age / 1000)} s old)`, 4);
    fs.writeFileSync(f, `${process.pid} ${new Date().toISOString()}`, { mode: 0o600 });   // a run that died more than 10 minutes ago
  }
  const release = () => { try { fs.unlinkSync(f); } catch (e) { /* gone */ } };
  process.on('exit', release);   // a refusal exits through die(): the lock goes with it, never left for the next run to wait on
  return release;
}

async function write() {
  if (fs.existsSync(path.join(REPO, 'MIRROR-PAUSED'))) { console.log('MIRROR-PAUSED is present: nothing written'); return; }
  const copies = readJson(COPIES(), {});
  const list = books().filter(b => !opt('--book') || b.key === opt('--book'));
  for (const b of list) if (!copies[b.key]) die(`${b.label}: no copy yet (node scripts/sheet-mirror.mjs setup-copies)`);
  const release = takeLock();
  try {
    const board = boardApi({ actor: 'service:sheet-mirror' });
    const [events, settings] = await Promise.all([board.events(), board.settings()]);
    if (events.length < 50) die(`only ${events.length} shows came back from the board, so nothing was written`);
    const resolve = makeRepResolver([...(settings.roster || []), ...(settings.former || [])]);
    const api = sheetsApi({ read: list.map(b => copies[b.key].id), write: list.map(b => copies[b.key].id) });
    const results = [];
    for (const b of list) {
      const target = copies[b.key].id;
      const rendered = renderWeekends(events, { from: b.from, to: b.to });
      const self = compareBoard(events, rendered, { from: b.from, to: b.to, seasonYear: b.seasonYear ?? 2026, resolve });
      if (self.length) die(`${b.label}: the rendered rows do not read back as the board (${self.length}: ${self.slice(0, 3).join('; ')}); nothing written`, 2);
      const m = await api.meta(target);
      const tab = (m.sheets || []).map(x => x.properties).find(p => String(p.title).trim() === String(b.tab));
      if (!tab) die(`${b.label}: the copy has no tab "${b.tab}"`);
      const oldRows = (tab.gridProperties && tab.gridProperties.rowCount) || 0;
      const cur = await api.get(target, a1(b.tab, 0, oldRows));
      const curRows = (((cur.sheets || [])[0] || {}).data || [{}])[0].rowData || [];
      const values = curRows.map(r => (r.values || []).map((c, i) => cellBack(c, i).v));
      const start = ownedStart(values, b, b.from);
      if (start < 0) die(`${b.label}: no weekend banner on or after ${b.from} in the copy; nothing written`);
      // what changed in the copy since the last write (somebody typed there): listed, then written over
      const lastFile = path.join(STATE, `mirror-written-${b.key}.json`), last = readJson(lastFile, null);
      const typed = [];
      if (last && last.target === target && last.start === start) last.rows.forEach((row, i) => row.forEach((v, c) => {
        const now = (values[start + i] || [])[c] ?? ''; if (String(now) !== String(v ?? '')) typed.push(`${String.fromCharCode(65 + c)}${start + i + 1}: ${JSON.stringify(v ?? '')} -> ${JSON.stringify(now)}`);
      }));
      const sig = r => JSON.stringify(r);
      if (last && last.target === target && !flag('--force')) {
        const was = new Map((last.shows || []).map(s => [s.id, s.sig])); let n = 0;
        for (const s of rendered.shows) { const end = (rendered.shows[rendered.shows.indexOf(s) + 1] || { row: rendered.rows.length }).row; if (was.get(s.id) !== sig(rendered.rows.slice(s.row, end))) n++; }
        if (n > 40) die(`${b.label}: ${n} shows changed since the last write (over 40); read the board, then run it with --force`, 3);
      }
      const newRows = start + rendered.rows.length;
      const range = (r0, r1) => ({ sheetId: tab.sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 0, endColumnIndex: 27 });
      const grey = { red: 0.85, green: 0.85, blue: 0.85 };
      const requests = [
        { unmergeCells: { range: range(start, Math.max(oldRows, start + 1)) } },
        { updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { rowCount: Math.max(oldRows, newRows), columnCount: Math.max((tab.gridProperties && tab.gridProperties.columnCount) || 0, 27) } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } },
        { updateCells: { range: range(start, newRows), fields: 'userEnteredValue,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.numberFormat,userEnteredFormat.backgroundColor',
          rows: rendered.rows.map((row, i) => ({ values: row.map((v, c) => { const d = cellData(v, rendered.colors[i][c], c); if (rendered.kinds[i] === 'banner') d.userEnteredFormat.backgroundColor = grey; return d; }) })) } },
        ...(newRows < oldRows ? [{ updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { rowCount: newRows } }, fields: 'gridProperties.rowCount' } }] : []),
      ];
      await api.batchUpdate(target, requests);
      // read every cell and font color back: success is what Google now holds, never its answer to the write
      const back = await api.get(target, a1(b.tab, start, newRows));
      const backRows = (((back.sheets || [])[0] || {}).data || [{}])[0].rowData || [];
      const off = [];
      rendered.rows.forEach((row, i) => row.forEach((v, c) => {
        const got = cellBack(((backRows[i] || {}).values || [])[c], c), want = { v: v ?? '', color: rendered.colors[i][c] };
        if (String(got.v) !== String(want.v) || (want.v !== '' && got.color !== String(want.color || '#000000').toLowerCase())) off.push(`${String.fromCharCode(65 + c)}${start + i + 1}: wrote ${JSON.stringify(want)} read ${JSON.stringify(got)}`);
      }));
      if (off.length) die(`${b.label}: the copy did not read back as written (${off.length}: ${off.slice(0, 5).join('; ')})`, 2);
      writePrivate(lastFile, { target, start, at: new Date().toISOString(), rows: rendered.rows,
        shows: rendered.shows.map((s, k) => ({ id: s.id, sig: sig(rendered.rows.slice(s.row, (rendered.shows[k + 1] || { row: rendered.rows.length }).row)) })) });
      results.push({ book: b.key, target, startRow: start + 1, rows: rendered.rows.length, shows: rendered.shows.length, typed, notes: rendered.notes });
      console.log(`${b.label}: wrote ${rendered.rows.length} rows (${rendered.shows.length} shows) from row ${start + 1} of the copy, read back${typed.length ? `; ${typed.length} cell(s) had been changed in the copy since the last write, written over: ${typed.slice(0, 5).join('; ')}` : ''}`);
    }
    const dir = path.join(process.env.BOARD_OUT_DIR || path.join(REPO, 'out'), 'mirror'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `write-${TODAY}.json`), JSON.stringify({ at: new Date().toISOString(), results }, null, 1), { mode: 0o600 });
  } finally { release(); }
}

function status() {
  const copies = readJson(COPIES(), {});
  console.log(`Google key: ${fs.existsSync(TOKEN_FILE) ? TOKEN_FILE : 'none yet (Alan: node scripts/authorize-sheets.mjs)'}`);
  console.log(`Paused: ${fs.existsSync(path.join(REPO, 'MIRROR-PAUSED')) ? 'yes (MIRROR-PAUSED)' : 'no'}`);
  for (const b of books()) {
    const c = copies[b.key], w = readJson(path.join(STATE, `mirror-written-${b.key}.json`), null);
    console.log(`${b.label} · ${b.tab}, weekends ${b.from} to ${b.to}: ${c ? `copy ${c.id}` : 'no copy yet'}${w ? `, last written ${w.at} (${w.rows.length} rows from row ${w.start + 1})` : ''}`);
  }
}

if (cmd === 'compare') compare().catch(e => die(e.stack || e.message));
else if (cmd === 'setup-copies') setupCopies().catch(e => die(e.message));
else if (cmd === 'write') write().catch(e => die(e.message));
else if (cmd === 'status') status();
else { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\s*/, '')); process.exit(cmd ? 1 : 0); }
