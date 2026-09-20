---
name: board-booking-sweep
description: "The day after a shift-picking meeting: find every staffed event on the RSD Show Shift Board that has no VectorConnect booking (Prospective, or no VC number), research and submit a Booking Request for each through VectorConnect, and write the VC number and status back to the board. Use when tick reports 'booking-sweep', or when Alan says 'submit the booking requests from the meeting', 'send in everything we staffed', 'run the sweep'."
---

# board-booking-sweep

Yesterday the coordinators filled shifts. Today every one of those promises gets a booking behind it.

## The list

```
node scripts/board.mjs list --year <year> --staffed --no-vc --live --upcoming --json --full
```

Staffed = at least one real shift has a name (SE days don't count). Exclude anything on the
Never list or `dead`. Mesa Market Place is one monthly VC record — treat the month's dates as one
request (see the `count-mesa-shifts` and `event-check` skills for the Mesa rule).

## Submitting

Use the **vectorconnect-booking-request** skill exactly as written — it owns the form, the
REBOOK-vs-NEW classification, the research step, the Division trap, the required-field rules.
Two things change now that the board exists:

1. **The board is the schedule.** Where that skill says "pull the schedule row", read the event
   from the board instead. The fields it needs are already there: `promoter`, `contact`, `phone`,
   `email`, `website`, `location`, `address`, `cityState`, `cost`, `setting` (indoor / outdoor /
   both), `applyUrl`, `applyBy`. Research only what is blank or looks stale.
2. **`notes` go into the form's Comments.** Alan and JP write there what Olean needs to hear —
   "north side of the venue, not south", "returning vendor since 2022", "cost is an estimate".
   Put the event's `notes` first in Comments (500-char cap), then the skill's own caveats.

Batch rule stands: gather everything, show Alan the whole batch, submit only after he says go.
A meeting produces 20–40 of these; one approval covers the batch.

## Write-back

After each confirmed submission (the banner):

```
node scripts/board.mjs set <id> status="Booking Request Needed" vcStatus="Booking Request Submitted" vcRequestedAt=2027-01-16
```

When the event already had a VC record (REBOOK found it), also write `vcNumber=<number>`. Set
`BOARD_ACTOR=service:board-booking-sweep` so the changelog says who did it.

## Output

To Alan in the conversation: `Booking sweep: <n> submitted, <n> held (reason each)`, plus the board
link. The held list is the important half — a held event costs one message, a wrong submission
costs Olean a phone call. Write the batch table as `out/reports/booking-requests-submitted-<date>.md`
(same shape as the existing ones).

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

