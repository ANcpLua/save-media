#!/usr/bin/env bash
# One-line setup for the savemedia local downloader helper.
#
#   curl -fsSL https://raw.githubusercontent.com/ANcpLua/save-media/main/packages/native-host/setup.sh \
#     | bash -s -- --extension-id <id>
#
# Downloads host.py and install.sh into a per-user directory and registers the
# helper for the browsers on this machine. It does not install yt-dlp or
# ffmpeg; it tells you how if they are missing.
set -euo pipefail

BASE_URL="${SAVEMEDIA_HOST_BASE_URL:-https://raw.githubusercontent.com/ANcpLua/save-media/main/packages/native-host}"

case "$(uname -s)" in
  Darwin) TARGET="$HOME/Library/Application Support/savemedia/native-host" ;;
  *)      TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/savemedia/native-host" ;;
esac

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required (macOS: xcode-select --install, or brew install python)." >&2
  exit 1
fi

mkdir -p "$TARGET"
for f in host.py install.sh; do
  curl -fsSL "$BASE_URL/$f" -o "$TARGET/$f.tmp"
  mv "$TARGET/$f.tmp" "$TARGET/$f"
done
chmod +x "$TARGET/host.py" "$TARGET/install.sh"

echo "Helper files in: $TARGET"
"$TARGET/install.sh" "$@"

missing=()
for tool in yt-dlp ffmpeg; do
  if ! command -v "$tool" >/dev/null 2>&1 && [ ! -x "/opt/homebrew/bin/$tool" ] && [ ! -x "/usr/local/bin/$tool" ]; then
    missing+=("$tool")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo
  echo "Still needed: ${missing[*]}"
  if command -v brew >/dev/null 2>&1; then
    echo "  brew install ${missing[*]}"
  else
    echo "  Install Homebrew from https://brew.sh, then: brew install ${missing[*]}"
  fi
fi
echo
echo "Done. Reopen the savemedia popup; the Local downloader row should say Ready."
