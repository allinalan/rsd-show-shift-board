# Importing another coordinator's schedule workbook

`scripts/import-workbook.mjs` reads a coordinator's yearly schedule workbook (.xlsx, one tab per month) and writes its
events in board shape to one JSON file. It is step 1 of an outside coordinator's early build (2026-11-06): kept on its
own branch, nothing merged to `main`, and that coordinator's data never mixed with Rising Sun's.

It writes nothing to any database and there is no `--apply`: the board databases for another coordinator do not exist yet.
Rising Sun's board is untouched by it; it shares no code path with the Sheet sync.

```
node scripts/import-workbook.mjs <book.xlsx> --division <id> --year <yyyy> --out <scratch>/<id>-<yyyy>.json \
     [--nicknames <file.json>] [--tab January] [--strict]
```

- `--out` is refused inside this repo (any worktree of it, even a folder not made yet) and inside any other git work tree.
  The file is written mode 600. Without `--out` it only prints the report.
- `--division rising-sun` / `rsd` is refused: Rising Sun's board comes from its Sheet, never from a workbook.
- `--nicknames`: a JSON object `{ "<name as written in a shift cell>": "<rep name>" }` (matched on letters only, case and
  punctuation ignored). The report lists the names it does not have.
- `--strict`: exit 2 when anything was left unread (unparsed blocks, event-like cells inside notes, fills the key does not
  name). Without it the run exits 0 and says all of that in the report.
- The workbook itself is never copied into the repo, and neither is the JSON. Tests use invented grids only.

The reader is `scripts/lib/xlsx.mjs` (no dependencies: the zip's central directory, `zlib.inflateRawSync`, regex over the
OOXML parts). Per cell: value, fill colour (a theme colour is resolved through the workbook's theme, so the key and the
cells compare by colour), strike-through, hyperlink, comment; per tab: merged ranges.

## The layout it reads

- **Tabs.** January to December by name. Anything else (TEMPLATE, a service-events tab, a one-off tab) is skipped and listed.
- **Row 1 is the colour key**, read per tab (the books spell and place it differently from tab to tab): each label cell
  carries its own fill; `Booked` has none. Nothing about colours is hard-coded; a fill the tab's key does not name is
  reported as an unknown fill, never guessed.
- **`WEEK n (Mon D - [Mon] D)` in column A starts a week**, Tuesday to Monday. The board weekend is that week's Friday. A
  header that is not a Tuesday six days before a Monday (typos happen: `July 29 - Aug 3`, `July 30-6`) is squared from its
  Monday end, then its Tuesday start, and named in the warnings.
- **Section headers** in the next row: `KEY EVENTS`, `VARSITY / JV` (or `VARSITY/JV`), `WEEKLY EVENTS`, `WEEKLY MALL LEASES`;
  later `PROJECT SHOW(S)` beside `Team Booths`. Each header's columns are its merged range (else up to the next header).
  `PROJECT SHOW` re-labels only its own columns: a VARSITY / JV show written on that row stays VARSITY / JV.
- **Column A is the booth inventory**, not events: personal booths (by rep) under `Personal Booths`, team booths under
  `Team Booths`; the key's "Booth in Use" fill = in use that week. Kept in the JSON (`inventory`), one entry per week.
