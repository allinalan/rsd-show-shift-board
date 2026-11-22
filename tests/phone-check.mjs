#!/usr/bin/env node
/*
  Phone check: does the board still work on a phone? It opens index.html in a real browser at two iPhone sizes
  (375 x 667, the SE; 390 x 844) and at 1000px, goes through every view (Cards, Grid, each season, Kiosk Schedule,
  Never), and fails loudly when something a rep would hit on a phone breaks:

    - the page scrolls sideways (something pushed the layout wider than the screen)
    - something runs off the edge of the screen with no way to scroll to it (cut off)
    - a button, tab, link or field is too small to tap on a phone (under 32px tall or 24px wide)
    - text smaller than 11px on a phone
    - the Kiosk Schedule shows the wrong layout (a phone gets one mall at a time, a wide screen the table)
    - the Filters panel doesn't fit the screen, or opening a show card pushes the page sideways
    - any JavaScript error on the page

  It never touches the real board. config.js is replaced by a blank one, so the page runs its read-only preview from
  seed/*.json (the same thing it shows when config.js is blank); every request off this machine is blocked except the
  Google Fonts files (so text is measured in the real fonts), and a request anywhere else is itself a failure. The
  service worker is off.

      node tests/phone-check.mjs              headless Chromium
      node tests/phone-check.mjs --shots      also saves a screenshot of every view and size to out/phone-check/
      node tests/phone-check.mjs --headed     in a window you can watch

  Exit 0: every check passed · 1: a check failed · 2: it couldn't run (no Playwright, no browser, the page didn't load).

  Playwright isn't a dependency of this repo. It's looked for in this order: $PLAYWRIGHT (the package folder) ·
  a normal import of "playwright" · ~/.local/share/playwright/node_modules/playwright (the mini).
  Not part of tests/run-all.mjs (that suite needs no browser, and install.sh --check reads it).
*/
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const SHOTS = args.has('--shots'), HEADED = args.has('--headed');
const SHOT_DIR = path.join(REPO, 'out', 'phone-check');
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const KNOWN_OFF = new Set(['cdn.jsdelivr.net']);          // the Supabase library: not needed by the blank-config preview
const SIZES = [
  { name: 'iPhone SE', w: 375, h: 667, phone: true },
  { name: 'iPhone 390', w: 390, h: 844, phone: true },
  { name: 'desktop 1000', w: 1000, h: 800, phone: false },
];
const MIN_TAP_H = 32, MIN_TAP_W = 24, MIN_TEXT_PX = 11;

const cantRun = msg => { console.log(`CAN'T RUN: ${msg}`); process.exit(2); };

