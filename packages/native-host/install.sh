#!/usr/bin/env bash
# Registers (or removes) the savemedia native messaging host manifest for
# Chrome, Chromium, Edge, Brave and Firefox in their per-user directories.
# This script never installs yt-dlp or ffmpeg; it only reports whether they
# are present.
set -euo pipefail

HOST_NAME="com.savemedia.host"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$SCRIPT_DIR/host.py"

EXTENSION_IDS=()
FIREFOX_ID="savemedia@ancplua.dev"
UNINSTALL=0
DRY_RUN=0

usage() {
  cat <<USAGE
Usage: install.sh [--extension-id <id>]... [--firefox-id <id>] [--uninstall] [--dry-run]

  --extension-id <id>  Chromium extension id to allow (repeatable).
                       Default: negbodmpgjhkacmdkbfdpocjanaklifn
  --firefox-id <id>    Firefox extension id. Default: savemedia@ancplua.dev
  --uninstall          Remove previously written manifests.
  --dry-run            Print what would be done without writing.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --extension-id)
      [ $# -ge 2 ] || { echo "--extension-id needs a value" >&2; exit 2; }
      if ! [[ "$2" =~ ^[a-p]{32}$ ]]; then
        echo "invalid Chromium extension id (expected 32 letters a-p): $2" >&2; exit 2
      fi
      EXTENSION_IDS+=("$2"); shift 2 ;;
    --firefox-id)
      [ $# -ge 2 ] || { echo "--firefox-id needs a value" >&2; exit 2; }
      if ! [[ "$2" =~ ^[A-Za-z0-9._@{}-]+$ ]]; then
        echo "invalid Firefox extension id: $2" >&2; exit 2
      fi
      FIREFOX_ID="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ ${#EXTENSION_IDS[@]} -eq 0 ]; then
  EXTENSION_IDS=("negbodmpgjhkacmdkbfdpocjanaklifn")
fi

case "$(uname -s)" in
  Darwin)
    APP_SUPPORT="$HOME/Library/Application Support"
    CHROMIUM_PARENTS=(
      "$APP_SUPPORT/Google/Chrome"
      "$APP_SUPPORT/Chromium"
      "$APP_SUPPORT/Microsoft Edge"
      "$APP_SUPPORT/BraveSoftware/Brave-Browser"
    )
    CHROMIUM_SUBDIR="NativeMessagingHosts"
    FIREFOX_PARENT="$APP_SUPPORT/Mozilla"
    FIREFOX_SUBDIR="NativeMessagingHosts"
    ;;
  Linux)
    CHROMIUM_PARENTS=(
      "$HOME/.config/google-chrome"
      "$HOME/.config/chromium"
      "$HOME/.config/microsoft-edge"
      "$HOME/.config/BraveSoftware/Brave-Browser"
    )
    CHROMIUM_SUBDIR="NativeMessagingHosts"
    FIREFOX_PARENT="$HOME/.mozilla"
    FIREFOX_SUBDIR="native-messaging-hosts"
    ;;
  *)
    echo "unsupported platform: $(uname -s)" >&2
    exit 1
    ;;
esac

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

chromium_manifest() {
  local origins="" id
  for id in "${EXTENSION_IDS[@]}"; do
    [ -n "$origins" ] && origins="$origins,"
    origins="$origins
    \"chrome-extension://$id/\""
  done
  cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "savemedia local downloader host (runs the user's own yt-dlp and ffmpeg)",
  "path": "$(json_escape "$HOST_PATH")",
  "type": "stdio",
  "allowed_origins": [$origins
  ]
}
JSON
}

firefox_manifest() {
  cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "savemedia local downloader host (runs the user's own yt-dlp and ffmpeg)",
  "path": "$(json_escape "$HOST_PATH")",
  "type": "stdio",
  "allowed_extensions": [
    "$FIREFOX_ID"
  ]
}
JSON
}

write_manifest() {
  local parent="$1" subdir="$2" kind="$3"
  local dir="$parent/$subdir" file
  file="$dir/$HOST_NAME.json"
  if [ ! -d "$parent" ]; then
    echo "skip   $file (browser profile directory not present)"
    return
  fi
  if [ "$UNINSTALL" -eq 1 ]; then
    if [ -f "$file" ]; then
      echo "remove $file"
      [ "$DRY_RUN" -eq 1 ] || rm -f "$file"
    else
      echo "absent $file"
    fi
    return
  fi
  echo "write  $file"
  if [ "$DRY_RUN" -eq 1 ]; then
    return
  fi
  mkdir -p "$dir"
  if [ "$kind" = "firefox" ]; then
    firefox_manifest > "$file"
  else
    chromium_manifest > "$file"
  fi
}

if [ "$UNINSTALL" -eq 0 ]; then
  if [ ! -f "$HOST_PATH" ]; then
    echo "host.py not found next to install.sh: $HOST_PATH" >&2
    exit 1
  fi
  [ "$DRY_RUN" -eq 0 ] && chmod +x "$HOST_PATH"
fi

for parent in "${CHROMIUM_PARENTS[@]}"; do
  write_manifest "$parent" "$CHROMIUM_SUBDIR" chromium
done
write_manifest "$FIREFOX_PARENT" "$FIREFOX_SUBDIR" firefox

echo
echo "Tool check (this script does not install anything):"
locate_tool() {
  local name="$1" p
  if p="$(command -v "$name" 2>/dev/null)"; then
    printf '%s' "$p"; return 0
  fi
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME"/Library/Python/*/bin; do
    if [ -x "$d/$name" ]; then printf '%s' "$d/$name"; return 0; fi
  done
  return 1
}
MISSING=0
for tool in yt-dlp ffmpeg; do
  if p="$(locate_tool "$tool")"; then
    echo "  $tool: $p"
  else
    echo "  $tool: not found"
    MISSING=1
  fi
done
if [ "$MISSING" -eq 1 ]; then
  echo
  echo "Install the missing tools yourself, for example:"
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "  brew install yt-dlp ffmpeg"
  else
    echo "  your distribution's package manager (for example apt install ffmpeg) and"
    echo "  python3 -m pip install --user yt-dlp"
  fi
fi
