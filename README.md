# RSD Show Shift Board

Every Rising Sun Division show by weekend — open shifts, who's on, booking status, cost per
shift, best-ever and last-year results — with a plan mode for coordinators and a set of Claude Code
routines that keep it accurate. Reps read it on the web; only listed editors can change it.

**Live:** https://allinalan.github.io/rsd-show-shift-board/ *(after Pages is enabled)*

## Setup (about 20 minutes, once)

### 1. Supabase — the database
1. Create a free project at supabase.com. Region: US West.
2. SQL Editor → New query → paste all of `supabase/schema.sql` → Run.
   (The last statement makes `ahernandez@allinknifeguy.com` the first owner; change it if needed.)
3. Authentication → Providers → Email: keep **Email** on, turn **Confirm email** off (magic links
   still work; this just skips a second confirmation for new editors).
4. Authentication → URL Configuration → Site URL: `https://allinalan.github.io/rsd-show-shift-board/`
   and add the same to Redirect URLs.
   Then Authentication → Emails → Templates → "Magic link or OTP": paste
   `supabase/email-templates/magic-link-or-otp.html` as the body (subject in its header comment), so
   the email carries the sign-in code.
5. Project Settings → API: copy the **URL** and the **anon public** key into `config.js`.
   The **service_role** key goes into `~/.rsd/board.env` (mode 600) on the Mac mini only — never
   into the repo, a chat or a log.

### 2. Load the data
```
node scripts/board.mjs seed
node scripts/board.mjs editors add matt@example.com --name Matt
node scripts/board.mjs editors add jp@example.com --name JP
node scripts/board.mjs settings set 'meetings:=["2027-01-15","2027-05-01","2027-08-14"]'
```

### 3. GitHub Pages
Settings → Pages → Deploy from branch `main`, folder `/ (root)`. The page is live a minute later.

### 4. The Mac mini
The production checkout is `~/automations/rsd-show-shift-board`. `./install.sh` runs the preflight
and writes the launchd job disarmed; `./install.sh --arm` loads it. Full go-live steps:
`docs/HANDOFF.md`. Every morning at 7:00 `deploy/tick.py` asks the board what's due and, if
something is, tells Alan on Slack and iMessage what to say to Claude. It does not run routines by
itself yet (`docs/ROADMAP.md`, stage 2).

## How it runs

| when | routine | what |
|---|---|---|
| 7 days before a shift-picking meeting | `board-preflight` | research every event's dates, promoter, name; fix the board; list the questions for Alan |
| the meeting | you | coordinators enter picks in plan mode; the page updates live for everyone |
| the day after | `board-booking-sweep` | a VC booking request for every staffed event without one, `notes` in the Comments |
| every Wednesday | `board-event-check` | refresh every VC status onto the board; draft texts (never send) for staffed reps whose show changed |
| year end | `board-rollforward` | next year's board from this year's, minus the Never list and skip-next-year |

Meeting dates live in plan mode → Division settings.

## Editing

Plan mode → your email → type in the code from the email (no password). That device stays signed
in until you sign out. The link in the same email works too, on the device that opens it. On an
iPhone, add the board to the Home Screen first (Share → Add to Home Screen) and sign in inside the
icon: Safari forgets a sign-in after a week away, the icon doesn't. If your email isn't on the
editor list you'll be told. Owners add editors in the SQL editor or with
`node scripts/board.mjs editors add`.

## What is private
The repo is public, so promoter contact names, phones and e-mails are never committed: they live
in the `event_contacts` table and in `seed/private/` on the mini. The live page shows them to
anyone with the link, because reps need to call promoters; only editors can change them. `scripts/check-public.mjs` (the pre-commit hook) refuses a commit that would
publish one.

## Backups
`node scripts/board.mjs export` dumps every table to `backups/<date>/`. Do it before a roll-forward.

## Development
`node tests/run-all.mjs` before every commit. Nothing to build. `python3 -m http.server` (or any static server) in the repo root, open
`index.html`. With `config.js` blank it shows `seed/` read-only, which is enough to work on layout.
