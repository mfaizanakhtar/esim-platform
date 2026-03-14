#!/usr/bin/env bash
# ensure-auth.sh — Check Railway auth; open a Terminal window to login if needed.
# Usage: source this or call it; exits 1 if auth cannot be established.

set -euo pipefail

# Already logged in?
if railway whoami &>/dev/null; then
  echo "✅ Railway: logged in as $(railway whoami 2>/dev/null)"
  exit 0
fi

echo "⚠️  Railway: not logged in."
echo "   Opening a Terminal window for 'railway login'..."
echo "   Complete the browser auth, then come back — this script will wait."
echo ""

# Open a new Terminal window that runs railway login (macOS only)
if [[ "$(uname)" == "Darwin" ]] && command -v osascript &>/dev/null; then
  osascript <<'APPLESCRIPT'
tell application "Terminal"
  activate
  do script "echo '🚂 Railway Login' && railway login && echo '✅ Done — you can close this window.'"
end tell
APPLESCRIPT
else
  echo "   Run 'railway login' in another terminal, then return here."
fi

# Poll until auth succeeds (max 120s)
for i in $(seq 1 24); do
  sleep 5
  if railway whoami &>/dev/null; then
    echo "✅ Railway: logged in as $(railway whoami 2>/dev/null)"
    exit 0
  fi
  echo "   [${i}] Waiting for login... ($(( i * 5 ))s)"
done

echo "❌ Railway login timed out after 120s. Run 'railway login' manually and retry."
exit 1
