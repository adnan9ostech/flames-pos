#!/bin/bash
# Installs the print agent as a launchd job, so the till's printer works after
# a reboot without anyone remembering to start anything.
#
#   bash scripts/print/install-agent-service.sh                    # the till
#   ROLE=kitchen bash scripts/print/install-agent-service.sh        # the KDS machine
#   bash scripts/print/install-agent-service.sh --uninstall         # remove
#
# NO PRINTER NAME HERE, deliberately. The agent is installed with what it is
# FOR — receipt or kitchen — and looks up which printer to use in the database,
# where the Settings screen writes it. That is the whole difference between
# "set this machine up at a shell prompt, again" and "pick it from a list".
#
# A machine with one obvious thermal printer and nothing configured yet finds
# it by itself, so a fresh till prints before anybody opens Settings at all.
#
# A LaunchAgent (per-user, ~/Library/LaunchAgents), NOT a LaunchDaemon: the
# agent talks to CUPS as the logged-in user and binds 127.0.0.1 only, so it
# needs no root and nothing global. That matters on the shared cPanel box rule
# this project follows — per-vhost, per-user, nothing system-wide.
#
# KeepAlive restarts it if it dies mid-service; RunAtLoad starts it at login.
set -euo pipefail

# One job per role: installing the kitchen agent must not replace the till's.
LABEL="com.flamesbytheindus.printagent.${ROLE:-receipt}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    exit 0
fi

ROLE="${ROLE:-receipt}"
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
        <string>--role</string><string>$ROLE</string>
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
echo "  role  : $ROLE  (port $PORT, DB $DB)"
echo "  printer: chosen under Settings, Kitchen & Printer — or found automatically"
echo "  logs  : $LOGDIR/$LABEL.log"
echo "  stop  : bash scripts/print/install-agent-service.sh --uninstall"
