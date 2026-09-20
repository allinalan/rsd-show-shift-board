---
name: board-event-check
description: "The Wednesday Event Check, reading the RSD Show Shift Board instead of the Google Sheet: pull a fresh VectorConnect My Events export, match every staffed board event to its VC record, write the live status and event number back to the board, and text the staffed reps whose show changed. Use when tick reports 'event-check', or when Alan asks to run the event check, check the board against VectorConnect, or see which staffed shows still aren't booked."
---

# board-event-check

This is the existing **event-check** skill with the schedule side swapped from the Sheet to the
board. Everything about the VectorConnect side — the export, the date-gated matching, the alias
table, the Mesa exclusion, the Queen Creek handling, the status definitions, the deliverable
workbook — is unchanged; read that skill and follow it. What's different:

## Step 1–2: the schedule is the board

Instead of downloading the Sheet as xlsx and parsing rows:

```
node scripts/board.mjs list --year <year> --staffed --live --json --full
```

Each event carries `name`, `weekend`, `startDate`, `endDate`, `booths[].shifts[].slots[].rep`,
`vcNumber`, `vcStatus`, `status`, `notes`. A rep is any non-empty `rep` that isn't `__X__`; SE days
never count. Trainees are in `ft`. There is no column C any more — the board's `status` **is** the
team's status, so the "Column C vs VectorConnect" tab becomes "Board status vs VectorConnect".

Match on `vcNumber` first when the board has one (it will, after the first sweep); fall back to
name + weekend as the skill describes.

## Step 7: write-back is one command per event

No Chrome, no clipboard, no column Z:

```
node scripts/board.mjs set <id> vcStatus="Booked" vcNumber=00101800 status=Booked
```

Map VC statuses to the board's `status` the way the Sheet used to: `Booked*` → Booked; `OK to Book*`
→ OK to Book - Need Contract; `Pending Promoter*` → Pending Promoter Acceptance; `Pending CO*` →
Pending Coordinator; `Show Full` → Show Full; any `Cancelled* / Missed* / Declined / Closed` → Cancelled
(and `dead=true`). Keep `vcStatus` verbatim from the export. Set `BOARD_ACTOR=service:board-event-check`.

Record what changed: for every event whose `status` moved, note old → new and the staffed reps.

## Texting the reps whose show changed

Only staffed reps on events whose status changed this week get a text — never a roster-wide
message. These are **drafts for Alan, never sends**: write them to
`out/reports/rep-text-drafts-<date>.md` and list the recipients in the summary. Every draft goes
through the **humanizer** skill first. A "your show is booked" text carries the show, the dates,
and the rep's own shifts; a "your show fell through" text says what happens to their shifts.

## Deliverable

Same workbook as the existing skill (`Event_Check_<Season>_<date>.xlsx`, saved under `out/reports/`),
plus the summary as `out/reports/event-check-<season>-<date>.md`. The board itself already shows
the new statuses — there is nothing to republish.

While the Google Sheet is still live (stage 1, see `docs/ROADMAP.md`), the Sheet stays the schedule
every other system reads. This routine updates the board only; it does not write to the Sheet, and
the existing Sheet-based **event-check** keeps running on its own until Alan retires it.

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
  other field, but they are private: never copy them into a tracked file, a commit or `notes`.

