"""Pull a public HTTPS response over the desktop connection for browser validation."""

import base64
import ipaddress
import json
import os
import re
import shutil
import subprocess
import threading
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit

CHUNK_SIZE = 192 * 1024
MAX_BYTES = 2 * 1024 * 1024 * 1024  # Matches the browser's Blob limit.
MAX_HEADER_BYTES = 64 * 1024
DNS_SERVER = "https://cloudflare-dns.com/dns-query"
MEDIA_HEADERS = {"content-type", "content-length", "content-range", "content-disposition",
                 "content-encoding", "accept-ranges", "etag", "last-modified", "retry-after"}


class FileError(Exception):
    """Safe user-facing messages only."""
    code = "network"


class InsecureMediaRedirect(FileError):
    code = "insecure_media_redirect"


def public_address(value):
    try:
        addr = ipaddress.ip_address(value)
    except ValueError:
        return None
    if not addr.is_global or addr.is_multicast or addr.is_reserved or addr.is_unspecified:
        return None
    if addr.version == 6 and (addr.ipv4_mapped or addr.sixtofour or addr.teredo
                              or addr not in ipaddress.ip_network("2000::/3")):
        return None
    return str(addr)


def check_url(value):
    if not isinstance(value, str) or len(value) > 16384 or re.search(r'[\x00-\x20\x7f\\"]', value):
        raise FileError("Invalid file address.")
    try:
        u = urlsplit(value)
        if u.scheme != "https" or u.username is not None or u.password is not None or not u.hostname:
            raise FileError("Local connections need a public HTTPS address.")
        name = u.hostname.encode("idna").decode("ascii").lower()
        port = u.port if u.port is not None else 443
        if not 1 <= port <= 65535 or "%" in name:
            raise FileError("Invalid file server address.")
        literal = public_address(name)
        if not literal:
            if (len(name) > 253 or not re.fullmatch(
                r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}", name)
                or name.endswith((".local", ".localhost", ".internal", ".onion", ".arpa"))):
                raise FileError("Local connections need a public file server.")
        authority = ("[" + name + "]") if ":" in name else name
        if port != 443:
            authority += ":" + str(port)
        return urlunsplit(("https", authority, u.path or "/", u.query, "")), name, port, literal
    except (UnicodeError, ValueError):
        raise FileError("Invalid file address.") from None


def read_headers(stream):
    remaining = MAX_HEADER_BYTES
    def line():
        nonlocal remaining
        data = stream.readline(remaining + 1)
        remaining -= len(data)
        if remaining < 0 or not data.endswith(b"\n"):
            raise FileError("The file server sent incomplete response headers.")
        return data.rstrip(b"\r\n")
    while True:
        status_line = line()
        match = re.fullmatch(rb"HTTP/\d+(?:\.\d+)? ([1-5][0-9]{2})(?: [^\r\n]*)?", status_line)
        if not match:
            raise FileError("The file server did not send an HTTP response.")
        status = int(match.group(1))
        fields = {}
        while True:
            data = line()
            if not data:
                break
            key, sep, value = data.partition(b":")
            name = key.decode("ascii", "ignore").lower()
            if sep and (name == "location" or name in MEDIA_HEADERS):
                field = value.strip().decode("latin-1")
                if any(ord(c) < 32 or ord(c) == 127 for c in field):
                    raise FileError("Invalid response header.")
                if name in fields and fields[name] != field and name in ("location", "content-length", "content-range"):
                    raise FileError("Conflicting response headers.")
                fields[name] = field
        if status >= 200:
            return status, fields


