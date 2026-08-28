#!/bin/bash
set -e

EXT_ID="mkaihgbpnceofjckoaleeenocanbmbeh"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/host.py"
MANIFEST_NAME="com.savemedia.host"
EDGE_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"

chmod +x "$HOST_PATH"
mkdir -p "$EDGE_DIR"

cat > "$EDGE_DIR/$MANIFEST_NAME.json" << EOF
{
  "name": "$MANIFEST_NAME",
  "description": "Save Media — yt-dlp bridge",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "Done. Native host installed."
