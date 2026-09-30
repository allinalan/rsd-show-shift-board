#!/bin/bash
#
# Install the board's two jobs ON THE MAC MINI. Safe to re-run. Writes them DISARMED by default.
#   com.allinalan.rsd-board-tick   07:00 daily: decides what is due, notifies Alan (deploy/tick.py)
#   com.allinalan.rsd-board-sync   every 30 s: the board's "Sync from the Sheet" button (scripts/sync-requests.mjs)
#
#   ./install.sh            # preflight, install the pre-commit leak check, render the plists to out/ (NOT installed)
#   ./install.sh --arm      # same, then load both jobs. Refuses off the mini or on any FAIL.
#   ./install.sh --disarm   # unload both jobs and remove their plists (kill switch); code and state untouched
#
# Disarmed means there is NO plist in ~/Library/LaunchAgents: launchd loads everything in that
# folder at login, so a plist left there would arm itself on the next reboot.
#   ./install.sh --check    # preflight only
#
set -u
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABELS="com.allinalan.rsd-board-tick com.allinalan.rsd-board-sync"
ENVF="$HOME/.rsd/board.env"
ok()   { printf "  OK    %s\n" "$1"; }
bad()  { printf "  FAIL  %s\n" "$1"; FAILED=1; }
warn() { printf "  WARN  %s\n" "$1"; }
FAILED=0

if [ "${1:-}" = "--disarm" ]; then
  for LABEL in $LABELS; do
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "unloaded $LABEL" || echo "$LABEL was not loaded"
    [ -f "$PLIST" ] && rm -f "$PLIST" && echo "removed $PLIST (a plist left there would load itself at the next login)"
  done
  exit 0
fi

echo "rsd-show-shift-board, Mac mini preflight"
echo "project: $PROJECT"
[ "$(hostname)" = "Alans-Mac-mini.local" ] && ok "host is the Mac mini" || bad "host is $(hostname), not the Mac mini. Scheduled jobs run only there."
case "$PROJECT" in "$HOME"/Documents/*|"$HOME"/Desktop/*|"$HOME"/Downloads/*) bad "project is inside a folder launchd cannot read";; *) ok "outside Documents/Desktop/Downloads";; esac
[ -x /usr/local/bin/node ] && ok "node $(/usr/local/bin/node -v) at /usr/local/bin/node" || bad "/usr/local/bin/node missing"
[ -x /usr/bin/python3 ] && ok "/usr/bin/python3 present (the mailroom check)" || bad "/usr/bin/python3 missing"
# The tick starts from the pinned interpreter (__PY__ in its plist): one file with one name, so macOS privacy
# (TCC) cannot judge it as git or make the way it judged /usr/bin/python3 on 2026-09-30
# (~/ai-system/claude/shared/messages-tcc.md). Rollback, no file edits:
#   MESSAGES_PY=/usr/bin/python3 MESSAGES_ROLLBACK=1 ./install.sh --arm
MSG_LIB="$HOME/ai-system/lib/messages"
PY="${MESSAGES_PY:-$(head -1 "$MSG_LIB/INTERPRETER" 2>/dev/null)}"
ROLLBACK_ENV=""
if [ "${MESSAGES_ROLLBACK:-}" = 1 ]; then
  if [ -x "$PY" ]; then
    ROLLBACK_ENV="<key>MESSAGES_ROLLBACK</key><string>1</string>"
    warn "ROLLBACK: the tick will start from $PY without the interpreter check (undo: re-run without MESSAGES_ROLLBACK)"
  else bad "rollback interpreter '$PY' is not executable"; fi
elif [ ! -f "$MSG_LIB/check.sh" ]; then
  bad "$MSG_LIB is missing: git -C ~/ai-system pull"
elif MSG_CHECK="$(bash "$MSG_LIB/check.sh" "$PY")"; then
  ok "the tick's interpreter (the Messages identity): $MSG_CHECK"
else
  bad "$MSG_CHECK"
fi
/usr/bin/security find-generic-password -s csp-slack-webhook -a csp-autopilot >/dev/null 2>&1 && ok "Keychain csp-slack-webhook / csp-autopilot" || bad "Keychain item csp-slack-webhook / csp-autopilot missing (failure alerts need it)"
if [ -f "$ENVF" ]; then
  [ "$(stat -f %Lp "$ENVF")" = "600" ] && ok "$ENVF is mode 600" || bad "$ENVF must be mode 600 (chmod 600 $ENVF)"
  for k in BOARD_SUPABASE_URL BOARD_SERVICE_KEY; do grep -q "^$k=." "$ENVF" && ok "$k is set" || bad "$k is missing from $ENVF"; done
  grep -q "^BOARD_ALAN_IMESSAGE=." "$ENVF" && ok "BOARD_ALAN_IMESSAGE is set" || warn "BOARD_ALAN_IMESSAGE is not set: due notices will reach Slack only"
else
  bad "$ENVF does not exist (Alan creates it; see docs/HANDOFF.md step 2)"
fi
[ -f "$PROJECT/seed/private/event_contacts.json" ] && ok "private contacts seed present" || warn "seed/private/event_contacts.json is absent (only matters before the first seed)"
TZNAME="$(readlink /etc/localtime | sed 's|.*/zoneinfo/||')"; [ "$TZNAME" = "America/Phoenix" ] && ok "clock is $TZNAME" || bad "clock is $TZNAME, expected America/Phoenix"
(cd "$PROJECT" && /usr/local/bin/node scripts/check-public.mjs >/dev/null 2>&1) && ok "public-repo leak check is clean" || bad "leak check found something (node scripts/check-public.mjs)"
(cd "$PROJECT" && /usr/local/bin/node tests/run-all.mjs >/dev/null 2>&1) && ok "unit tests pass" || bad "unit tests fail (node tests/run-all.mjs)"
# the Sync button's listener runs the Sheet sync, which reads the xlsx with a sibling project's SheetJS
XLSX="$(cd "$PROJECT" && /usr/local/bin/node --input-type=module -e "import {XLSX_PATHS} from './scripts/parse-sheet.mjs'; import fs from 'fs'; console.log(XLSX_PATHS.find(p => fs.existsSync(p)) || '')" 2>/dev/null)"
[ -n "$XLSX" ] && ok "SheetJS for the Sheet sync: $XLSX" || bad "no SheetJS in any sibling project (scripts/parse-sheet.mjs XLSX_PATHS): the Sheet sync cannot read the Sheet"
# ...and the button's requests live in sheet_syncs (supabase/schema.sql, 2026-09-28). A read with the service key; writes nothing.
SYNCS="$(cd "$PROJECT" && /usr/local/bin/node --input-type=module -e "import {boardApi} from './scripts/lib/board-api.mjs'; const r = await boardApi().syncs.open(); console.log('ok ' + r.length)" 2>&1 | tail -1)"
case "$SYNCS" in "ok "*) ok "sheet_syncs table reachable (${SYNCS#ok } open request(s))";; *) bad "sheet_syncs not reachable: run supabase/schema.sql in the Supabase SQL editor (${SYNCS:0:160})";; esac
# Coordinator e-mails from a board session go through the shared mailroom (CLAUDE.md). Its check sends
# nothing. A WARN, never a FAIL: the daily tick does not e-mail, so this must not block arming.
MAILROOM="$HOME/ai-system/lib/mailroom/gmail_send.py"
if [ -f "$MAILROOM" ]; then
  MR="$(/usr/bin/python3 "$MAILROOM" check 2>&1 | tail -1)"
  case "$MR" in "Gmail sender: ok"*) ok "mailroom ready for coordinator e-mails (its check sends nothing)";; *) warn "mailroom not ready, coordinator e-mails would fail: ${MR#Gmail sender: }";; esac
