"""Shared helpers of the Telegram post scripts (crypto-telegram-ops sections 1, 6, 7). Standard library only: these run on
the release server as a one-off, next to release.env.

Rules enforced here:
  - The bot token is read from the root env file (release.env, KEY=value lines, parsed, never sourced) and goes to curl
    only inside a curl config on stdin (`curl -K -`). It is never on a command line, never in a log, never printed.
  - Text messages stay under 3,800 characters (Telegram's limit is 4,096); photo captions under 1,024.
  - --dry-run prints what would be sent and reads no token.
"""
import json, os, re, subprocess, sys
from urllib.parse import urlparse

TEXT_LIMIT = 3800
CAPTION_LIMIT = 1024
DEFAULT_ENV = "/etc/lemniscate-release/release.env"
CHAT_KEYS = {"ops": "TELEGRAM_OPS_CHAT_ID", "community": "TELEGRAM_COMMUNITY_CHAT_ID"}


def die(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(2)


def read_env_value(path, key):
    """The last KEY=value in an env file (quotes and CR stripped), or ''."""
    value = ""
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(key + "="):
                    value = line[len(key) + 1:].strip().strip("'\"")
    except OSError as error:
        die(f"cannot read {path}: {error.strerror}")
    return value


def api_base():
    """https://api.telegram.org, or a LOCAL fake for tests: any other override is refused so the token cannot be sent to
    a host an environment variable pointed at."""
    base = os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org").rstrip("/")
    parsed = urlparse(base)
    local = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
    if base != "https://api.telegram.org" and not local:
        die("TELEGRAM_API_BASE may only be https://api.telegram.org or a local http://127.0.0.1 test server")
    return base


def split_text(text, limit=TEXT_LIMIT):
    """Pieces of at most `limit` characters, cut at blank lines, then line ends, then spaces (never inside a word)."""
    pieces, rest = [], text.strip("\n")
    while len(rest) > limit:
        cut = max(rest.rfind("\n\n", 0, limit), -1)
        if cut < limit // 3:
            cut = rest.rfind("\n", 0, limit)
        if cut < limit // 3:
            cut = rest.rfind(" ", 0, limit)
        if cut <= 0:
            cut = limit
        pieces.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip("\n ")
    if rest:
        pieces.append(rest)
    return pieces


def _curl_quote(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + '"'


class Sender:
    def __init__(self, chat, env_file, dry_run):
        if chat not in CHAT_KEYS:
            die("--chat must be ops or community")
        self.chat, self.dry_run, self.token, self.chat_id = chat, dry_run, "", ""
        self.sent = 0
        if dry_run:
            return
        self.token = read_env_value(env_file, "TELEGRAM_BOT_TOKEN")
        self.chat_id = read_env_value(env_file, CHAT_KEYS[chat])
        if chat == "ops" and not self.chat_id:
            self.chat_id = read_env_value(env_file, "TELEGRAM_CHAT_ID")
        if not self.token:
            die(f"no TELEGRAM_BOT_TOKEN in {env_file} (run save-telegram-token.sh)")
        if not self.chat_id:
            die(f"no {CHAT_KEYS[chat]} in {env_file} (run find-telegram-chat-id.sh)")

    def _call(self, method, fields, files=None):
        """POST through `curl -K -`: the config (URL with the token, every field) travels on stdin only."""
        lines = [f"url = {_curl_quote(f'{api_base()}/bot{self.token}/{method}')}"]
        lines.append(f"form-string = {_curl_quote('chat_id=' + self.chat_id)}")
        for name, value in fields.items():
            lines.append(f"form-string = {_curl_quote(f'{name}={value}')}")
        for name, path in (files or {}).items():
            lines.append(f"form = {_curl_quote(f'{name}=@{path}')}")
        lines += ["silent", "show-error", "max-time = 60"]
        result = subprocess.run(["curl", "-K", "-"], input="\n".join(lines) + "\n", capture_output=True, text=True)
        out = (result.stdout + result.stderr).replace(self.token, "<token>")
        try:
            reply = json.loads(result.stdout)
        except ValueError:
            die(f"{method} failed: {out[:300]}")
        if not reply.get("ok"):
            die(f"{method} refused by Telegram: {str(reply.get('description', out))[:300].replace(self.token, '<token>')}")
        self.sent += 1

    def message(self, text):
        assert len(text) <= TEXT_LIMIT, "message over the limit"
        if self.dry_run:
            print(f"--- would send message to {self.chat} ({len(text)} chars) ---\n{text}\n")
            return
        self._call("sendMessage", {"text": text, "disable_web_page_preview": "true"})

    def photo(self, path, caption):
        assert len(caption) <= CAPTION_LIMIT, "caption over the limit"
        if self.dry_run:
            print(f"--- would send photo {path} to {self.chat}, caption {len(caption)} chars ---\n{caption}\n")
            return
        fields = {"caption": caption} if caption else {}
        self._call("sendPhoto", fields, {"photo": path})

    def media_group(self, paths, caption):
        assert 2 <= len(paths) <= 10 and len(caption) <= CAPTION_LIMIT
        if self.dry_run:
            print(f"--- would send album of {len(paths)} photos to {self.chat}, caption {len(caption)} chars ---")
            for p in paths:
                print(f"  {p}")
            print(caption + "\n")
            return
        media = [{"type": "photo", "media": f"attach://p{i}"} for i in range(len(paths))]
        if caption:
            media[0]["caption"] = caption
        self._call("sendMediaGroup", {"media": json.dumps(media)}, {f"p{i}": p for i, p in enumerate(paths)})


def env_file_arg(value):
    return value or os.environ.get("RELEASE_ENV", DEFAULT_ENV)


UPDATE_HEADER = re.compile(r"^UPDATE (\d+) · .*? · (.+)$")
