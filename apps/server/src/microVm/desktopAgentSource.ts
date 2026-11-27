export const DESKTOP_AGENT_GUEST_PORT = 9223;

/**
 * Minimal guest-side controller for a desktop microVM. It speaks HTTP on
 * loopback only; the host reaches it through a published loopback port and
 * authenticates with the per-VM token written by the runtime.
 */
export const DESKTOP_AGENT_SOURCE = String.raw`#!/usr/bin/env python3
import base64
import json
import os
import re
import socket
import socketserver
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = ""
try:
    with open("/etc/erebus-agent-token", "r", encoding="utf-8") as token_file:
        TOKEN = token_file.read().strip()
except OSError:
    TOKEN = ""

DISPLAY = os.environ.get("DISPLAY", ":1")
ENV = dict(os.environ, DISPLAY=DISPLAY)
SCREENSHOT_PATH = "/tmp/erebus-screen.png"


def run(args, timeout=20):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=ENV)


def fail(message):
    raise RuntimeError(message)


def display_size():
    result = run(["xdotool", "getdisplaygeometry"])
    parts = result.stdout.split()
    if len(parts) >= 2:
        try:
            return int(parts[0]), int(parts[1])
        except ValueError:
            pass
    return 0, 0


def capture():
    result = run(["scrot", "-o", "-q", "85", SCREENSHOT_PATH])
    if result.returncode != 0:
        fail(result.stderr.strip() or "scrot could not capture the display")
    with open(SCREENSHOT_PATH, "rb") as image_file:
        data = image_file.read()
    width, height = display_size()
    return {
        "mimeType": "image/png",
        "data": base64.b64encode(data).decode("ascii"),
        "width": width,
        "height": height,
        "scaleX": 1,
        "scaleY": 1,
    }


def window_id(value):
    try:
        return int(str(value), 16)
    except (TypeError, ValueError):
        return None


def active_window_id():
    result = run(["xdotool", "getactivewindow"])
    if result.returncode != 0:
        return None
    try:
        return int(result.stdout.strip())
    except ValueError:
        return None


def windows():
    active = active_window_id()
    result = run(["wmctrl", "-l"])
    rows = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        identifier, desktop, _host, title = parts
        rows.append(
            {
                "id": identifier,
                "desktop": desktop,
                "title": title,
                "active": window_id(identifier) == active,
            }
        )
    return rows


def observe():
    return {
        "screenshot": capture(),
        "windows": windows(),
        "activeWindowId": active_window_id(),
    }


def mouse_button(value):
    if value is None:
        return 1
    if isinstance(value, int):
        return value if 1 <= value <= 3 else 1
    names = {"left": 1, "middle": 2, "right": 3}
    return names.get(str(value).lower(), 1)


def click(payload):
    x = int(payload.get("x", 0))
    y = int(payload.get("y", 0))
    button = mouse_button(payload.get("button"))
    count = max(1, min(3, int(payload.get("count", 1))))
    result = run(
        [
            "xdotool",
            "mousemove",
            "--sync",
            str(x),
            str(y),
            "click",
            "--repeat",
            str(count),
            str(button),
        ]
    )
    if result.returncode != 0:
        fail(result.stderr.strip() or "click failed")


def type_text(payload):
    text = str(payload.get("text", ""))
    if len(text) > 20000:
        fail("text is too long")
    lines = text.split("\n")
    for index, line in enumerate(lines):
        for offset in range(0, len(line), 1000):
            chunk = line[offset : offset + 1000]
            result = run(["xdotool", "type", "--clearmodifiers", "--delay", "12", chunk])
            if result.returncode != 0:
                fail(result.stderr.strip() or "type failed")
        if index < len(lines) - 1:
            run(["xdotool", "key", "Return"])


def press_key(payload):
    key = str(payload.get("key", "")).strip()
    if not key or len(key) > 120 or not re.fullmatch(r"[A-Za-z0-9_+.:\-]+", key):
        fail("key must be an X11 key name or a +-separated chord")
    result = run(["xdotool", "key", "--clearmodifiers", key])
    if result.returncode != 0:
        fail(result.stderr.strip() or "key press failed")


def scroll(payload):
    x = payload.get("x")
    y = payload.get("y")
    scroll_x = int(payload.get("scrollX", 0))
    scroll_y = int(payload.get("scrollY", 0))
    if scroll_x == 0 and scroll_y == 0:
        return
    if x is not None and y is not None:
        run(["xdotool", "mousemove", "--sync", str(int(x)), str(int(y))])
    steps = max(1, min(20, max(abs(scroll_x), abs(scroll_y)) // 100 or 1))
    if scroll_y != 0:
        button = 5 if scroll_y > 0 else 4
        run(["xdotool", "click", "--repeat", str(steps), str(button)])
    if scroll_x != 0:
        button = 7 if scroll_x > 0 else 6
        run(["xdotool", "click", "--repeat", str(steps), str(button)])


def drag(payload):
    from_x = int(payload.get("fromX", 0))
    from_y = int(payload.get("fromY", 0))
    to_x = int(payload.get("toX", 0))
    to_y = int(payload.get("toY", 0))
    result = run(
        [
            "xdotool",
            "mousemove",
            "--sync",
            str(from_x),
            str(from_y),
            "mousedown",
            "1",
            "mousemove",
            "--sync",
            str(to_x),
            str(to_y),
            "mouseup",
            "1",
        ]
    )
    if result.returncode != 0:
        fail(result.stderr.strip() or "drag failed")


def activate(payload):
    identifier = str(payload.get("id", "")).strip()
    if not identifier:
        fail("id is required")
    result = run(["wmctrl", "-i", "-a", identifier])
    if result.returncode != 0:
        fail(result.stderr.strip() or "activate failed")


def launch(payload):
    command = str(payload.get("command", "")).strip()
    if not command or len(command) > 500:
        fail("command is required")
    subprocess.Popen(
        command,
        shell=True,
        env=ENV,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def port_open(port, timeout=0.25):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def browser_start(payload):
    restart = bool(payload.get("restart", False))
    if restart:
        subprocess.run(["pkill", "-f", "remote-debugging-port=9222"], env=ENV)
        time.sleep(1)
    if port_open(9222) and not restart:
        return {"started": False}

    proxy_url = payload.get("proxyUrl")
    ca_pem = payload.get("caPem")
    if isinstance(ca_pem, str) and ca_pem.strip():
        ca_path = "/usr/local/share/ca-certificates/erebus-capture.crt"
        with open(ca_path, "w", encoding="utf-8") as ca_file:
            ca_file.write(ca_pem)
        subprocess.run(["update-ca-certificates"], env=ENV, capture_output=True)
        os.makedirs("/root/.pki/nssdb", exist_ok=True)
        subprocess.run(
            [
                "certutil",
                "-d",
                "sql:/root/.pki/nssdb",
                "-A",
                "-t",
                "C,,",
                "-n",
                "Erebus Capture",
                "-i",
                ca_path,
            ],
            env=ENV,
            capture_output=True,
        )

    args = [
        "chromium",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--remote-debugging-port=9222",
        "--remote-debugging-address=0.0.0.0",
        "--remote-allow-origins=*",
        "--user-data-dir=/root/.config/erebus-chromium",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,800",
    ]
    if isinstance(proxy_url, str) and proxy_url.strip():
        args.append(f"--proxy-server={proxy_url.strip().rstrip('/')}")
        args.append("--ignore-certificate-errors")
    url = str(payload.get("url", "about:blank")).strip() or "about:blank"
    args.append(url)
    subprocess.Popen(
        args,
        env=ENV,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(40):
        if port_open(9222):
            return {"started": True}
        time.sleep(0.25)
    fail("Chromium did not open the remote debugging port")


class CdpRelayHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            upstream = socket.create_connection(("127.0.0.1", 9222), timeout=5)
        except OSError:
            return
        upstream.settimeout(None)

        def pump(source, target):
            try:
                while True:
                    data = source.recv(65536)
                    if not data:
                        break
                    target.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    target.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        first = threading.Thread(target=pump, args=(self.request, upstream), daemon=True)
        second = threading.Thread(target=pump, args=(upstream, self.request), daemon=True)
        first.start()
        second.start()
        first.join()
        second.join()
        try:
            upstream.close()
        except OSError:
            pass


class CdpRelayServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    server_version = "ErebusDesktopAgent/1"

    def log_message(self, _format, *args):
        return

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return not TOKEN or self.headers.get("X-Erebus-Token") == TOKEN

    def do_GET(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        path = self.path.split("?", 1)[0]
        try:
            if path == "/health":
                return self.send_json(200, {"ok": True, "display": DISPLAY})
            if path == "/observe":
                return self.send_json(200, observe())
            if path == "/windows":
                return self.send_json(200, {"windows": windows(), "activeWindowId": active_window_id()})
            if path == "/browser/status":
                return self.send_json(200, {"running": port_open(9222)})
            return self.send_json(404, {"error": "not found"})
        except Exception as error:
            return self.send_json(500, {"error": str(error)})

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length > 1_000_000:
            return self.send_json(413, {"error": "request too large"})
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self.send_json(400, {"error": "invalid json"})
        path = self.path.split("?", 1)[0]
        try:
            if path == "/input":
                action = str(payload.get("action", ""))
                if action == "click":
                    click(payload)
                elif action == "type":
                    type_text(payload)
                elif action == "key":
                    press_key(payload)
                elif action == "scroll":
                    scroll(payload)
                elif action == "drag":
                    drag(payload)
                else:
                    return self.send_json(400, {"error": "unknown input action"})
                return self.send_json(200, {"ok": True})
            if path == "/activate":
                activate(payload)
                return self.send_json(200, {"ok": True})
            if path == "/launch":
                launch(payload)
                return self.send_json(200, {"ok": True})
            if path == "/browser/start":
                return self.send_json(200, browser_start(payload))
            if path == "/browser/stop":
                subprocess.run(["pkill", "-f", "remote-debugging-port=9222"], env=ENV)
                return self.send_json(200, {"ok": True})
            return self.send_json(404, {"error": "not found"})
        except Exception as error:
            return self.send_json(500, {"error": str(error)})


if __name__ == "__main__":
    try:
        relay = CdpRelayServer(("0.0.0.0", 9224), CdpRelayHandler)
        threading.Thread(target=relay.serve_forever, daemon=True).start()
    except OSError:
        pass
    server = ThreadingHTTPServer(("0.0.0.0", 9223), Handler)
    server.daemon_threads = True
    server.serve_forever()
`;
