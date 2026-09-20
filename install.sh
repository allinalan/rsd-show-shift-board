#!/bin/bash
#
# Install the daily tick ON THE MAC MINI. Safe to re-run. Writes the job DISARMED by default.
#
#   ./install.sh            # preflight, install the pre-commit leak check, render the plist to out/ (NOT installed)
#   ./install.sh --arm      # same, then load the job (07:00 daily). Refuses off the mini or on any FAIL.
#   ./install.sh --disarm   # unload the job and remove its plist (kill switch); code and state untouched
#
# Disarmed means there is NO plist in ~/Library/LaunchAgents: launchd loads everything in that
# folder at login, so a plist left there would arm itself on the next reboot.
#   ./install.sh --check    # preflight only
#
set -u
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.allinalan.rsd-board-tick"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$PROJECT/launchd/$LABEL.plist"
ENVF="$HOME/.rsd/board.env"
ok()   { printf "  OK    %s\n" "$1"; }
bad()  { printf "  FAIL  %s\n" "$1"; FAILED=1; }
warn() { printf "  WARN  %s\n" "$1"; }
FAILED=0

if [ "${1:-}" = "--disarm" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "unloaded $LABEL" || echo "$LABEL was not loaded"
  [ -f "$PLIST" ] && rm -f "$PLIST" && echo "removed $PLIST (a plist left there would load itself at the next login)"
  exit 0
fi

echo "rsd-show-shift-board, Mac mini preflight"
echo "project: $PROJECT"
[ "$(hostname)" = "Alans-Mac-mini.local" ] && ok "host is the Mac mini" || bad "host is $(hostname), not the Mac mini. Scheduled jobs run only there."
case "$PROJECT" in "$HOME"/Documents/*|"$HOME"/Desktop/*|"$HOME"/Downloads/*) bad "project is inside a folder launchd cannot read";; *) ok "outside Documents/Desktop/Downloads";; esac
[ -x /usr/local/bin/node ] && ok "node $(/usr/local/bin/node -v) at /usr/local/bin/node" || bad "/usr/local/bin/node missing"
[ -x /usr/bin/python3 ] && ok "/usr/bin/python3 present (the Messages identity)" || bad "/usr/bin/python3 missing"
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

[ "${1:-}" = "--check" ] && exit $FAILED

# the pre-commit hook is worth installing even when the preflight fails: it guards a PUBLIC repo
if [ -d "$PROJECT/.git" ]; then
  printf '#!/bin/bash\n# installed by install.sh: this repo is public; refuse phones, e-mails, contact fields, service keys\nexec /usr/local/bin/node "%s/scripts/check-public.mjs" --staged\n' "$PROJECT" > "$PROJECT/.git/hooks/pre-commit"
  chmod +x "$PROJECT/.git/hooks/pre-commit" && ok "pre-commit leak check installed"
fi

mkdir -p "$PROJECT/logs" "$PROJECT/out"
if [ "${1:-}" != "--arm" ]; then
  sed "s|__PROJECT__|$PROJECT|g" "$TEMPLATE" > "$PROJECT/out/$LABEL.plist"
  plutil -lint "$PROJECT/out/$LABEL.plist" >/dev/null && ok "plist renders and lints (preview: out/$LABEL.plist)" || { bad "plist did not lint"; exit 1; }
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && warn "$LABEL is currently LOADED; this run did not change that (./install.sh --disarm to stop it)"
  [ -f "$PLIST" ] && ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && warn "$PLIST exists but is not loaded: it will load itself at the next login. Run ./install.sh --disarm to remove it."
  echo; echo "NOT INSTALLED: nothing was written to ~/Library/LaunchAgents. Arm with: ./install.sh --arm"
  exit $FAILED
fi
if [ $FAILED -ne 0 ]; then echo; echo "Refusing to arm. Fix the FAIL lines, then re-run."; exit 1; fi
sed "s|__PROJECT__|$PROJECT|g" "$TEMPLATE" > "$PLIST"
plutil -lint "$PLIST" >/dev/null && ok "plist written to $PLIST" || { bad "plist did not lint"; exit 1; }
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST" && ok "loaded $LABEL (daily 07:00)" || bad "launchctl bootstrap failed"
launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && ok "launchd knows $LABEL" || bad "$LABEL not registered"
echo
echo "Verify through launchd (never from a shell):  touch PAUSED; launchctl start $LABEL; tail logs/tick.log; rm PAUSED"
exit $FAILED
