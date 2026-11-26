#!/usr/bin/env node
/*
  Look it up (Alan, 2026-11-25): scripts/lib/show-lookup.mjs (what fills the form, the shows already on the board, one
  listener run's work, the call to rsd-shift-picking), the page's show-lookup block, board-api's lookups, and the SQL.
  All in-process: fakes for the board and for lookup-show.js, no server, no network, no Claude.
  run-all.mjs runs it as one section; by itself: node tests/show-lookup.mjs
*/
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function showLookupTests({ ok, REPO = path.resolve(HERE, '..') }) {
  const L = await import(pathToFileURL(path.join(REPO, 'scripts/lib/show-lookup.mjs')).href);
  const PAGE = 'https://www.testnationals.example/event', LIST = 'https://www.eventlist.example/az/test-nationals';
  const findings = (o = {}) => ({
    event: { name: 'Test Arizona Nationals', cityState: 'Chandler, AZ', confidence: 'official', sourceUrl: PAGE },
    guess: { start: '2027-02-26', end: '2027-02-28' },
    dates: { found: true, start: '2027-02-26', end: '2027-02-28', confidence: 'official', sourceUrl: PAGE, evidence: 'return February 26-28, 2027', cancelled: false, notYetAnnounced: false, note: '' },
    venue: { value: 'Test Motorsports Park', confidence: 'official', sourceUrl: PAGE },
    address: { street: '20000 S Test Rd', city: 'Chandler', state: 'AZ', zip: '85226', confidence: 'official', sourceUrl: PAGE },
    promoter: { name: 'Test Racing Assn', contactName: 'Pat Vendor', phone: '(480) 555-0100', email: 'vendors@example.com', website: 'https://www.testnationals.example', confidence: 'official', sourceUrl: PAGE },
    indoorOutdoor: { value: 'outdoor', evidence: 'outdoor vendor midway', sourceUrl: PAGE },
    boothCost: { amount: '450', note: '10x10', sourceUrl: PAGE },
    application: { url: 'https://www.testnationals.example/vendors', opens: '', opensQuote: '', deadline: '2027-01-15', deadlineQuote: 'applications due January 15, 2027', confidence: 'official', sourceUrl: PAGE },
    summary: 'The drag racing event in Chandler.', ...o });
  const today = '2026-11-25', ask = 'NHRA 2027, last week of February';

  // ---------- formOf: what fills the form ----------
  let f = L.formOf(findings(), { year: 2027, today, ask });
  ok(f.fields.name === 'Test Arizona Nationals' && f.fields.startDate === '2027-02-26' && f.fields.endDate === '2027-02-28' && f.dates.how === 'official',
    'formOf: the show\'s own page gives the name and the dates ("checked" on the board)');
  ok(f.fields.location === 'Test Motorsports Park' && f.fields.address === '20000 S Test Rd, Chandler, AZ 85226' && f.fields.cityState === 'Chandler, AZ' && f.fields.setting === 'outdoor' && f.fields.cost === '$450',
    'formOf: venue, address, city, indoor/outdoor and cost from its own page (the preflight\'s rules)');
  ok(f.fields.promoter === 'Test Racing Assn' && f.fields.contact === 'Pat Vendor' && f.fields.phone && f.fields.email && f.fields.website && f.fields.applyUrl === 'https://www.testnationals.example/vendors',
    'formOf: the promoter, their contact and the application link from their own page');
  ok(f.fields.applyBy === '2027-01-15' && f.sources.applyBy && f.sources.applyBy.kind === 'research' && f.sources.applyBy.url === PAGE && !f.fields.applyOpens,
    'formOf: the application deadline with its research tag (lib/app-dates.mjs); no opening date when the page gives none');
  ok(f.from.length === 1 && f.from[0].url === PAGE && ['name', 'dates', 'location', 'applyBy'].every(x => f.from[0].fields.includes(x)), 'formOf: which page gave which fields, for the lines under the form');
  ok(f.notes === `Looked up from the board ${today} ("${ask}"): ${PAGE}`, 'formOf: the Team notes line names the day, the words and the pages it used: ' + f.notes);
  ok(f.leftOut.length === 0 && f.summary === 'The drag racing event in Chandler.', 'formOf: nothing left out when every page is the show\'s own');

  const listing = { found: true, start: '2027-02-25', end: '2027-02-28', confidence: 'secondary', sourceUrl: LIST, evidence: 'Feb 25-28, 2027', cancelled: false, notYetAnnounced: false, note: '' };
  f = L.formOf(findings({ dates: listing, venue: { value: 'Test Raceway', confidence: 'secondary', sourceUrl: LIST } }), { year: 2027, today, ask });
  ok(f.dates.how === 'guess' && f.fields.startDate === '2027-02-26' && f.dates.listing.start === '2027-02-25' && f.dates.listing.url === LIST,
    'formOf: dates only on a listing are named, never used; the days the words name go in (est. on the board), the 2026-11-13 rule');
  ok(!f.fields.location && f.leftOut.some(x => x.field === 'location' && x.value === 'Test Raceway' && x.url === LIST), 'formOf: a venue only on a listing is named under the form, not put in it');
  f = L.formOf(findings({ dates: listing, guess: { start: '', end: '' } }), { year: 2027, today, ask: 'NHRA' });
  ok(f.dates.how === 'none' && !f.fields.startDate && f.dates.listing && !f.fields.applyBy, 'formOf: no page and no time in the words: no dates, and no application dates to check against');
  f = L.formOf(findings({ dates: { ...findings().dates, found: false, confidence: 'none', notConfirmed: 'the words it quotes are not on the page it cites (testnationals.example)' } }), { year: 2027, today, ask });
  ok(f.dates.how === 'guess' && /not on the page it cites/.test(f.dates.setAside), 'formOf: dates the evidence check set aside are said, and the words\' days go in');
  f = L.formOf(findings({ dates: { ...findings().dates, start: '2026-02-27', end: '2026-03-01' } }), { year: 2027, today, ask });
  ok(f.dates.how === 'guess' && f.dates.otherYear.start === '2026-02-27', 'formOf: the show\'s page giving another year\'s dates is not this edition');
  f = L.formOf(findings({ dates: { ...findings().dates, start: '2027-02-01', end: '2027-02-28' } }), { year: 2027, today, ask });
  ok(f.dates.how === 'guess' && f.dates.otherYear, 'formOf: a run over a week is not put in the form (Add event takes at most 7 days)');
  f = L.formOf(findings({ promoter: { name: 'Test Racing Assn', contactName: 'Pat Vendor', phone: '(480) 555-0100', email: 'listing@example.com', website: '', confidence: 'secondary', sourceUrl: LIST } }), { year: 2027, today, ask });
  ok(!f.fields.contact && !f.fields.phone && !f.fields.email && !f.fields.promoter && f.leftOut.some(x => x.field === 'promoter') && !f.leftOut.some(x => /phone|email|contact/.test(x.field)),
    'formOf: a promoter only on a listing is named; their phone and email from a listing are not passed on at all');
  f = L.formOf({ event: { name: '', cityState: '', confidence: 'none', sourceUrl: '' }, guess: { start: '', end: '' }, dates: { found: false, start: '', end: '', confidence: 'none', sourceUrl: '', evidence: '', cancelled: false, notYetAnnounced: false, note: '' }, summary: 'Nothing fits "zzz".' }, { year: 2027, today, ask: 'zzz show' });
  ok(!f.fields.name && f.dates.how === 'none' && /no page found/.test(f.notes), 'formOf: nothing identified: an empty form and a note that says so');
  f = L.formOf(findings({ dates: { ...findings().dates, cancelled: true, evidence: 'The 2027 event is cancelled' } }), { year: 2027, today, ask });
  ok(f.dates.cancelled === 'The 2027 event is cancelled', 'formOf: a page saying this edition is cancelled is said');

  // ---------- onBoard: a show the board already has ----------
  const events = [
    { id: '2027-nhra-nationals-seaacn', name: 'NHRA Nationals', year: 2027, weekend: '2027-03-19', startDate: '2026-03-20', endDate: '2026-03-22', cityState: 'Chandler, AZ' },
    { id: '2026-nhra-nationals', name: 'NHRA Nationals', year: 2026, weekend: '2026-03-20' },
    { id: '2027-goodguys-southwest-nationals', name: 'Goodguys Southwest Nationals', year: 2027, weekend: '2027-11-12' },
    { id: '2027-chandler-home-show', name: 'Chandler Home Show', year: 2027, weekend: '2027-02-26' },
  ];
  let ob = L.onBoard(events, { name: 'NHRA Arizona Nationals', ask, year: 2027 });
  ok(ob.length === 1 && ob[0].id === '2027-nhra-nationals-seaacn' && ob[0].weekend === '2027-03-19', 'onBoard: Alan\'s own example: NHRA Nationals is already on 2027 (not 2026\'s, not Goodguys): ' + JSON.stringify(ob.map(x => x.id)));
  ob = L.onBoard(events, { name: '', ask: 'add NHRA to the 2027 board, last week of February', year: 2027 });
  ok(ob.length === 1 && ob[0].id === '2027-nhra-nationals-seaacn', 'onBoard: with no name found, a distinctive word typed still finds it');
  ok(L.onBoard(events, { name: 'Prescott Rodeo Days', ask: 'prescott rodeo 2027', year: 2027 }).length === 0, 'onBoard: a show the board does not have: none');
  ok(L.onBoard(events, { name: '', ask: 'home show 2027', year: 2027 }).length === 0, 'onBoard: common words ("home", "show") alone match nothing');

  // ---------- runLookups: one listener run ----------
  const fakeApi = (rows, evs = events) => {
    const moves = [];
    return { moves, rows,
      events: async () => evs,
      lookups: {
        open: async () => rows.filter(r => r.status === 'pending' || r.status === 'running').map(r => ({ ...r })),
        move: async (ids, from, patch) => { const hit = rows.filter(r => ids.includes(r.id) && r.status === from); hit.forEach(r => Object.assign(r, patch)); moves.push({ ids, from, patch }); return hit.map(r => ({ ...r })); },
      } };
  };
  const NOW = Date.parse('2026-11-25T20:00:00Z');
  const said = [];
  const log = m => said.push(m);
  let api = fakeApi([]), asked = [];
  let r = await L.runLookups({ api, lookup: async x => { asked.push(x); return {}; }, log, now: NOW });
  ok(r.did === 'idle' && api.moves.length === 0 && asked.length === 0 && said.length === 0, 'runLookups: nothing waiting: nothing moved, nothing said');
  r = await L.runLookups({ api, lookup: async () => ({}), log, cfg: { on: false }, now: NOW });
  ok(r.did === 'off', 'runLookups: config lookup.on false does nothing');

  const pend = (id, o = {}) => ({ id, requested_at: '2026-11-25T19:59:00Z', requested_by: 'alan@example.com', ask, year: 2027, status: 'pending', started_at: null, finished_at: null, result: null, ...o });
  api = fakeApi([pend(7), pend(8, { ask: 'Prescott rodeo 2027' })]); asked = [];
  r = await L.runLookups({ api, lookup: async x => { asked.push(x); return { ok: true, result: findings(), cost: 0.734, model: 'claude-opus-5' }; }, log, now: NOW });
  const row7 = api.rows.find(x => x.id === 7);
  ok(r.did === 'done' && asked.length === 1 && asked[0].ask === ask && asked[0].year === 2027 && api.rows.find(x => x.id === 8).status === 'pending',
    'runLookups: the oldest press only, one per run (the next run takes the next)');
  ok(api.moves[0].from === 'pending' && api.moves[0].patch.status === 'running' && row7.status === 'done' && row7.finished_at, 'runLookups: claimed first (pending -> running), then done');
  ok(row7.result.fields.name === 'Test Arizona Nationals' && row7.result.onBoard.length === 1 && row7.result.onBoard[0].id === '2027-nhra-nationals-seaacn' && row7.result.cost === 0.73,
    'runLookups: the row carries the form, the show already on the board and the cost');
  const line = said[said.length - 1];
  ok(/lookup 7 \(alan@example\.com\): "NHRA 2027, last week of February" \(2027\): Test Arizona Nationals; dates official/.test(line) && !/555|vendors@example|Pat Vendor|Test Rd/.test(line),
    'runLookups: one log line, with no phone, e-mail, contact or address in it: ' + line);

  api = fakeApi([pend(9)]);
  await L.runLookups({ api, lookup: async () => ({ ok: false, refused: 'this week\'s $10.00 for show lookups is spent ($9.60 in the last 7 days). It frees up as those days pass' }), log, now: NOW });
  ok(api.rows[0].status === 'refused' && /\$10\.00 for show lookups is spent/.test(api.rows[0].result.error), 'runLookups: the week\'s money spent: refused, and the page says why');
  api = fakeApi([pend(10)]);
  await L.runLookups({ api, lookup: async () => ({ ok: false, error: 'the lookup took longer than 300 s and was stopped', cost: 0.4 }), log, now: NOW });
  ok(api.rows[0].status === 'failed' && /did not finish: the lookup took longer than 300 s/.test(api.rows[0].result.error), 'runLookups: a failed lookup says why');
  api = fakeApi([pend(11)]);
  await L.runLookups({ api, lookup: async () => { throw new Error('spawn node ENOENT'); }, log, now: NOW });
  ok(api.rows[0].status === 'failed' && /could not run on the Mac mini: spawn node ENOENT/.test(api.rows[0].result.error), 'runLookups: a lookup that cannot run at all says so on the row');
  api = fakeApi([pend(12, { status: 'running', started_at: '2026-11-25T19:58:00Z' }), pend(13)]); asked = [];
  r = await L.runLookups({ api, lookup: async x => { asked.push(x); return {}; }, log, now: NOW });
  ok(r.did === 'busy' && asked.length === 0 && api.moves.length === 0, 'runLookups: one already running: the next waits');
  api = fakeApi([pend(14, { status: 'running', started_at: '2026-11-25T19:30:00Z' }), pend(15)]); asked = [];
  r = await L.runLookups({ api, lookup: async x => { asked.push(x); return { ok: true, result: findings(), cost: 0.5 }; }, log, now: NOW });
  ok(api.rows[0].status === 'failed' && /stopped partway/.test(api.rows[0].result.error) && asked.length === 1 && api.rows[1].status === 'done',
    'runLookups: a row left running over 15 minutes is marked failed (never run again by itself: it costs money), and the next press runs');

  // ---------- pickingLookup: the call to rsd-shift-picking ----------
  const pick = fs.mkdtempSync(path.join(os.tmpdir(), 'board-lookup-pick-'));
  fs.writeFileSync(path.join(pick, 'lookup-show.js'), `const fs = require('fs'); const a = process.argv.slice(2); const o = a[a.indexOf('--out') + 1];
    if (a[a.indexOf('--ask') + 1] === 'crash') { console.error('lookup-show FAILED: boom'); process.exit(1); }
    fs.writeFileSync(o, JSON.stringify({ ok: true, args: a, boardEnv: Object.keys(process.env).filter(k => k.startsWith('BOARD_')), result: { dates: {} }, cost: 0.1 }));`);
  const keepEnv = { url: process.env.BOARD_SUPABASE_URL, key: process.env.BOARD_SERVICE_KEY, dir: process.env.RSD_PICKING_DIR };
  process.env.BOARD_SERVICE_KEY = 'test-service-key'; process.env.RSD_PICKING_DIR = pick;
  try {
    const run = L.pickingLookup({});
    let o = await run({ ask: 'NHRA 2027, "last" week', year: 2027 });
    ok(o.ok && o.args.join('|') === '--ask|NHRA 2027, "last" week|--year|2027|--out|' + o.args[5] && o.boardEnv.length === 0,
      'pickingLookup: lookup-show.js gets the words as one argument, the year and a file, and never the board\'s service key');
    o = await run({ ask: 'crash', year: 2027 });
    ok(/lookup-show FAILED: boom/.test(o.failed), 'pickingLookup: a lookup that dies without a file is a failure with its last words');
    process.env.RSD_PICKING_DIR = path.join(pick, 'nope');
    o = await L.pickingLookup({})({ ask: 'x y z', year: 2027 });
    ok(/is not there/.test(o.failed), 'pickingLookup: no rsd-shift-picking checkout: said, not a crash');
  } finally {
    for (const [k, v] of [['BOARD_SUPABASE_URL', keepEnv.url], ['BOARD_SERVICE_KEY', keepEnv.key], ['RSD_PICKING_DIR', keepEnv.dir]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(pick, { recursive: true, force: true });
  }

  // ---------- board-api lookups: the REST calls ----------
  {
    const { boardApi } = await import(pathToFileURL(path.join(REPO, 'scripts/lib/board-api.mjs')).href);
    const keep = { url: process.env.BOARD_SUPABASE_URL, key: process.env.BOARD_SERVICE_KEY, home: process.env.HOME, fetch: globalThis.fetch };
    const calls = [], home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-lookup-home-'));
    // HOME at a temp dir: the machine's own ~/.rsd/board.env is never read by a test
    process.env.HOME = home; process.env.BOARD_SUPABASE_URL = 'https://board.example'; process.env.BOARD_SERVICE_KEY = 'test';
    globalThis.fetch = async (url, o) => { calls.push({ url, method: o.method, body: o.body, prefer: o.headers.Prefer }); return { ok: true, text: async () => '[]' }; };
    try {
      const api = boardApi({ actor: 'service:show-lookup' });
      await api.lookups.open(); await api.lookups.move([3, 4], 'running', { status: 'done' });
      ok(/\/rest\/v1\/show_lookups\?select=id,requested_by,requested_at,ask,year,status,started_at&status=in\.\(pending,running\)&order=id$/.test(calls[0].url) && calls[0].method === 'GET',
        'board-api lookups.open: the waiting and running presses, oldest first');
      ok(/\/rest\/v1\/show_lookups\?id=in\.\(3,4\)&status=eq\.running$/.test(calls[1].url) && calls[1].method === 'PATCH' && calls[1].prefer === 'return=representation',
        'board-api lookups.move: only rows still in the state it expects, and it answers with what it changed');
    } finally {
      globalThis.fetch = keep.fetch;
      for (const [k, v] of [['BOARD_SUPABASE_URL', keep.url], ['BOARD_SERVICE_KEY', keep.key], ['HOME', keep.home]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // ---------- the page: index.html's show-lookup block, run by itself ----------
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const m = html.match(/\/\* show-lookup:start[\s\S]*?\*\/([\s\S]*?)\/\* show-lookup:end \*\//);
  ok(!!m, 'index.html: the show-lookup block is marked');
  const fromISO = s => { if (!s) return null; const [y, mo, d] = s.split('-').map(Number); return new Date(y, mo - 1, d); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = new Function('fromISO', 'esc', m[1] + '\nreturn { LOOK_FIELDS, lookYear, lookFill, lookBlanks, lookExtras, lookLines };')(fromISO, esc);
  ok(P.lookYear('NHRA 2027, last week of February', 2026) === 2027 && P.lookYear('the Prescott rodeo', 2026) === 2026, 'page: the year typed wins; else the season tab open');
  const res = { ...L.formOf(findings(), { year: 2027, today, ask }), onBoard: L.onBoard(events, { name: 'NHRA Arizona Nationals', ask, year: 2027 }) };
  const fill = Object.fromEntries(P.lookFill(res));
  ok(fill.qaName === 'Test Arizona Nationals' && fill.qaStart === '2027-02-26' && fill.qaSetting === 'outdoor' && fill.qaApplyBy === '2027-01-15' && fill.qaPhone,
    'page: every field the lookup gave goes to its Add event input');
  ok(Object.values(P.LOOK_FIELDS).every(id => html.includes(`id="${id}"`)) && html.includes('id="qaAsk"') && html.includes('id="qaAskGo"') && html.includes('id="qaFound"'),
    'page: every input the lookup fills is in Add event, with the Look it up line');
  const show = { id: '2027-nhra-nationals-seaacn', name: 'NHRA Nationals', location: 'Wild Horse Pass', cityState: '', startDate: '2026-03-20', phone: '' };
  let b = P.lookBlanks(show, res, false);
  ok(!('name' in b) && !('startDate' in b) && !('endDate' in b) && !('location' in b) && b.cityState === 'Chandler, AZ' && b.phone && b.applyBy === '2027-01-15' && b.applyBySource.kind === 'research',
    'page: Fill its blank fields fills only blanks, never the name or the dates; the deadline keeps its research tag');
  b = P.lookBlanks(show, res, true);
  ok(!('phone' in b) && !('contact' in b) && !('email' in b), 'page: when the promoter contacts could not be read, none is filled (a blank one may not be blank)');
  const doc = { startDate: '2027-02-26', endDate: '2027-02-28', applyBy: '2027-01-15', applyBySource: { kind: 'manual' } };
  let x = P.lookExtras(doc, res, today);
  ok(x.datesSource.basis === 'researched' && x.datesSource.url === PAGE && /Dates per testnationals\.example/.test(x.datesNote) && x.datesEstimated === false && x.applyBySource.kind === 'research',
    'page: a show added with the lookup\'s own-page dates shows "checked"; its deadline keeps the research tag');
  x = P.lookExtras({ ...doc, startDate: '2027-03-05', endDate: '2027-03-07', applyBy: '2027-01-20' }, res, today);
  ok(!x.datesNote && !x.datesEstimated && !x.applyBySource, 'page: dates or a deadline typed over are the person\'s: no tag from the lookup');
  const guessRes = L.formOf(findings({ dates: listing }), { year: 2027, today, ask });
  ok(P.lookExtras({ startDate: '2027-02-26', endDate: '2027-02-28' }, guessRes, today).datesEstimated === true && P.lookExtras({ startDate: '2027-02-25', endDate: '2027-02-28' }, guessRes, today).datesEstimated === true,
    'page: the words\' days, or a listing\'s, go on the board marked est.');
  let lines = P.lookLines(res).join('\n');
  ok(/Found Test Arizona Nationals/.test(lines) && /from the show's own page \(testnationals\.example\)/.test(lines) && /data-look-fill="2027-nhra-nationals-seaacn"/.test(lines) && /Its own page says/.test(lines),
    'page: the lines say what was found and from where, and offer the show already on the board, with its date difference');
  lines = P.lookLines(L.formOf(findings({ dates: listing, event: { name: 'Evil <img src=x onerror=alert(1)>', cityState: '', confidence: 'official', sourceUrl: PAGE } }), { year: 2027, today, ask })).join('\n');
  ok(!/<img/.test(lines) && /&lt;img/.test(lines) && /data-look-dates/.test(lines) && /marked est\./.test(lines), 'page: whatever a web page said is escaped; a listing\'s dates come with a button, marked est.');
  ok(/Object\.assign\(doc,lookExtras\(doc,lookDone,iso\(TODAY\)\)\);/.test(html) && /toast\('Added '\+name\+' to '\+Y\); lookReset\(\);/.test(html), 'page: Add event saves the lookup\'s tags and then clears it');
  ok(/function syncInit\(\)\{\n  lookupInit\(\);/.test(html), 'page: Look it up starts with the same sign-in as the Sync button (editors only)');

  // ---------- the database and the listener ----------
  const sql = fs.readFileSync(path.join(REPO, 'supabase/show-lookups.sql'), 'utf8'), schema = fs.readFileSync(path.join(REPO, 'supabase/schema.sql'), 'utf8');
  const core = s => (s.match(/create table if not exists show_lookups[\s\S]*?< 3\);/) || [''])[0];
  ok(core(sql) && core(sql) === core(schema), 'SQL: supabase/show-lookups.sql (Alan\'s one paste) is the same table and policies as schema.sql');
  ok(/for insert with check \(\s*is_editor\(\) and status = 'pending'/.test(core(sql)) && !/for update|for delete/.test(core(sql)) && /< 3\);$/.test(core(sql)),
    'SQL: editors ask (pending only, at most 3 open each); nobody but the service key moves a row on');
  ok(/add table show_lookups/.test(sql) && /add table show_lookups/.test(schema), 'SQL: realtime carries the row back to the page');
  const sr = fs.readFileSync(path.join(REPO, 'scripts/sync-requests.mjs'), 'utf8');
  ok(/if \(!msg\) await lookups\(\);/.test(sr) && /actor: 'service:show-lookup'/.test(sr), 'listener: a Look it up press runs only once the board answered, as service:show-lookup');
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config/event-check.json'), 'utf8')).lookup;
  ok(cfg && cfg.on === true && cfg.timeoutMinutes === 7 && cfg.staleMinutes === 15 && cfg.maxDays === 7, 'config: lookup on, 7 minutes to finish, 15 before a running row is called stopped');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pass = 0, fail = 0;
  await showLookupTests({ ok: (c, name) => { if (c) pass++; else { fail++; console.error('  FAIL  ' + name); } } });
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
