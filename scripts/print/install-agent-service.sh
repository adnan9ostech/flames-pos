#!/bin/bash
# Installs the print agent as a launchd job, so the till's printer works after
# a reboot without anyone remembering to start anything.
#
#   bash scripts/print/install-agent-service.sh                    # install + start
#   bash scripts/print/install-agent-service.sh --uninstall        # remove
#   QUEUE=Other_Printer WIDTH=58 bash scripts/print/install-agent-service.sh
#
# A LaunchAgent (per-user, ~/Library/LaunchAgents), NOT a LaunchDaemon: the
# agent talks to CUPS as the logged-in user and binds 127.0.0.1 only, so it
# needs no root and nothing global. That matters on the shared cPanel box rule
# this project follows — per-vhost, per-user, nothing system-wide.
#
# KeepAlive restarts it if it dies mid-service; RunAtLoad starts it at login.
set -euo pipefail

LABEL="com.flamesbytheindus.printagent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    exit 0
fi

QUEUE="${QUEUE:-PrinterCMD_ESCPO_POS80_Printer_USB}"
WIDTH="${WIDTH:-80}"
PORT="${PORT:-9110}"
DB="${DB_NAME:-flames_pos_dev}"
NODE="$(command -v node)"
LOGDIR="$HOME/Library/Logs"

if [[ -z "$NODE" ]]; then echo "node not found on PATH" >&2; exit 1; fi
mkdir -p "$(dirname "$PLIST")" "$LOGDIR"

cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$ROOT/scripts/print-agent.mjs</string>
        <string>--queue</string><string>$QUEUE</string>
        <string>--width</string><string>$WIDTH</string>
        <string>--port</string><string>$PORT</string>
    </array>
    <key>WorkingDirectory</key><string>$ROOT</string>
    <key>EnvironmentVariables</key>
    <dict><key>DB_NAME</key><string>$DB</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOGDIR/$LABEL.log</string>
    <key>StandardErrorPath</key><string>$LOGDIR/$LABEL.err.log</string>
</dict>
</plist>
PLIST_END

# bootout first so a re-run is a clean reinstall rather than a "already loaded".
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "installed $LABEL"
echo "  queue : $QUEUE  (${WIDTH}mm, port $PORT, DB $DB)"
echo "  logs  : $LOGDIR/$LABEL.log"
echo "  stop  : bash scripts/print/install-agent-service.sh --uninstall"