function findPlaywright() {
  const req = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT, 'playwright', path.join(os.homedir(), '.local/share/playwright/node_modules/playwright')].filter(Boolean);
  for (const t of tries) { try { return req(t); } catch {} }
  cantRun(`Playwright not found (tried ${tries.join(', ')}). Set PLAYWRIGHT to the package folder.`);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((q, r) => {
      let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
      if (p === '/config.js') { r.writeHead(200, { 'Content-Type': 'text/javascript' }); return r.end('window.BOARD_CONFIG={supabaseUrl:"",supabaseAnonKey:""};'); }
      if (p.startsWith('/seed/private')) { r.writeHead(404); return r.end(); }          // never serve the promoter contacts
      const f = path.join(REPO, p);
      if (!f.startsWith(REPO + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
      r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---- what is measured inside the page ----
// Everything visible that ends past either edge of the screen, unless something around it scrolls sideways (a row of
// tabs or name chips that you swipe), or it's a sheet/popover parked off screen on purpose (fixed, or hidden).
function measure({ phone, MIN_TAP_H, MIN_TAP_W, MIN_TEXT_PX }) {
  const W = innerWidth;
  const shown = e => { if (!e.getClientRects().length) return false; for (let a = e; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0 || a.hidden || a.getAttribute('aria-hidden') === 'true') return false; } return true; };
  const scrollsX = e => { for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll)/.test(s.overflowX)) return true; if (s.position === 'fixed') return 'fixed'; } return false; };
  const name = e => (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) || ('<' + e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/)[0] : '') + '>');
  const out = { pageW: document.scrollingElement.scrollWidth, W, cut: [], tiny: [], small: [] };
  for (const e of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'svg', 'path', 'BR'].includes(e.tagName) || !shown(e)) continue;
    const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    if ((r.right > W + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed') {
      const sx = scrollsX(e); if (!sx) out.cut.push(`${name(e)} (${Math.round(r.left)}..${Math.round(r.right)}px)`);
    }
    if (!phone) continue;
    if (e.matches('button:not([disabled]),[role=tab],[role=button],a[href],input:not([type=hidden]),select,textarea') && r.top < innerHeight * 4) {
      // a field inside a <label> is tapped anywhere on the label (the search box: a 24px input in a 40px pill)
      const lab = e.matches('input,select,textarea') && e.closest('label'), t = lab ? lab.getBoundingClientRect() : r;
      if (t.height < MIN_TAP_H || t.width < MIN_TAP_W) out.small.push(`${name(e)} ${Math.round(t.width)}x${Math.round(t.height)}`);
    }
    const own = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (own) { const fs = parseFloat(getComputedStyle(e).fontSize); if (fs < MIN_TEXT_PX) out.tiny.push(`"${e.textContent.trim().slice(0, 30)}" ${fs}px`); }
  }
  const vis = sel => { const e = document.querySelector(sel); return !!(e && shown(e)); };
  out.kiosk = { grid: vis('.kiosk .kgrid'), byMall: vis('.kmv-top') };
  for (const k of ['cut', 'tiny', 'small']) out[k] = [...new Set(out[k])];
  return out;
}

const fails = []; let passes = 0;
const check = (ok, label, detail = []) => {
  if (ok) { passes++; console.log(`ok    ${label}`); return; }
  fails.push(label); console.log(`FAIL  ${label}`); for (const d of detail.slice(0, 8)) console.log(`        ${d}`);
  if (detail.length > 8) console.log(`        … and ${detail.length - 8} more`);
};

const { chromium } = findPlaywright();
const srv = await serve();
const BASE = `http://127.0.0.1:${srv.address().port}/`;
let browser;
try { browser = await chromium.launch({ headless: !HEADED }); } catch (e) { srv.close(); cantRun(`no browser: ${e.message.split('\n')[0]}`); }
if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

