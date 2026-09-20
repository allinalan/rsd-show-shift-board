#!/usr/bin/env node
/*
  check-public — this repo is PUBLIC (GitHub Pages needs it). Refuse a commit that would publish
  a phone number, a private e-mail address, a contact field in the events seed, or a service key.
  Runs as the pre-commit hook (install.sh installs it) and by hand: node scripts/check-public.mjs
  Exit 0 = clean. Exit 1 = findings, each with file and reason. Values are never printed.
*/
import fs from 'fs';
import { execFileSync } from 'child_process';

const ALLOW_EMAIL = [/@example\.com$/i, /^noreply@anthropic\.com$/i, /^ahernandez@allinknifeguy\.com$/i];   // owner email is already public in schema.sql by design
const PHONE = /\(?\b[2-9][0-9]{2}\)?[ .-][0-9]{3}[ .-][0-9]{4}\b/g, EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}/g;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const staged = process.argv.includes('--staged');
const files = execFileSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM'] : ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const bad = [];
for (const f of files) {
  if (!fs.existsSync(f) || fs.statSync(f).size > 5e6) continue;
  if (/^seed\/private\//.test(f)) { bad.push(`${f}: seed/private/ must never be tracked`); continue; }
  const text = fs.readFileSync(f, 'utf8');
  const phones = (text.match(PHONE) || []).filter(p => !/555[ .-]01/.test(p));
  if (phones.length) bad.push(`${f}: ${phones.length} phone number(s)`);
  const emails = [...new Set(text.match(EMAIL) || [])].filter(e => !ALLOW_EMAIL.some(r => r.test(e)) && !/\.(png|jpg|svg|js|css)$/i.test(e));
  if (emails.length) bad.push(`${f}: ${emails.length} e-mail address(es) not on the allow-list`);
  for (const tok of text.match(JWT) || []) { try { const role = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).role; if (role !== 'anon') bad.push(`${f}: a JWT whose role is "${role}" — only the anon key may be committed`); } catch { bad.push(`${f}: an undecodable JWT`); } }
  if (f === 'seed/events.json') { const n = JSON.parse(text).filter(e => ['contact', 'phone', 'email'].some(k => e[k] && String(e[k]).trim())).length; if (n) bad.push(`${f}: ${n} event(s) carry contact/phone/email — those belong in seed/private/event_contacts.json`); }
}
if (bad.length) { console.error('check-public: REFUSED — this repo is public.\n  ' + bad.join('\n  ')); process.exit(1); }
console.log(`check-public: clean (${files.length} files)`);