else warn "mailroom not found at $MAILROOM (git -C ~/ai-system pull): coordinator e-mails have no sanctioned path until it is"; fi

[ "${1:-}" = "--check" ] && exit $FAILED

# the pre-commit hook is worth installing even when the preflight fails: it guards a PUBLIC repo
if [ -d "$PROJECT/.git" ]; then
  printf '#!/bin/bash\n# installed by install.sh: this repo is public; refuse phones, e-mails, contact fields, service keys\nexec /usr/local/bin/node "%s/scripts/check-public.mjs" --staged\n' "$PROJECT" > "$PROJECT/.git/hooks/pre-commit"
  chmod +x "$PROJECT/.git/hooks/pre-commit" && ok "pre-commit leak check installed"
fi

mkdir -p "$PROJECT/logs" "$PROJECT/out"
render() {   # the plist template with __PROJECT__, __PY__ and (rolling back) MESSAGES_ROLLBACK filled in
  sed -e "s|<key>MESSAGES_PY</key><string>__PY__</string>|&$ROLLBACK_ENV|" -e "s|__PROJECT__|$PROJECT|g" \
      -e "s|__PY__|$PY|g" "$PROJECT/launchd/$1.plist"
}
if [ "${1:-}" != "--arm" ]; then
  for LABEL in $LABELS; do
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    render "$LABEL" > "$PROJECT/out/$LABEL.plist"
    plutil -lint "$PROJECT/out/$LABEL.plist" >/dev/null && ok "plist renders and lints (preview: out/$LABEL.plist)" || { bad "$LABEL plist did not lint"; exit 1; }
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && warn "$LABEL is currently LOADED; this run did not change that (./install.sh --disarm to stop it)"
    [ -f "$PLIST" ] && ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && warn "$PLIST exists but is not loaded: it will load itself at the next login. Run ./install.sh --disarm to remove it."
  done
  echo; echo "NOT INSTALLED: nothing was written to ~/Library/LaunchAgents. Arm with: ./install.sh --arm"
  exit $FAILED
fi
if [ $FAILED -ne 0 ]; then echo; echo "Refusing to arm. Fix the FAIL lines, then re-run."; exit 1; fi
for LABEL in $LABELS; do
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  render "$LABEL" > "$PLIST"
  plutil -lint "$PLIST" >/dev/null && ok "plist written to $PLIST" || { bad "$LABEL plist did not lint"; exit 1; }
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && ok "loaded $LABEL" || bad "launchctl bootstrap failed for $LABEL"
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && ok "launchd knows $LABEL" || bad "$LABEL not registered"
done
echo
echo "Verify through launchd (never from a shell):"
echo "  tick:  touch PAUSED; launchctl start com.allinalan.rsd-board-tick; tail logs/tick.log; rm PAUSED"
echo "  sync:  press Sync from the Sheet on the board (Plan mode), then tail logs/sync-requests.log"
exit $FAILED
