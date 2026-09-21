# Go-live: bringing the board up from the Mac mini

Production checkout: `~/automations/rsd-show-shift-board` on the mini. Read `CLAUDE.md` and
`docs/ROADMAP.md` first. Steps marked **ALAN** are his alone; stop at each. Nothing here touches
reps, and nothing here touches the Google Sheet: the Sheet stays the truth for every other system
(stage 1).

## 1. Repo → GitHub → Pages  (done 2026-09-19)
`gh repo create allinalan/rsd-show-shift-board --public --source . --push`, then Pages from `main` /
root. Public is required for free Pages. `node scripts/check-public.mjs` must be clean first; the
pre-commit hook runs it on every commit. https://allinalan.github.io/rsd-show-shift-board/ shows the
read-only preview (seed data, no promoter contacts) until step 2.

## 2. **ALAN** — create the Supabase project  (done 2026-09-20)
Project `cfmkxoynjexesciriuzg`, org "Rising Sun Events Team", free tier.
supabase.com → New project (free, US West). Then:
1. SQL Editor → New query → paste all of `supabase/schema.sql` → Run. (Re-runnable.)
   Done when the result pane says `Success. No rows returned`.
2. Authentication → **Sign In / Providers** → the **User Signups** card at the top of the page →
   **Confirm email OFF** → Save changes. (Supabase renamed this; it is no longer inside the Email
   provider, and the page is no longer called "Providers".)
3. Authentication → URL Configuration → Site URL `https://allinalan.github.io/rsd-show-shift-board/`
   (it ships as `http://localhost:3000`), then Redirect URLs → Add URL → the same URL → Save URLs.
4. Project Settings → API Keys → the **"Legacy anon, service_role API keys"** tab. Supabase now
   defaults to new-style `sb_publishable_…` / `sb_secret_…` keys on the first tab; this project uses
   the **legacy** pair, because `check-public.mjs` can decode a legacy anon JWT and prove its role is
   `anon` before letting it be committed — a prefix is all it can check on the new format.
   Give Claude the **Project URL** and the legacy **anon public** key (both public).
   The **service_role** key is a secret. Alan types it into the file himself, never into chat:
   ```
   mkdir -p ~/.rsd && nano ~/.rsd/board.env      # three lines:
   BOARD_SUPABASE_URL=https://xxxx.supabase.co
   BOARD_SERVICE_KEY=<service_role key>
   BOARD_ALAN_IMESSAGE=<the number or Apple ID the mini should iMessage>
   chmod 600 ~/.rsd/board.env
   ```
Claude then writes the URL + anon key into `config.js`, commits, pushes.

## 3. Smoke test  (passed 2026-09-20 — every preflight line OK, owner returned, tick sends nothing)
```
./install.sh --check                       # every line OK
node scripts/board.mjs editors list        # → Alan as owner
node scripts/board.mjs settings get        # → {} (nothing seeded yet)
python3 deploy/tick.py --dry               # → nothing due, or a printed notice; sends nothing
```

## 4. Cutover snapshot  (done 2026-09-20 — 232 events, 150 promoter contacts, live)
**Start a fresh session on Opus for this step.** It parses the Sheet under rules that fail silently
rather than loudly (`Cam` = `Cameron`, SE days that are never shifts, Mesa A/B rows, event rows whose
day cells hold dates), and a misparse writes a wrong seed that everyone then trusts.

Before starting, know this: `config.js` already holds the project URL and anon key but is
**committed locally and NOT pushed on purpose**. Pushing it before the seed makes the live page read
an empty database instead of showing the seed preview. Push it together with the seeded data.

`seed/events.json` is the Sheet as of 2026-09-13. A first diff against the live Sheet is in
`out/reports/sheet-vs-seed-diff-2026-09-19.md` (56 status changes; read its notes on what it
cannot see). Before seeding:
1. Re-pull the Sheet (public xlsx export of file `10p5Ro2WpeJ7mMOyS92OWIT3w3Nl-KGX4vBMkXJoOCTs`, tab `2026`).
2. Parse rep assignments the way the **event-check** skill does (aliases such as Cam = Cameron, SE
   days, Mesa A/B rows, event rows whose day cells are dates).
3. **ALAN** approves the diff table.
4. Write the approved changes into `seed/events.json` (ids stay stable: `2026-<base>`; a brand-new
   row gets `2026-<slug>-r<row>`); contact fields go to `seed/private/event_contacts.json`. Commit.
