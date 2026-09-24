---
name: board-preflight
description: "The HAND-RUN FALLBACK for the pre-meeting research on the RSD Show Shift Board. Since 2026-09-24 it runs itself from rsd-shift-picking (com.rsd.preflight): the date research 7 days before a shift-picking meeting and the preflight 2 days before, with Claude and web search, writing the board by script and texting/emailing the report. Use this skill only when Alan asks to run the pre-meeting research by hand, or when the unattended run failed and he wants it done now: 'run the preflight by hand', 'verify the dates before shift picking'."
---

# board-preflight

**Runs itself since 2026-09-24.** rsd-shift-picking's `run-preflight.sh` (launchd com.rsd.preflight, 10:00) does
this unattended: the date research 7 days before a meeting (every upcoming show's dates) and the full preflight 2
days before (dates, venue, address, promoter, and the blanks the booking sweep needs). The board side is
`scripts/board-research.mjs` (read its header for the rules), the research is Claude with web search, the report
is texted to Alan and emailed to the coordinators, and reps whose days moved get texts once Alan approves.
Its date rule is Alan's: the date the show's own page states wins; nothing found online and VC disagrees = VC's
dates, with a note on the board. What follows is the by-hand version, for when Alan asks for it.

The meeting only works if the board is true. Reps will pick weekends off it; a wrong date means a
rep books a hotel for the wrong Saturday. This is research mode over the whole upcoming list.

## Scope

```
node scripts/board.mjs list --year <meeting year> --live --upcoming --json --full
```

Every event that isn't dead or never-work, from the meeting date forward through the season that
meeting staffs (January → Jan–May, late April/May → May–Sep, August → Sep–Feb). Read each event's
`notes` first — Alan and JP leave the kind of thing research can't find ("north side, not south").

## For each event, confirm three things

1. **Dates for this year.** Rolled events are stamped `datesEstimated: true` (+364 days from last
   year), which is a guess that is right about half the time. Find this year's real dates on the
   event's site, the promoter's site, or the hosting chamber. When found, write them:
   ```
   node scripts/board.mjs set <id> startDate=2027-03-06
   ```
   (`set` with `startDate` recomputes end date, weekend and every booth's day dates, and clears
   `datesEstimated`.) When the event has been cancelled or has no dates published yet, do **not**
   guess — hold it for the questions list.
2. **Promoter, contact, phone, website, venue, address, indoor/outdoor.** Fill blanks you can verify;
   correct what has changed. Leave `notes` alone unless adding a dated line at the end
   (`— 2027-01-08 preflight: vendor deadline is Feb 1`).
3. **The name.** Shows rename ("Arizona Wine Festival (formerly Heritage)"). Keep the board's name
   but add the alias in `notes` so the booking sweep's REBOOK search still finds the VC record.

Research wins over what's on the board; say what changed. Where research finds nothing, leave the
board alone and put the event on the questions list.

## Output

- Board updated for everything certain (`board changelog` shows every change under
  `actor: service:board-preflight` — set `BOARD_ACTOR=service:board-preflight` before running).
- The summary to Alan in the conversation: `Preflight for <meeting date>: <n> events checked, <n> dates
  corrected, <n> promoter fixes. Need you on <n>:` then one line per question, event name first. Board link.
- The same, longer, as `out/reports/board-preflight-<date>.md`, with a table of every
  change (event · field · was → now · source URL).

Don't text reps. Don't touch shifts. Don't submit anything to VectorConnect — that's the sweep.

## Messages and reports: house rules (these override anything older in this skill)

- **Never send an iMessage, SMS, Slack message or e-mail from this routine.** No Messages MCP tools,
  no osascript, no node or bash talking to Messages.app: on the mini only `/usr/bin/python3` may do
  that, and the only thing that does is `deploy/tick.py`, to Alan alone.
- Reports are files under `out/reports/` (gitignored; this repo is public). End the run by showing
  Alan the short summary in the conversation and naming the file.
- Texts to reps are **drafts only**: write them to `out/reports/rep-text-drafts-<date>.md`, one block
  per rep with the recipient, the show and the message. There is no send path in this repo. Alan
  sends them himself, or asks for a send in a later message after he has read the list.
- Promoter `contact`, `phone`, `email` come back from `board get` / `board list --json --full` like any
  other field. The live page shows them; git must not: never copy them into a tracked file, a
  commit or `notes` (this repo is public, and `notes` lives in the public seed).

