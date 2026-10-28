#!/usr/bin/env node
// One-time Google consent for the board -> Sheet mirror (stage 3, docs/stage-3-january.md). Alan runs it once, on the
// Mac mini, signed in to the Google account that owns the Show Shift Schedule books:
//     node scripts/authorize-sheets.mjs
// Opens a consent link, catches Google's answer on a loopback port, writes ~/.rsd/sheets-mirror.json (600): the refresh
// token only (the client is read from the shared OAuth client file each time, never copied). Never printed.
// Scope: spreadsheets (see, edit, create Google Sheets). The mirror uses it to make its own copies of the two books and
// write those; scripts/lib/sheets-api.mjs refuses any other spreadsheet, and the team's books are refused until the
// January 13 cutover switches the mirror onto them.
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { loadClient, TOKEN_FILE, CLIENT_FILE, SCOPE } from './lib/sheets-api.mjs';

const c = loadClient();
const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');
const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
  const redirect = `http://localhost:${server.address().port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: c.id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' });
  console.log(`\n1. Allow the Show Shift Board's mirror to edit Google Sheets (it changes only its own copies of the two books until January 13).\n   Opening this link in the browser here (open it yourself if nothing opens):\n\n${url}\n\n2. Waiting for Google to answer...`);
  if (process.platform === 'darwin' && !process.env.NO_OPEN) execFile('open', [url], () => {});
  server.on('request', async (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    if (q.get('state') !== state || !q.get('code')) { res.end(q.get('error') ? `Google said: ${q.get('error')}. Nothing was saved.` : 'Not the answer this is waiting for.'); if (q.get('error')) { console.error(`Google said: ${q.get('error')}`); process.exit(1); } return; }
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: q.get('code'), client_id: c.id, client_secret: c.secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) { res.end('Google did not hand back a key. Nothing was saved; run it again.'); console.error(`no refresh token (${r.status} ${j.error || ''} ${j.error_description || ''})`); process.exit(1); }
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ refresh_token: j.refresh_token, scope: j.scope, client: CLIENT_FILE, at: new Date().toISOString() }, null, 1) + '\n', { mode: 0o600 });
    fs.chmodSync(TOKEN_FILE, 0o600);
    res.end('Done: the mirror can now make and write its copies. You can close this tab.');
    console.log(`\nSaved ${TOKEN_FILE} (600). Next: node scripts/sheet-mirror.mjs setup-copies`);
    server.close(); process.exit(0);
  });
});
