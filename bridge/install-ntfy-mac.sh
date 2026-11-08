#!/bin/zsh
# Always-on: shows every ntfy message on this Mac as a macOS notification, started at login, restarted if it dies.
# Install: bridge/install-ntfy-mac.sh    Undo: bridge/install-ntfy-mac.sh remove
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"; LABEL=com.firetv.ntfy-mac; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ "$1" == remove ]]; then launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo removed; exit 0; fi
mkdir -p "$DIR/logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$(which bun)</string><string>$DIR/bridge/ntfy-mac.ts</string></array>
<key>WorkingDirectory</key><string>$DIR</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DIR/logs/ntfy-mac.log</string><key>StandardErrorPath</key><string>$DIR/logs/ntfy-mac.log</string>
</dict></plist>
P
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
echo "installed: ntfy messages now pop up as Mac notifications"
