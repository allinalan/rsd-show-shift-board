// Google Sheets for the board -> Sheet mirror (stage 3). Plain fetch, no packages (this repo has none). The key is
// ~/.rsd/sheets-mirror.json (600, made once by scripts/authorize-sheets.mjs: Alan's own Google account, scope
// spreadsheets), never printed. Every call names its spreadsheet and is checked against an allow-list the caller passes:
// `read` for the files it may read, `write` for the files it may change. Until the January 13 cutover `write` holds only
// the mirror's own copies (state/mirror-copies.json), never the team's books.
import fs from 'fs';
import os from 'os';
import path from 'path';

export const TOKEN_FILE = process.env.BOARD_SHEETS_TOKEN || path.join(os.homedir(), '.rsd', 'sheets-mirror.json');
export const CLIENT_FILE = process.env.BOARD_SHEETS_CLIENT || path.join(os.homedir(), 'automations', 'csp-autopilot', 'oauth_client.json');
export const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS = process.env.BOARD_SHEETS_BASE || 'https://sheets.googleapis.com/v4/spreadsheets';   // the tests stand in for Google here
const TOKEN_URL = process.env.BOARD_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';

export function loadClient(file = CLIENT_FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8')); const c = j.installed || j.web;
  if (!c || !c.client_id || !c.client_secret) throw new Error(`${file} is not a Google OAuth client file`);
  return { id: c.client_id, secret: c.client_secret };
}

/** -> { get, batchUpdate, create, copyTo, meta } bound to the allow-lists. `fetchImpl` lets the tests stand in for Google. */
export function sheetsApi({ read = [], write = [], fetchImpl = fetch, tokenFile = TOKEN_FILE, clientFile = CLIENT_FILE } = {}) {
  let access = null, until = 0;
  const canRead = new Set([...read, ...write]), canWrite = new Set(write);
  async function token() {
    if (access && Date.now() < until - 60000) return access;
    let saved; try { saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch (e) { throw new Error(`no Google key for the mirror (${tokenFile}: ${e.code || e.message}); Alan runs node scripts/authorize-sheets.mjs once`); }
    if (!saved.refresh_token) throw new Error(`${tokenFile} has no refresh token; run node scripts/authorize-sheets.mjs again`);
    const c = loadClient(clientFile);
    const r = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: saved.refresh_token, grant_type: 'refresh_token' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Google would not renew the mirror's key (${r.status} ${j.error || ''} ${j.error_description || ''}); run node scripts/authorize-sheets.mjs again`);
    access = j.access_token; until = Date.now() + (j.expires_in || 3600) * 1000; return access;
  }
  async function call(method, url, body) {
    const r = await fetchImpl(url, { method, headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (!r.ok) {
      const msg = (j && j.error && j.error.message) || text.slice(0, 300);
      throw new Error(`Google Sheets ${method} ${url.replace(SHEETS, '').split('?')[0]} -> ${r.status}: ${msg}${/has not been used|is disabled/i.test(msg) ? ' (turn the Google Sheets API on for that Cloud project, the link is in the message)' : ''}`);
    }
    return j;
  }
  const mayRead = id => { if (!canRead.has(id)) throw new Error(`the mirror may not read spreadsheet ${id}`); return id; };
  const mayWrite = id => { if (!canWrite.has(id)) throw new Error(`the mirror may not change spreadsheet ${id} (only its own copies until the cutover)`); return id; };
  return {
    meta: id => call('GET', `${SHEETS}/${mayRead(id)}?fields=spreadsheetId,properties.title,sheets.properties`),
    /** the cells of `range` ("'2027'!A35:AA600") with what the mirror compares: value, and font color */
    get: (id, range) => call('GET', `${SHEETS}/${mayRead(id)}?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent('sheets(properties(sheetId,title,gridProperties),data(startRow,rowData(values(effectiveValue,formattedValue,userEnteredFormat(textFormat(foregroundColor),numberFormat)))))')}`),
    batchUpdate: (id, requests) => call('POST', `${SHEETS}/${mayWrite(id)}:batchUpdate`, { requests }),
    /** a new spreadsheet (it is the mirror's: it goes on the write list for the rest of this run) */
    create: async title => { const j = await call('POST', SHEETS, { properties: { title } }); canRead.add(j.spreadsheetId); canWrite.add(j.spreadsheetId); return j; },
    copyTo: (fromId, sheetId, toId) => call('POST', `${SHEETS}/${mayRead(fromId)}/sheets/${sheetId}:copyTo`, { destinationSpreadsheetId: mayWrite(toId) }),
  };
}

// ---- cells <-> the mirror's grid ----
const EPOCH = Date.UTC(1899, 11, 30);
export const isoToSerial = iso => Math.round((Date.parse(iso + 'T00:00:00Z') - EPOCH) / 86400000);
export const serialToIso = n => new Date(EPOCH + Math.round(n) * 86400000).toISOString().slice(0, 10);
export const hexToRgb = hex => { const m = String(hex || '').match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); return m ? { red: parseInt(m[1], 16) / 255, green: parseInt(m[2], 16) / 255, blue: parseInt(m[3], 16) / 255 } : null; };
export const rgbToHex = c => (c ? '#' + ['red', 'green', 'blue'].map(k => Math.round((c[k] || 0) * 255).toString(16).padStart(2, '0')).join('') : '#000000');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** One grid cell as Sheets CellData: dates in N/O as real dates (m/d/yyyy), numbers as numbers, everything else as text
 *  (so "X", "1/15" or "=..." are never turned into something else). */
export function cellData(v, color, col, { dateCols = [13, 14] } = {}) {
  const fmt = { textFormat: { foregroundColor: hexToRgb(color || '#000000') } };
  if (v === '' || v === null || v === undefined) return { userEnteredFormat: fmt };
  if (dateCols.includes(col) && ISO.test(String(v))) return { userEnteredValue: { numberValue: isoToSerial(String(v)) }, userEnteredFormat: { ...fmt, numberFormat: { type: 'DATE', pattern: 'm/d/yyyy' } } };
  if (typeof v === 'number' && Number.isFinite(v)) return { userEnteredValue: { numberValue: v }, userEnteredFormat: fmt };
  return { userEnteredValue: { stringValue: String(v) }, userEnteredFormat: fmt };
}
/** A cell read back, in the grid's own terms (what cellData was given). */
export function cellBack(cell, col, { dateCols = [13, 14] } = {}) {
  const ev = (cell && cell.effectiveValue) || {};
  let v = '';
  if (ev.stringValue !== undefined) v = ev.stringValue;
  else if (ev.numberValue !== undefined) v = dateCols.includes(col) && cell.userEnteredFormat && cell.userEnteredFormat.numberFormat && /DATE/.test(cell.userEnteredFormat.numberFormat.type || '') ? serialToIso(ev.numberValue) : ev.numberValue;
  else if (ev.boolValue !== undefined) v = String(ev.boolValue);
  const fc = cell && cell.userEnteredFormat && cell.userEnteredFormat.textFormat && cell.userEnteredFormat.textFormat.foregroundColor;
  return { v, color: v === '' ? null : rgbToHex(fc) };
}
