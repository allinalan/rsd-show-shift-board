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

## 4. Cutover snapshot — do NOT skip  ← NEXT
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

## 5. Editors and meeting dates  (done 2026-09-20)
Values from Alan are in `seed/private/go-live.md` (gitignored). Run the three commands in it.
Matt and JP are loaded as `coordinator`, Alan as `owner`; `meetings` holds the three 2027 dates, and
`tick.py --dry --date 2027-01-06` correctly reports preflight due. They have NOT been told yet — that is step 8.

## 6. Live verification, with Alan watching
1. Plan mode → Alan's email → **ALAN** taps the magic link → lands back signed in as owner.
2. A second browser, signed out: promoter contact, phone (tap to call) and e-mail show on an open
   event, nothing is editable; plan mode asks for sign-in; an email not on the list gets "not on
   the editor list yet".
3. Signed in: edit a phone; it persists after reload and appears in the signed-out window.
4. Two windows side by side: assign a shift in one; it appears in the other without refresh.
5. `node scripts/board.mjs changelog --limit 3` shows those writes with Alan's email as actor.
If 4 fails, check that `schema.sql`'s realtime block ran (Database → Replication).

## 7. Arm the daily tick
```
./install.sh --arm
touch PAUSED && launchctl start com.allinalan.rsd-board-tick && sleep 3 && tail -2 logs/tick.log && rm PAUSED
```
The log must say `PAUSED file present`. TCC for the iMessage can only be proven by a real launchd
run on a day something is due (first one: Wednesday). Read `logs/tick.log` after it.
Update the registry entry's status from PREPARED to production in the same sitting.

## 8. Tell the coordinators, not the reps
Matt and JP get the link and sign in. Reps keep using the Sheet until stage 3 of the roadmap.

## If something breaks later
`touch PAUSED` stops the job. `node scripts/board.mjs export` before any big change (includes the
private contacts; `backups/` is gitignored). `board changelog` says who did what.