try {
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, serviceWorkers: 'block',
      isMobile: size.phone, hasTouch: size.phone, deviceScaleFactor: SHOTS ? 2 : 1 });
    const page = await ctx.newPage();
    const errors = [], strays = [];
    page.on('pageerror', e => errors.push(e.message.split('\n')[0]));
    await page.route('**/*', rt => {
      const u = new URL(rt.request().url());
      if (rt.request().url().startsWith(BASE)) return rt.continue();
      if (FONT_HOSTS.has(u.host) && rt.request().method() === 'GET') return rt.continue();
      if (!KNOWN_OFF.has(u.host)) strays.push(`${rt.request().method()} ${u.host}${u.pathname}`);
      return rt.abort();
    });
    try { await page.goto(BASE, { waitUntil: 'load', timeout: 20000 }); await page.waitForSelector('[role=tab][data-year]', { timeout: 15000 }); }
    catch (e) { cantRun(`the page didn't load at ${size.w}px: ${e.message.split('\n')[0]}`); }
    await page.waitForTimeout(800);
    const preview = await page.evaluate(() => /read-only preview/i.test(document.body.innerText));
    check(preview, `${size.name}: the page is running the read-only preview (not a live board)`);
    if (!preview) cantRun('the page is not in preview mode, so this check could be looking at live data; stopped.');

    const years = await page.$$eval('[role=tab][data-year]', es => es.map(e => e.dataset.year).filter(y => /^\d{4}$/.test(y)));
    const views = [
      { label: 'Cards', go: async () => { await page.click(`[role=tab][data-year="${years[0]}"]`); await page.click('[role=tab][data-view=cards]'); } },
      { label: 'Grid', go: async () => { await page.click(`[role=tab][data-year="${years[0]}"]`); await page.click('[role=tab][data-view=grid]'); } },
      ...years.slice(1).map(y => ({ label: `season ${y}`, go: async () => { await page.click('[role=tab][data-view=cards]').catch(() => {}); await page.click(`[role=tab][data-year="${y}"]`); } })),
      { label: 'Kiosk Schedule', kiosk: true, go: () => page.click('[role=tab][data-year=kiosk]') },
      { label: 'Never', go: () => page.click('[role=tab][data-year=never]') },
    ];
    for (const v of views) {
      await v.go(); await page.waitForTimeout(350);
      const m = await page.evaluate(measure, { phone: size.phone, MIN_TAP_H, MIN_TAP_W, MIN_TEXT_PX });
      const at = `${size.name} · ${v.label}`;
      check(m.pageW <= m.W + 1, `${at}: no sideways scroll`, [`page is ${m.pageW}px wide on a ${m.W}px screen`]);
      check(!m.cut.length, `${at}: nothing cut off at the edge`, m.cut);
      if (size.phone) {
        check(!m.small.length, `${at}: everything tappable is at least ${MIN_TAP_W}x${MIN_TAP_H}px`, m.small);
        check(!m.tiny.length, `${at}: no text under ${MIN_TEXT_PX}px`, m.tiny);
      }
      if (v.kiosk) check(size.phone ? (m.kiosk.byMall && !m.kiosk.grid) : (m.kiosk.grid && !m.kiosk.byMall),
        `${at}: ${size.phone ? 'one mall at a time, not the table' : 'the table, not one mall at a time'}`, [JSON.stringify(m.kiosk)]);
      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, `${size.w}-${v.label.replace(/\W+/g, '-').toLowerCase()}.png`) });
    }

    // Filters panel and an opened show card, on the first season's cards
    await page.click(`[role=tab][data-year="${years[0]}"]`); await page.click('[role=tab][data-view=cards]'); await page.waitForTimeout(250);
    // Filters: a phone folds them behind the Filters button (#ctlToggle opens #ctlMore); a wide screen shows them inline
    const fbtn = page.locator('#ctlToggle');
    if (size.phone) {
      if (await fbtn.isVisible()) {
        await fbtn.click(); await page.waitForTimeout(350);
        const fit = await page.evaluate(() => {
          const p = document.getElementById('ctlMore'), r = p && p.getBoundingClientRect();
          return { open: !!(r && r.height > 0), left: r && Math.round(r.left), right: r && Math.round(r.right), pageW: document.scrollingElement.scrollWidth };
        });
        check(fit.open && fit.left >= -1 && fit.right <= size.w + 1 && fit.pageW <= size.w + 1, `${size.name}: the Filters panel opens and fits the screen`, [JSON.stringify(fit)]);
        if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, `${size.w}-filters.png`) });
        await fbtn.click(); await page.waitForTimeout(250);
      } else check(false, `${size.name}: the Filters button shows on a phone`);
    }
    // open the first show card (tap its title row) and make sure nothing inside it pushes the page sideways
    const card = page.locator('.ev[data-id]').first();
    if (await card.count()) {
      await card.click({ position: { x: 20, y: 14 } }); await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({ open: !!document.querySelector('.ev[data-id].open'), pageW: document.scrollingElement.scrollWidth }));
      const m = await page.evaluate(measure, { phone: size.phone, MIN_TAP_H, MIN_TAP_W, MIN_TEXT_PX });
      check(r.open && r.pageW <= size.w + 1 && !m.cut.length, `${size.name}: an opened show card fits the screen`, [JSON.stringify(r), ...m.cut]);
      if (size.phone) check(!m.small.length, `${size.name}: an opened show card's buttons are big enough to tap`, m.small);
      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, `${size.w}-card-open.png`) });
    } else check(false, `${size.name}: there is a show card to open`);

    check(!errors.length, `${size.name}: no JavaScript errors`, errors);
    check(!strays.length, `${size.name}: the page asked nothing of any other site`, strays);
    await ctx.close();
  }
} finally { await browser.close(); srv.close(); }

console.log(`\n${passes} passed, ${fails.length} failed${SHOTS ? ` · screenshots in ${path.relative(process.cwd(), SHOT_DIR) || SHOT_DIR}` : ''}`);
process.exit(fails.length ? 1 : 0);