class FileRead(threading.Thread):
    def __init__(self, message, send):
        super().__init__(daemon=True, name="local-file-read")
        self.message = message
        self.request_id = message["id"]
        self.send = send
        self.stop_event = threading.Event()
        self.pull_event = threading.Event()
        self.lock = threading.Lock()
        self.process = None
        self.curl = "/usr/bin/curl" if os.path.isfile("/usr/bin/curl") else shutil.which("curl")

    def cancel(self):
        self.stop_event.set()
        self.pull_event.set()
        with self.lock:
            if self.process and self.process.poll() is None:
                self.process.kill()

    def emit(self, kind, **fields):
        if not self.stop_event.is_set():
            self.send(dict(type=kind, id=self.request_id, **fields))

    def start_curl(self, url, options, size_limit):
        if not self.curl:
            raise FileError("System curl is unavailable.")
        with self.lock:
            if self.stop_event.is_set():
                raise FileError("Download cancelled.")
            # The URL goes over stdin, keeping its query out of the process list.
            proc = subprocess.Popen([self.curl, "--disable", "--silent", "--noproxy", "*",
                "--globoff", "--proto", "=https", "--connect-timeout", "15", "--max-time", "600",
                "--max-filesize", str(size_limit), *options, "--config", "-"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.process = proc
        proc.stdin.write(('url = "' + url + '"\n').encode())
        proc.stdin.close()
        return proc

    def close_process(self):
        with self.lock:
            proc, self.process = self.process, None
        if proc:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
            proc.stdout.close()

    def resolve(self, name):
        addresses = []
        for record, code in [("A", 1), ("AAAA", 28)]:
            url = DNS_SERVER + "?" + urlencode({"name": name, "type": record})
            proc = self.start_curl(url, ["--fail", "--max-time", "8", "--header", "Accept: application/dns-json",
                "--resolve", "cloudflare-dns.com:443:1.1.1.1,1.0.0.1"], MAX_HEADER_BYTES)
            try:
                raw = proc.stdout.read(MAX_HEADER_BYTES + 1)
                if len(raw) <= MAX_HEADER_BYTES and proc.wait() == 0:
                    for item in json.loads(raw).get("Answer") or []:
                        if item.get("type") == code:
                            ip = public_address(item.get("data", ""))
                            if ip:
                                addresses.append(("[" + ip + "]") if ":" in ip else ip)
            finally:
                self.close_process()
        if not addresses:
            raise FileError("Couldn’t resolve a public address for the file server.")
        return list(dict.fromkeys(addresses))

    def run(self):
        try:
            self.transfer()
        except FileError as e:
            self.emit("failed", code=e.code, message=str(e))
        except (OSError, ValueError, TypeError, AttributeError):
            self.emit("failed", code="network", message="The local connection could not read the response.")
        finally:
            self.close_process()

    def transfer(self):
        url = self.message.get("url")
        headers = ["--include", "--header", "Accept-Encoding: identity"]
        referrer = self.message.get("referrer")
        if referrer:
            try:
                safe, _, _, _ = check_url(referrer)
            except FileError:
                safe = None  # A local or insecure page's address stays on the computer.
            if safe:
                headers.extend(["--referer", "https://" + urlsplit(safe).netloc + "/"])
        for key, pattern, label in [("range", r"bytes=[0-9]{1,20}-[0-9]{1,20}", "Range"),
                                    ("ifRange", r'[\x20-\x7e]{1,256}', "If-Range")]:
            if key in self.message:
                v = self.message[key]
                if not isinstance(v, str) or not re.fullmatch(pattern, v):
                    raise FileError("Invalid byte range request.")
                headers.extend(["--header", label + ": " + v])
        for _ in range(9):
            url, name, port, literal = check_url(url)
            options = headers.copy()
            if not literal:
                # Pin exactly the validated DoH answers while curl verifies the
                # original hostname. Re-resolve and validate every redirect.
                options.extend(["--resolve", name + ":" + str(port) + ":" + ",".join(self.resolve(name))])
            proc = self.start_curl(url, options, MAX_BYTES)
            try:
                status, fields = read_headers(proc.stdout)
            except FileError:
                code = proc.poll()
                if code in (51, 60):
                    raise FileError("The local connection couldn’t verify the file server’s certificate.") from None
                if code in (6, 7, 28):
                    raise FileError("The file server could not be reached through the local connection.") from None
                raise
            location = fields.pop("location", None)
            if status in (301, 302, 303, 307, 308) and location:
                self.close_process()
                url = urljoin(url, location)
                if urlsplit(url).scheme == "http":
                    raise InsecureMediaRedirect("The HTTPS file link redirected to HTTP.")
                continue
            self.emit("file-headers", url=url, status=status, headers=fields)
            total = 0
            while not self.stop_event.is_set():
                if not self.pull_event.wait(60):
                    raise FileError("The browser stopped reading the file.")
                self.pull_event.clear()
                if self.stop_event.is_set():
                    return
                chunk = proc.stdout.read(CHUNK_SIZE)
                if not chunk:
                    if proc.wait() != 0:
                        raise FileError("The local file transfer was interrupted.")
                    self.emit("file-end")
                    return
                total += len(chunk)
                if total > MAX_BYTES:
                    raise FileError("The file exceeds the browser download limit.")
                self.emit("file-chunk", data=base64.b64encode(chunk).decode("ascii"))
            return
        raise FileError("The file server redirected too many times.")
