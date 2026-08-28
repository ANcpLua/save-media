#!/usr/bin/env python3
"""Native messaging host — yt-dlp bridge for Save Media extension."""

import json, struct, subprocess, sys, os, glob
from datetime import datetime

YTDLP = '/opt/homebrew/bin/yt-dlp'
FFMPEG = '/opt/homebrew/bin/ffmpeg'
LOG = os.path.expanduser('~/Downloads/save-media-debug.log')
OUT = os.path.expanduser('~/Downloads')

QUALITY = {
    'best': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '1080': 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]/best',
    '720':  'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]/best',
    '480':  'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]/best',
}

def log(msg):
    with open(LOG, 'a') as f:
        f.write(f"[{datetime.now().isoformat()}] {msg}\n")

def read_msg():
    raw = sys.stdin.buffer.read(4)
    if not raw: return None
    return json.loads(sys.stdin.buffer.read(struct.unpack('=I', raw)[0]))

def send(msg):
    log(f"RESPONSE: {json.dumps(msg)}")
    data = json.dumps(msg).encode()
    sys.stdout.buffer.write(struct.pack('=I', len(data)) + data)
    sys.stdout.buffer.flush()

def main():
    msg = read_msg()
    log(f"REQUEST: {json.dumps(msg)}")
    if not msg or 'url' not in msg:
        return send({'success': False, 'error': 'No URL'})

    # Clean stale partials
    for f in glob.glob(os.path.join(OUT, '*.part*')):
        try: os.remove(f)
        except OSError: pass

    fmt = QUALITY.get(msg.get('quality', 'best'), QUALITY['best'])
    cmd = [
        YTDLP, '--downloader', 'ffmpeg', '--ffmpeg-location', FFMPEG,
        '--hls-use-mpegts', '--no-continue', '--cookies-from-browser', 'edge',
        '-f', fmt, '-o', '%(title).80s [%(id)s].%(ext)s', '-P', OUT, msg['url']
    ]
    log(f"CMD: {' '.join(cmd)}")

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        log(f"EXIT: {r.returncode}\nSTDERR: {r.stderr}")
        send({'success': r.returncode == 0, 'output': r.stdout or r.stderr})
    except FileNotFoundError:
        send({'success': False, 'error': 'yt-dlp not found — brew install yt-dlp'})
    except subprocess.TimeoutExpired:
        send({'success': False, 'error': 'Timeout (10min)'})

if __name__ == '__main__':
    main()