- **An event block** starts at a name cell: coloured with a status from the key, or plain (Booked) with its dates right
  under it, or hyperlinked (the link is the show's website). Then, each optional, in this order:
  dates (Excel serial, or `Jan 2-3`, `Feb 23-March 1`, `TBD`, `NOT HAPPENING 2026` ...), city (with `Booth #N` one or two
  columns over, often linked to a floor plan), cost (a number, or `$100 (note)`; the text beside it is kept as
  `boothNote`), best ever (`Best Ever (Jan): $12,345 (2025)`, `New Event`, `New Event - Last Worked: ...`), then the
  booths, day rows and notes. A block ends at the next name in its column, a section header over it, or the next week; it
  is as wide as the space to the next block's column in the same section.
- **Day rows**: `[date serial or blank][day label][people ...]` or `[day label][people ...]`; also `[02/11 (1/2 shift)][Wed]
  [people]` and, below the header rows, `[date serial][people]` with no label. A long show may run a second set of day
  columns beside the first; those days follow the first set. `Booth #...` rows start a booth (a show may have several).
- **Shift cells**: `____` (any run of underscores) is an open slot; `SET UP`, `No Vendors`, `BREAKDOWN`, `Off` are no shift
  (`__X__`, the text kept as `note`); a `*...` cell is a note on that day; a name in the key's Field Training fill is a
  field trainee and rides in `ft` on the rep beside them (helper-only when nobody else is on that day, which is never a
  staffed shift). Shift k is the k-th person written on each day; a day with fewer people has no shift there (`__X__`).
- **A half shift** is written into the day label (`(1/2)`, `(1/2 Shift)`); the label keeps it and `booths[].halfDays` marks it.
- **Notes**: `EVENT NOTES`, `MARKETING STANDARDS`, `SERVICE STANDARDS` (and `MARKETING / SERVICE`) are headings, their
  comments are kept in `comments`. `*Priority: <who> (found|growth|manages)` (any spelling of Priority) goes to `priority`;
  `*Show Full*`, `*On Waitlist*`, `Application Closed`, `Application available ...`, `Promoter Declined` set `flags`.
- **A label merged across a section** above its events (a fair's name over its venues) is kept as each event's `group`.

## Board shape

Every event carries the board's fields (`name, year, season, weekend, startDate, endDate, status, dead, tier, cityState,
cost, costNum, costBasis, website, bestCPO, bestEver, booths[{label, days, dates, shifts[{label, slots[{rep, ft}]}]}],
notes`), plus what the import adds: `division`, `section`, `sheetStatus` (the key's label, or `unknown fill <ARGB>`),
`datesText`, `costText`, `costNote`, `boothNote`, `boothText`, `boothLink`, `priority`, `flags`, `comments`, `group`,
`staleCells`, `labelOffCells`, `duplicateOf`, `sheetRef {file, tab, cell, rows}`, `source: workbook-import`. It never
carries contact, phone or e-mail fields (the books have none in these blocks).

- **id**: `<division>-<year>-<name slug>-<MMDD of the weekend>`, unique within the import (`-2`, `-3` on a clash). Note the
  board's `baseId()` strips a leading year only; the id convention for a multi-division board is still to settle.
- **tier**: KEY EVENTS = Key; VARSITY / JV, WEEKLY EVENTS, PROJECT SHOW(S) = Traditional for now (open question below).
- **status** from the name's fill, through the tab's key:

| Key label | `status` | flag |
|---|---|---|
| Booked (no fill) | Booked | |
| Event Charges and Orders Match Complete | Booked | `closedOut` |
| Canceled/Missed | Cancelled (`dead`) | |
| Not Booked | Prospective | `notBooked` |
| Prospective/Pending (also "Perspective/Pending") | Prospective | `pending` |
| Priority Booking | Prospective | `priorityBooking` |
| Sent Email | Prospective | `emailSent` |
| Waitlist (in the tabs whose key has it) | Show Full | `waitlist` |
| Split Tabs | Booked | `splitTabs` |
| anything else | empty, listed as an unknown fill | |

## Dates

- A day's date comes from its date serial when that serial is in the book's year (or inside its own week); a serial from
  another year is a stale copy (`datesStale`, `staleCells`) and the day is placed by its label inside the week. A
  year-less `02/11` whose weekday is not the label's in this year counts as stale the same way.
- An in-year serial whose weekday is not the one the label names is believed, and listed (`flags.dayLabelOff`,
  `labelOffCells`): the label is the one to fix.
- `startDate` / `endDate` come from the dates cell when it reads as dates (`TENTATIVE DATES - Mar 3-19` included,
  `flags.datesTentative`), else from the days; days placed from the week alone (a TBD show) are marked `datesEstimated`.
- A dates cell and day rows that disagree by more than a day are kept as written and flagged `datesDisagree`; words in the
  dates cell (`NO 2027`, `POSTPONED TO 2027`, `*No Jan Market*`) flag `notHappening`; `TBD` stays as `datesText`.
- The same name twice in one week on the same first day is flagged `duplicateOf` (two days of a weekly market are not).

## What it skips

- WEEKLY MALL LEASES (standing placeholders): counted, never read into events.
- Row 1 (the key), the week rows, the section header rows, non-month tabs.
- Column A is inventory, never events.

## What it reports (stdout; the JSON has the same and more)

Events by section and status and by key label; booths; booth inventory; day rows, half-shift days, staffed / open /
no-shift / trainee-only slots, field trainees; stale, estimated and disagreeing dates; unknown and text costs; skipped
blocks and tabs; **unparsed blocks** (every non-empty cell no rule took, by tab and cell range); **cells inside an event's
notes that look like an event of their own** (a coloured cell, or a name with a date under it); **unknown fills**, and
the fills seen on shift cells; warnings; the distinct names written in shift cells (console and JSON only, for the
nickname-to-rep table). Costs are never printed.

## Still unknown (questions for the coordinator's team)

1. Status colours: are "Prospective/Pending", "Not Booked", "Priority Booking" and "Sent Email" four steps of one path
   (and which board status each should be), or something else? Is an uncoloured name always Booked, or sometimes just not
   coloured yet?
2. The light red fill on weekly markets in the tabs whose key has no entry for it (one book's key calls it Waitlist in
   some tabs): is it always Waitlist? And the other fills no key names (light yellow on shift cells, darker reds on a few
   names and booth cells, gold on marketing / service headings).
3. A yellow (Prospective/Pending) or light yellow name, or a name in parentheses, in a shift cell: tentative, asked, or
   confirmed?
4. Tiers and access: what VARSITY / JV, WEEKLY EVENTS and PROJECT SHOW(S) should be on the board (who may pick them).
5. The text beside the cost (`? Booth`, a team booth's name, people's names): which booth goes, or who is helping?
   And the cost notes (`Chargeback to ...`, `Overage to ...`, `pay at event`): who pays what.
6. Is "Best Ever" sales in dollars for that show (and month when written), the number the board shows as best ever?
7. Priority kinds `found`, `growth`, `manages`: what each means for picking.
8. Weekly mall leases: skip for good, or a kiosk-style schedule of their own later?
9. Shows whose dates cell and week disagree, or whose day labels name another weekday than their dates: which is right?
10. Field trainees: does a green name always ride with the rep beside them, and is a trainee alone on a day possible?
11. The nickname-to-rep table: every distinct shift-cell name needs a rep (or "not a person"), from the team.