```
node scripts/board.mjs seed                # refuses if the public seed carries contact fields
```
Read back: `node scripts/board.mjs list --year 2026 | tail -1` shows the event count; open an event
on the live page signed out and confirm the promoter's contact, phone and e-mail show.

**What the run found and did**, in `out/reports/sheet-vs-seed-diff-2026-09-20.md` (gitignored):

- The parser was rebuilt to the event-check rules and checked against the seed itself — on the 227
  events that matched it reproduces the 9/13 parse exactly on every structural field, and the
  status derivation replays the seed 227/227. The 9/19 quick diff's uncertain rows are all resolved.
- Applied: 59 column-C edits (4 move the board's own status), 9 slot changes across 7 events, one
  SE-day cell, four new rows, six cosmetic cleanups. All 228 existing ids unchanged.
- Alan's calls: column C never overrides a status the 9/9 VC snapshot set — Wednesday's
  board-event-check refreshes those from a live export; the November Queen Creek row follows Sarah
  to sheet row 302 and keeps its id, and the 11-27 row is new.
- Sheet row 118 (Maricopa, October) is written one column to the right of every other event row.
  It was un-shifted against row 463 — the same show, same promoter — as the record was created.
- Rep names follow `settings.roster` spelling, not the Sheet's. The Sheet writes both `Matt A` and
  `Matt A.`; the board has always held `Matt A.`, and a new row seeded verbatim listed Matthew
  Aragon twice on the live page until it was mapped through the roster.
- Seven promoter contact records held a value in the wrong field — 9/13 parse damage from Sheet
  rows whose contact columns are spilled across — so the page rendered an empty `tel:` and a
  `mailto:` pointing at a URL. Each was corrected per record off the Sheet.
- `board seed` replaced the whole `settings` row and silently emptied `meetings`, which would have
  stopped `tick.py` ever reporting preflight due. `seed` now never overwrites a filled field with
  an empty one from the seed file, says out loud when it keeps one, and `tests/run-all.mjs` covers it.
  `seed/settings.json` still ships `meetings: []` on purpose: those dates come from
  `seed/private/go-live.md` and this repo is public.

## 5. Editors and meeting dates  (done 2026-09-20)
Values from Alan are in `seed/private/go-live.md` (gitignored). Run the three commands in it.
Matt and JP are loaded as `coordinator`, Alan as `owner`; `meetings` holds the three 2027 dates, and
`tick.py --dry --date 2027-01-06` correctly reports preflight due. They have NOT been told yet — that is step 8.

## 6. Live verification, with Alan watching  (passed 2026-09-20, one sub-check open)
1. Plan mode → Alan's email → **ALAN** taps the magic link → lands back signed in as owner.
2. A second browser, signed out: promoter contact, phone (tap to call) and e-mail show on an open
   event, nothing is editable; plan mode asks for sign-in; an email not on the list gets "not on
   the editor list yet".
3. Signed in: edit a phone; it persists after reload and appears in the signed-out window.
4. Two windows side by side: assign a shift in one; it appears in the other without refresh.
5. `node scripts/board.mjs changelog --limit 3` shows those writes with Alan's email as actor.
If 4 fails, check that `schema.sql`'s realtime block ran (Database → Replication).

**Run of 2026-09-20 — the signed-out half passed; the signed-in half waits on Alan's first sign-in.**

- Passed, signed out, against the live page: it reads Supabase (six REST reads, no `seed/` fetch,
  header says `live`); an event with a promoter on file shows contact, phone as a `tel:` link and
  e-mail as a `mailto:` link, all three equal to the database by hash; an event with none says
  `not listed yet`; an open card holds no input and a slot click does nothing; Plan mode opens the
  sign-in panel, and Cancel switches Plan mode back off and hides the edit toolbar.
- Passed, server side: row-level security is on for all nine tables, every write policy is
  `is_editor()` (`editors` is `is_owner()`), and `supabase_realtime` publishes `events`,
  `event_contacts`, `history`, `never_work`, `overrides`, `settings` — the realtime block ran.
- Not yet run: 1, 3, 4, 5. `auth.users` was empty and the auth log held no OTP request: nobody has
  ever signed in, so magic-link delivery is unproven.
- **Supabase's built-in mailer only delivers to addresses on the organization's Team list**, and
  only a couple of messages an hour. Any other address gets `Email address not authorized` in the
  sign-in panel — it never reaches "not on the editor list yet", and **Matt and JP cannot sign in
  at step 8** until either they are invited to the Supabase org (Organization → Team) or a custom
  SMTP sender is set (Authentication → Emails → SMTP Settings). If Alan's own link fails the same
  way, his Supabase login is a different address from his editor address. The "email not on the
  list" check in 2 needs a mailbox the mailer will deliver to, so it waits on the same decision.
- The first sign-in creates the login, so Alan requests his own link, on the device he will edit
  from. The test event is `2026-mohave-county-fair-r68`; its pre-edit copy is in `backups/`.

**Signed-in half, run 2026-09-20 after 6a — passed.**

- 1: Alan's link arrived through Resend in seconds (`Your sign-in link`, Delivered) and `/verify`
  logged him in nine seconds after the request. The page let him edit, so `is_editor()` held.
- 3 and 4: he changed the phone on `2026-mohave-county-fair-r68` and took the Thursday shift on
  `2026-rv-show-usa-tucson-r70`. Both are in the database, and both reached a signed-out window
  that had been loaded seven minutes earlier and never reloaded (new phone by hash; `OPEN 4` →
  `OPEN 3`). Only `phone`, and only `booths` + `_updated`, differed from the pre-edit snapshot.
- 5: `board changelog` shows both writes with Alan's e-mail as actor.
- Both test edits were put back from the snapshot under `BOARD_ACTOR=service:step6-restore`; all
  127 upcoming events equal the snapshot again, and the signed-out window flipped back on its own.
- **Still open from 2:** "an email not on the list gets *not on the editor list yet*". It needs a
  second mailbox to sign in, which creates a login, so it is Alan's: sign in once from any address
  that is not an editor and read the header line.
- Two things that bit, both silent until the log was read. The Supabase port field mangles
  automated typing (`465465`, then `461`, then `65`): with a port nothing listens on, every `/otp`
  hangs ten seconds and returns **HTTP 504 `context deadline exceeded`**, while a bad key fails
  fast with an auth error. And one `/otp` returned `200` while the port was still wrong and
  Resend never saw a message: a `200` is not proof of delivery, Resend → Emails is.

### 6a. **ALAN** — custom SMTP through Resend  (done 2026-09-20)
Chosen over inviting Matt and JP to the Supabase org: the lowest org role on the free plan
(Developer) can read the service key and the JWT secret, which is the one credential the editors
list exists to keep on the mini.

1. resend.com account → Domains → Add Domain → `board.allinknifeguy.com` (a subdomain, as Resend
   recommends: the root domain's Google Workspace MX and SPF records are not touched).
2. Add the records Resend lists at the DNS host. As issued 2026-09-20 (region `us-east-1`, sending
   on, receiving off, no tracking subdomain) they are three, and none of them is an MX:
   `TXT resend._domainkey.board` = the DKIM public key shown on the domain's page in Resend;
   `CNAME rsend.board` → `rsend.forge.rmta.net`; `CNAME send.board` → `send.forge.rmta.net`.
   The optional `_dmarc` row and the receiving MX are not needed. The domain's nameservers are
   eNom's (`dns1–5.name-services.com`). Check with
   `dig +short CNAME send.board.allinknifeguy.com @dns1.name-services.com` before pressing Verify.
   **Done 2026-09-20**: all three rows added and live on the authoritative server and on
   8.8.8.8 / 1.1.1.1 / 9.9.9.9 within a minute; the DKIM value matches Resend's byte for byte; the
   twelve existing host records and the five Google MX rows read back unchanged (pre-change copy in
   `backups/dns-enom-host-records-before-resend-*.txt`).
   Getting to the DNS console: the domain was bought through Google Workspace, so it is Google
   Admin → Account → Domains → Manage domains → View Details → **Advanced DNS Settings**, which
   shows a sign-in name and password for `access.enom.com` (Alan signs in; that panel displays the
   password, so close it afterwards). In eNom: Host Records → Edit → **Add New** once per row →
   fill → **Save**. Save re-posts every row, so read the whole table back before pressing it.
   CNAME targets are stored with a trailing dot. MX rows live in a separate Email Settings block.
3. Resend → API Keys → a key with **Sending access**, limited to that domain. It is a secret and
   lives in exactly one place: the Supabase SMTP password field. Never in chat, git or the mini.
4. Supabase → Authentication → Emails → SMTP Settings → enable custom SMTP: host `smtp.resend.com`,
   port `465`, username `resend`, password = the API key, sender `no-reply@` the sending domain,
   sender name `RSD Show Shift Board`. Supabase then allows 30 auth emails an hour (Rate Limits).
5. Proof is a delivered magic link plus a clean `/otp` line in the auth log. If sign-in later
   breaks with `Couldn't send: …`, the key was revoked or the domain lost verification: make a new
   key, paste it into the same field.

## 7. Arm the daily tick  (done 2026-09-20 21:14)
```
./install.sh --arm
touch PAUSED && launchctl start com.allinalan.rsd-board-tick && sleep 3 && tail -2 logs/tick.log && rm PAUSED
```
The log must say `PAUSED file present`. TCC for the iMessage can only be proven by a real launchd
run on a day something is due (first one: Wednesday). Read `logs/tick.log` after it.
Update the registry entry's status from PREPARED to production in the same sitting.

**Run of 2026-09-20.** Preflight all OK; armed; `launchctl start` with `PAUSED` on logged
`PAUSED file present: doing nothing`, exit code 0, nothing on stderr; `PAUSED` removed; registry
moved to production. Dry runs say nothing is due 9/21 or 9/22 and `event-check` is due **Wed
9/23**: that 07:00 run is the first proof of the iMessage (TCC) path. Read `logs/tick.log` after it.

- **Arm and `touch PAUSED` in either order** (fixed 2026-09-20, later the same night). Three
  `tick.py --dry` tests used to run against the real repo root, so with `PAUSED` present they
  failed and `install.sh` refused to arm: failed closed, but it read as broken tests. The tests
  now run the launcher from a staged copy in a temp dir (`tick.py` takes its root from where it
  sits), with its own `PAUSED`, `logs/` and `.git`, so the real kill switch or a dirty tree cannot
  reach them. A new test covers the kill switch itself: `PAUSED` on a day a routine is due logs
  one line, exits 0, sends nothing.
- **The tree has to be clean or the mini stops updating, and now it says so.** `tick.py` pulls
  only over a clean tree, and used to say `tree is dirty, pull skipped` nowhere but the log's
  start line. Since 2026-09-20 a dirty tree or a failed pull (a hung one included: it used to
  crash the run) posts `MAC MINI AUTOMATION FAILURE — rsd-show-shift-board tick could not update
  its code: <reason>` to the Slack alert channel, naming the repo, the dirty paths or git's error,
  and the log. Once per run, not fatal: the tick still decides and notifies on the code it has.
  `not a git checkout` and `no remote yet` stay quiet; `--dry` and `--status` still send nothing.
  Two untracked items left by another agent tool (`AGENTS.md`, `.agents/`) would have blocked
  every pull from day one; they are gitignored now. After any work on the mini,
  `git status --porcelain` must still print nothing: the alert is the net, not the habit.

## 8. Tell the coordinators, not the reps  (sent 2026-09-20 21:36; go-live steps complete)
Matt and JP get the link and sign in. Reps keep using the Sheet until stage 3 of the roadmap.

**Run of 2026-09-20.** One e-mail from Alan to both coordinators, at the exact addresses on the
editors list, after he read the recipients and the text and said go: where the board is, the four
sign-in steps (Plan mode, that same address, the link from `RSD Show Shift Board`, tap it on the
device you edit from), that the Sheet stays the source of truth so real schedule changes still go
there, and not to share it with reps. First proof it worked is a `/verify` + `Login` line for each
of them in the Supabase auth log, and their address showing up in `board changelog`.

- **The Gmail connector rewrites every URL when it writes a draft**, in the plain body and inside an
  `href`, into `https://www.google.com/url?q=…&source=gmail&ust=…`, stamped at the millisecond the
  MIME is built (the raw source of the sent message proves it is stored, not a display artifact).
  The link still reaches the board; after about a day Google puts a "Redirect Notice" page in
  front of it. It shows in the draft's snippet, so **read a draft's body back before sending
  anything that carries a link**, and have Alan paste links himself when they must be clean.

## If something breaks later
`touch PAUSED` stops the job. `node scripts/board.mjs export` before any big change (includes the
private contacts; `backups/` is gitignored). `board changelog` says who did what.
