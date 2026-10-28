// Column C on the Sheet (`sheetStatus` on the board) after the January 13, 2027 meeting (stage 3, Alan 2026-10-27,
// default 4): the board's own status takes its place, and what the team wrote there that is more than a status word moves
// once into the show's team notes ("expensive, maybe 2027, not working", "vendors not allowed", "no dates 2026"). This
// file decides which; `board sheet-notes` reads the board and writes. Pure.
export const STATUS_WORD = /^(booked|prospective|pending( promoter( acceptance)?| acceptance| coordinator)?|in progress|ok to book( - need contract)?|(show )?full|submitted|booking request (submitted|needed)|request to book|cancell?ed)$/i;
const clean = s => String(s || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
export const isStatusWord = s => STATUS_WORD.test(clean(s));
export const noteLine = (text, on) => `Sheet column C (moved ${on}): ${clean(text)}`;
const MOVED = /Sheet column C \(moved \d{4}-\d{2}-\d{2}\): (.*)/g;

/** Shows on weekends from `from` whose column C is more than a status word.
 *  -> { move: [{ id, name, weekend, text, notes }], words: n, already: n }; `notes` is the team notes with the line appended. */
export function planSheetNotes(events, { from, on }) {
  const move = []; let words = 0, already = 0;
  for (const e of events || []) {
    if (!e || !e.weekend || e.weekend < from) continue;
    const text = clean(e.sheetStatus); if (!text) continue;
    if (isStatusWord(text)) { words++; continue; }
    const notes = String(e.notes || '');
    if ([...notes.matchAll(MOVED)].some(m => clean(m[1]) === text)) { already++; continue; }
    move.push({ id: e.id, name: e.name || e.id, weekend: e.weekend, text, notes: notes.trim() ? `${notes.replace(/\s+$/, '')}\n${noteLine(text, on)}` : noteLine(text, on) });
  }
  return { move, words, already };
}
