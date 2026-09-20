---
name: board-tick
description: "The daily entry point for the RSD Show Shift Board routines. Run it once a day (launchd on the Mac mini, or by hand): it asks the board which routines are due today — pre-meeting research 7 days before a shift-picking meeting, the booking sweep the day after one, the Event Check every Wednesday — and runs them in order. Use it whenever Alan says 'run the tick', 'what's due today on the board', 'run today's board routines', or when a scheduled job invokes it."
---

# board-tick

One routine decides, so nothing has to be remembered. The board's Division settings hold the
shift-picking meeting dates; `tick` turns today's date into a to-do list.

```
node scripts/board.mjs tick --json
```

returns `{ date, due: [{ routine, meeting?, note }] }`. Then, in this order:

| routine | run |
|---|---|
| `preflight` | the **board-preflight** skill (7 days before a meeting) |
| `booking-sweep` | the **board-booking-sweep** skill (the day after a meeting) |
| `event-check` | the **board-event-check** skill (every Wednesday) |

If nothing is due, say so in one line and stop. Never run a routine that isn't due — a preflight
on the wrong day rewrites dates nobody asked about.

## How it is scheduled (stage 1)

The mini does not run this skill unattended. `deploy/tick.py` (launchd `com.allinalan.rsd-board-tick`,
07:00 daily) runs `board.mjs tick --json` itself and, when something is due, posts to Slack and
iMessages Alan the sentence to say. Alan then opens Claude on this repo and says it, which lands
here. Reason: the routines need the account skills `event-check`, `vectorconnect-booking-request`,
`vectorconnect-event-export` and `humanizer`, which a headless `claude -p` on the mini cannot see
(verified 2026-09-19). Unattended runs are stage 2 in `docs/ROADMAP.md`.

If one of those skills is not available in the session you are in, stop and say so. Do not
improvise the VectorConnect steps from memory.

## Reporting

At most five lines to Alan in the conversation: what ran, what changed (counts), what needs a
human, the board link. The same summary goes to `out/reports/board-tick-<date>.md`. If Alan has
asked for JP to be included on research questions, put JP's questions in their own block of that
file for Alan to forward.

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

## Setup on the Mac mini (once)

`./install.sh` checks everything and writes the launchd job disarmed; `./install.sh --arm` loads it.
`~/.rsd/board.env` (mode 600) holds `BOARD_SUPABASE_URL`, `BOARD_SERVICE_KEY`, `BOARD_ALAN_IMESSAGE`.
Chrome signed in to VectorConnect (the booking sweep and the event check drive it).
