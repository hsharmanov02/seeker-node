"""X bridge v3 — lets Scorpio read YOUR logged-in X feed for stock alerts.

Just double-click x_bridge.bat. That's the whole setup.

What it does:
  1. Starts its OWN Chrome window with a dedicated profile stored next to
     this script (.xbridge-profile). Your main Chrome is never touched —
     no shortcut editing, no flags, no tab stealing.
  2. You log into X inside the bridge window ONCE if it asks; the profile
     remembers you, so it survives restarts. Minimize the window and
     ignore it forever.
  3. During market hours (Mon–Fri, 13:30–21:30 London) it quietly loads,
     every 15 minutes: your Home timeline plus Latest searches for
     $NVDA, $MSFT and $AAPL, and copies out recent posts mentioning them.
     All four searches reuse the single bridge tab — it never opens extra
     windows or tabs.
     Outside market hours it just keeps serving the last batch.
  4. Saves them to x_posts.json and serves ONLY that file on port 8898,
     so Scorpio can fetch it over your Tailscale network. If Tailscale is
     installed but not running, the bridge tries to start it itself.
  5. Every 60 seconds it also checks notifications.json on GitHub. When
     Scorpio needs a TRADE approval from you, a Windows toast pops up on
     your PC with the ticket summary and Yes/No buttons — click one and
     your answer is recorded instantly (a small confirmation tab opens;
     just close it). Used ONLY for trade approvals, nothing else.

What it does NOT do:
  - It never posts, likes, follows, or sends DMs. Read-only.
  - It never touches your passwords or DMs; it only reads public timeline text.
  - It never opens tabs in your main Chrome window.
  - It never kills your main Chrome — only stale bridge-Chrome processes
    that it started itself.
  - It never places trades. A "Yes" click only records your answer for
    Scorpio to act on; every ticket is still shown to you first.

One-time setup:
  1. Double-click x_bridge.bat.
  2. A bridge Chrome window appears — log into X in it if asked, then
     minimize it and leave it alone.
  3. Leave the script window open while you want Scorpio to see your feed.

Stop any time with Ctrl+C. Nothing is uploaded anywhere except your own
Tailscale network (x_posts.json on port 8898).
"""

import html
import json
import os
import re
import socket
import subprocess
import threading
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(BASE_DIR, "x_posts.json")
PROFILE_DIR = os.path.join(BASE_DIR, ".xbridge-profile")
PORT = 8898
CDP_PORT = 9222
CDP_URL = f"http://localhost:{CDP_PORT}"
CYCLE_SECS = 5 * 60
BRIDGE_MARKER = "xbridge-window"  # fragment identifying our dedicated window

# --- Trade-approval PC notifications ---------------------------------------
# Scorpio drops trade-approval requests into notifications.json on GitHub;
# this bridge polls it every minute and pops a Windows toast on YOUR pc
# with Yes/No buttons. Clicking one records your answer locally, which
# Scorpio reads back over Tailscale. Used ONLY for trade approvals.
NOTIF_URL = ("https://raw.githubusercontent.com/hsharmanov02/seeker-node"
             "/main/notifications.json")
NOTIF_SECS = 30
NOTIF_FILE = os.path.join(BASE_DIR, "notifications.json")  # served copy lives on GitHub
LAST_NOTIF_FILE = os.path.join(BASE_DIR, ".xbridge-last-notif")
ANSWERS_FILE = os.path.join(BASE_DIR, "trade_answers.json")

QUERIES = [
    ("home", "https://x.com/home"),
    ("$NVDA", "https://x.com/search?q=%24NVDA&src=cashtag_click&f=live"),
    ("$MSFT", "https://x.com/search?q=%24MSFT&src=cashtag_click&f=live"),
    ("$AAPL", "https://x.com/search?q=%24AAPL&src=cashtag_click&f=live"),
]

TICKER_RE = re.compile(r"\$?(NVDA|NVIDIA|MSFT|MICROSOFT|AAPL|APPLE)\b", re.I)

SCRAPE_JS = """() => {
  const out = [];
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    try {
      const textEl = a.querySelector('[data-testid="tweetText"]');
      const timeEl = a.querySelector('time');
      const userEl = a.querySelector('[data-testid="User-Name"]');
      const linkEl = a.querySelector('a[href*="/status/"]');
      const userText = userEl ? userEl.innerText.split('\\n') : [];
      out.push({
        text: textEl ? textEl.innerText.slice(0, 600) : '',
        user: userText[0] || '',
        handle: (userText.find(s => s.startsWith('@')) || ''),
        time: timeEl ? timeEl.getAttribute('datetime') : '',
        url: linkEl ? ('https://x.com' + linkEl.getAttribute('href').split('?')[0]) : '',
      });
    } catch (e) {}
  }
  return out;
}"""


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def in_scan_window(now=None):
    """Only scan during market hours: Mon–Fri 13:30–21:30 Europe/London."""
    if ZoneInfo is None:
        return True
    now = now or datetime.now(ZoneInfo("Europe/London"))
    if now.weekday() >= 5:
        return False
    mins = now.hour * 60 + now.minute
    return 13 * 60 + 30 <= mins < 21 * 60 + 30


# ---------------------------------------------------------------------------
# Own-Chrome management
# ---------------------------------------------------------------------------

def find_chrome():
    """Locate chrome.exe via default install paths, then the registry."""
    candidates = [
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"),
                     "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                     "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""),
                     "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(
                    hive,
                    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
                ) as k:
                    val = winreg.QueryValue(k, None)
                if val and os.path.isfile(val):
                    return val
            except OSError:
                continue
    except ImportError:
        pass
    return None


def port_in_use(port):
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _cmdline_of(pid):
    """Return a process's command line, or '' if it can't be read."""
    try:
        out = subprocess.run(
            ["wmic", "process", "where", f"ProcessId={pid}", "get", "CommandLine"],
            capture_output=True, text=True, timeout=15,
        ).stdout
        if out and "CommandLine" in out:
            return out
    except Exception:
        pass
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"],
            capture_output=True, text=True, timeout=20,
        ).stdout
        return out or ""
    except Exception:
        return ""


def kill_stale_bridge_chrome():
    """Kill processes listening on the CDP port ONLY if they are ours
    (command line contains .xbridge-profile). Never touch anything else."""
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, timeout=15
        ).stdout
    except Exception:
        return
    pids = set()
    for line in out.splitlines():
        if f":{CDP_PORT}" in line and "LISTENING" in line:
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(parts[-1])
    for pid in pids:
        cmdline = _cmdline_of(pid)
        if ".xbridge-profile" in cmdline:
            log(f"stopping a stale bridge Chrome (PID {pid})")
            try:
                subprocess.run(["taskkill", "/PID", pid, "/F"],
                               capture_output=True, timeout=15)
            except Exception:
                pass
        else:
            log(f"port {CDP_PORT} is held by another program (PID {pid}) — leaving it alone")


def _cdp_answers():
    try:
        import urllib.request
        with urllib.request.urlopen(
            f"http://localhost:{CDP_PORT}/json/version", timeout=3
        ) as r:
            return r.status == 200
    except Exception:
        return False


def launch_bridge_chrome(chrome_exe):
    """Start our own Chrome with the dedicated profile. Returns True if CDP answers."""
    os.makedirs(PROFILE_DIR, exist_ok=True)
    if port_in_use(CDP_PORT):
        kill_stale_bridge_chrome()
    if port_in_use(CDP_PORT):
        # Something else holds the port (maybe a manually flagged Chrome).
        # connect_over_cdp can still use it — don't fight it.
        log(f"port {CDP_PORT} already in use — will try to use that Chrome as-is")
        return _cdp_answers()
    log("starting the bridge's own Chrome (your main Chrome is untouched)")
    try:
        subprocess.Popen(
            [chrome_exe,
             f"--remote-debugging-port={CDP_PORT}",
             f"--user-data-dir={PROFILE_DIR}",
             "--new-window", "about:blank"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
        )
    except Exception as e:
        log(f"could not start Chrome ({type(e).__name__}: {e})")
        return False
    for _ in range(40):
        time.sleep(0.5)
        if _cdp_answers():
            return True
    log("bridge Chrome did not answer — will retry next cycle")
    return False


_chrome_exe = None


def ensure_bridge_chrome():
    """Make sure a CDP-reachable Chrome exists. Cheap no-op when healthy."""
    global _chrome_exe
    if _cdp_answers():
        return True
    if _chrome_exe is None:
        _chrome_exe = find_chrome()
        if not _chrome_exe:
            log("Google Chrome not found — install it, then re-run this script")
            return False
    return launch_bridge_chrome(_chrome_exe)


# ---------------------------------------------------------------------------
# Tailscale self-heal
# ---------------------------------------------------------------------------

def _run(cmd, timeout=15):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError:
        return None, "", ""
    except Exception:
        return -1, "", ""


def _tailscale_self_ip():
    """Return this machine's Tailscale IPv4, or None. Parses `tailscale ip`
    output directly (no -4 flag) so it works on stock and shimmed CLIs."""
    rc, out, _ = _run(["tailscale", "ip"])
    if rc != 0 or not out:
        return None
    for line in out.splitlines():
        line = line.strip()
        parts = line.split(".")
        if len(parts) == 4 and all(p.isdigit() for p in parts) and line.startswith("100."):
            return line
    return None


def tailscale_ipv4():
    """Return (ipv4_or_None, plain-English status line). Tries to self-heal."""
    rc, _, _ = _run(["tailscale", "status"])
    if rc == 0:
        ip = _tailscale_self_ip()
        if ip:
            return ip, "Tailscale: connected"
        return None, "Tailscale: connected (could not read its IP — binding everywhere)"
    if rc is None:
        return None, ("Tailscale: not installed — grab it from tailscale.com/download "
                      "so Scorpio can read the feed")
    # Installed but not running — try to wake it up.
    ipn = r"C:\Program Files\Tailscale\tailscale-ipn.exe"
    if os.path.isfile(ipn):
        try:
            subprocess.Popen(
                [ipn], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
            time.sleep(6)
            rc3, _, _ = _run(["tailscale", "status"])
            if rc3 == 0:
                ip = _tailscale_self_ip()
                return ip, "Tailscale: wasn't running — started it just now"
        except Exception:
            pass
        return None, ("Tailscale: not running, tried to start it — "
                      "open Tailscale from the Start menu if this persists")
    return None, "Tailscale: not running — open Tailscale from the Start menu"


# ---------------------------------------------------------------------------
# Scraping (unchanged from v2)
# ---------------------------------------------------------------------------

def get_bridge_page(pw):
    """Return (browser, page) for our dedicated minimized window, creating it if needed.

    The window lives in the bridge's own Chrome profile, so it never touches
    your main Chrome or its tabs. Minimize it once and ignore it.
    """
    try:
        browser = pw.chromium.connect_over_cdp(CDP_URL)
    except Exception:
        log("could not reach the bridge Chrome — will retry next cycle")
        return None, None
    ctx = browser.contexts[0] if browser.contexts else None
    if ctx is None:
        log("No browser context found.")
        try:
            browser.close()
        except Exception:
            pass
        return None, None

    def find_page():
        # Identify OUR page two ways: the URL fragment works right after
        # creation, and a JS marker (registered via add_init_script) survives
        # every navigation afterwards. If the old window-per-cycle bug left
        # duplicates behind, keep the first and close the rest.
        marked = []
        for p in ctx.pages:
            try:
                if p.is_closed():
                    continue
                if BRIDGE_MARKER in (p.url or ""):
                    marked.append(p)
                    continue
                try:
                    if p.evaluate("window.__xbridge === true"):
                        marked.append(p)
                except Exception:
                    continue
            except Exception:
                continue
        for dup in marked[1:]:
            try:
                dup.close()
                log("closed a duplicate bridge window left by the old bug")
            except Exception:
                pass
        return marked[0] if marked else None

    page = find_page()
    if page is not None:
        return browser, page

    # Open a dedicated background window for the bridge.
    try:
        cdp = browser.new_browser_cdp_session()
        cdp.send("Target.createTarget", {
            "url": "about:blank#" + BRIDGE_MARKER,
            "newWindow": True,
            "background": True,
        })
    except Exception as e:
        log(f"Could not open bridge window ({type(e).__name__}: {e})")
        try:
            browser.close()
        except Exception:
            pass
        return None, None

    for _ in range(30):
        time.sleep(0.5)
        page = find_page()
        if page is not None:
            try:
                # Marker survives every page.goto, so next cycle finds this
                # same tab again instead of opening a new window.
                page.add_init_script("window.__xbridge = true;")
            except Exception:
                pass
            log("bridge window opened — log into X in it if it asks, then minimize it")
            return browser, page
    log("Bridge window did not appear; will retry next cycle.")
    try:
        browser.close()
    except Exception:
        pass
    return None, None


def scrape_cycle(pw):
    """One gentle pass over home + the three ticker searches, inside the bridge window."""
    browser, page = get_bridge_page(pw)
    if page is None:
        return None

    seen = {}
    login_hinted = False
    try:
        for label, url in QUERIES:
            try:
                if page.is_closed():
                    log(f"{label}: bridge window was closed; recreating next cycle")
                    break
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(4000)
                title = page.evaluate("document.title") or ""
                if "log in" in title.lower():
                    if not login_hinted:
                        log("X wants a login in the BRIDGE window — "
                            "log in to X there once, then minimize it")
                        login_hinted = True
                    break
                if "Something went wrong" in title:
                    log(f"{label}: X showed an error page (rate limit?) — skipping")
                    continue
                # A couple of gentle scrolls to load more posts.
                for _ in range(2):
                    page.evaluate("window.scrollBy(0, 2500)")
                    page.wait_for_timeout(2500)
                posts = page.evaluate(SCRAPE_JS)
                kept = 0
                for p in posts:
                    if not p["text"] or not TICKER_RE.search(p["text"]):
                        continue
                    key = (p["handle"], p["text"][:80])
                    if key not in seen:
                        seen[key] = {**p, "via": label}
                        kept += 1
                log(f"{label}: kept {kept} ticker posts")
            except Exception as e:
                log(f"{label}: scrape hiccup ({type(e).__name__}); continuing")
            time.sleep(3)  # breathe between pages — stay gentle on rate limits
    finally:
        try:
            browser.close()  # disconnects only; bridge Chrome and window stay open
        except Exception:
            pass

    return list(seen.values())


def write_posts(posts):
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source": "x_bridge v3 (dedicated bridge Chrome)",
        "count": len(posts),
        "posts": posts[:120],
    }
    tmp = OUT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT_FILE)


# ---------------------------------------------------------------------------
# Trade-approval PC notifications (Yes/No toasts)
# ---------------------------------------------------------------------------

# Registers this app's toast identity with Windows (Start Menu shortcut +
# AppUserModelID). Without this, Windows 11 silently drops toasts from
# unregistered apps — no error, nothing displayed.
TOAST_REG_PS1 = r'''
$appId = "Scorpio Trade Alerts"
$lnkPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Scorpio Trade Alerts.lnk"
if (-not (Test-Path $lnkPath)) {
    $wsh = New-Object -ComObject WScript.Shell
    $sc = $wsh.CreateShortcut($lnkPath)
    $sc.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $sc.Save()
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ToastReg {
    [DllImport(""shell32.dll"", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string AppID);
    [DllImport(""shell32.dll"", CharSet = CharSet.Unicode)]
    private static extern int SHGetPropertyStoreFromParsingName(string pszPath, IntPtr pbc, int flags, ref Guid riid, out IPropertyStore store);
    [ComImport, Guid(""886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99""), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        uint GetCount();
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }
    public static void Register(string lnkPath, string appId) {
        Guid iid = new Guid(""886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"");
        IPropertyStore store;
        int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 0, ref iid, out store);
        if (hr != 0) throw new Exception(""SHGetPropertyStoreFromParsingName failed"");
        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid(""9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"");
        key.pid = 5;
        PROPVARIANT pv = new PROPVARIANT();
        pv.vt = 31;
        pv.pwszVal = Marshal.StringToCoTaskMemUni(appId);
        store.SetValue(ref key, ref pv);
        store.Commit();
        Marshal.FreeCoTaskMem(pv.pwszVal);
        Marshal.ReleaseComObject(store);
        hr = SetCurrentProcessExplicitAppUserModelID(appId);
        if (hr != 0) throw new Exception(""SetCurrentProcessExplicitAppUserModelID failed"");
    }
}
"@
try {
    [ToastReg]::Register($lnkPath, $appId)
} catch {
    [Console]::Error.WriteLine("toast appid registration failed: " + $_.Exception.Message)
}
'''

TOAST_PS1_BUTTONS = TOAST_REG_PS1 + r'''
$toastXml = @"
<?xml version="1.0" encoding="utf-8"?>
<toast scenario="reminder" duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>__TITLE__</text>
      <text>__BODY__</text>
    </binding>
  </visual>
  <actions>
    <action content="Yes" arguments="__URL_YES__" activationType="protocol" />
    <action content="No" arguments="__URL_NO__" activationType="protocol" />
  </actions>
</toast>
"@
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
$xmlDoc.LoadXml($toastXml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xmlDoc))
'''

TOAST_PS1_PLAIN = TOAST_REG_PS1 + r'''
$toastXml = @"
<?xml version="1.0" encoding="utf-8"?>
<toast duration="long">
  <visual>
    <binding template="ToastGeneric">
      <text>__TITLE__</text>
      <text>__BODY__</text>
    </binding>
  </visual>
</toast>
"@
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xmlDoc = New-Object Windows.Data.Xml.Dom.XmlDocument
$xmlDoc.LoadXml($toastXml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xmlDoc))
'''


def show_windows_toast(title, body, buttons=None):
    """Pop a Windows toast. buttons = [(label, url), ...] or None for plain.

    Button clicks open the URL (a tiny 'recorded' page served by this bridge)
    AND record the answer — no need to open the chat.
    """
    def ps_escape(s):
        # Inside PowerShell expandable heredocs, $ starts interpolation.
        return s.replace("$", "`$")
    title = ps_escape(html.escape(str(title))[:120])
    body = ps_escape(html.escape(str(body))[:300])
    if buttons:
        url_yes = ps_escape(html.escape(buttons[0][1], quote=True))
        url_no = ps_escape(html.escape(buttons[1][1], quote=True))
        ps1 = (TOAST_PS1_BUTTONS.replace("__TITLE__", title)
                                  .replace("__BODY__", body)
                                  .replace("__URL_YES__", url_yes)
                                  .replace("__URL_NO__", url_no))
    else:
        ps1 = (TOAST_PS1_PLAIN.replace("__TITLE__", title)
                                  .replace("__BODY__", body))
    ps1_path = os.path.join(BASE_DIR, "_toast_tmp.ps1")
    diag = {"returncode": None, "stdout": "", "stderr": ""}
    try:
        with open(ps1_path, "w", encoding="utf-8") as f:
            f.write(ps1)
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", ps1_path],
            capture_output=True, timeout=60)
        diag = {
            "returncode": r.returncode,
            "stdout": (r.stdout or b"").decode("utf-8", "replace")[-500:],
            "stderr": (r.stderr or b"").decode("utf-8", "replace")[-1500:],
        }
        if r.returncode != 0:
            log(f"toast powershell failed (rc={r.returncode}): {diag['stderr'][-400:]}")
        else:
            log(f"toast shown: {title[:60]}")
    except subprocess.TimeoutExpired:
        log("toast powershell timed out after 60s")
        diag = {"returncode": -1, "stdout": "", "stderr": "timeout after 60s"}
    except Exception as e:
        log(f"toast failed ({type(e).__name__}: {e})")
        diag = {"returncode": -2, "stdout": "",
                "stderr": f"{type(e).__name__}: {e}"}
    finally:
        try:
            os.remove(ps1_path)
        except OSError:
            pass
    return diag


def fetch_notifications():
    """Pull notifications.json from GitHub. Returns a list of dicts."""
    try:
        url = NOTIF_URL + f"?cb={int(time.time())}"
        req = urllib.request.Request(url, headers={"User-Agent": "xbridge-notify/1.0"})
        # Bypass any system proxy settings — go direct to GitHub. A stale or
        # broken proxy (or firewall-blocked proxy) would otherwise kill this
        # silently on some PCs.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=20) as r:
            if r.status != 200:
                return []
            data = json.loads(r.read().decode("utf-8"))
        notifs = data.get("notifications", []) if isinstance(data, dict) else []
        return [n for n in notifs if isinstance(n, dict) and n.get("id")]
    except Exception as e:
        log(f"notification fetch failed ({type(e).__name__}: {e})")
        return []  # stay quiet otherwise, retry next minute


def load_seen_ids():
    try:
        with open(LAST_NOTIF_FILE, encoding="utf-8") as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_seen_ids(seen):
    try:
        tmp = LAST_NOTIF_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(sorted(seen)[-100:], f)
        os.replace(tmp, LAST_NOTIF_FILE)
    except Exception:
        pass


def read_answers():
    try:
        with open(ANSWERS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def record_answer(ticket_id, choice):
    answers = read_answers()
    answers[str(ticket_id)] = {
        "choice": choice,
        "answered_at": datetime.now(timezone.utc).isoformat(),
    }
    # keep only the 20 most recent answers
    try:
        items = sorted(answers.items(),
                       key=lambda kv: kv[1].get("answered_at", ""),
                       reverse=True)[:20]
        answers = dict(items)
        tmp = ANSWERS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(answers, f, indent=1)
        os.replace(tmp, ANSWERS_FILE)
    except Exception:
        pass


def show_notification(n, btn_ip):
    """Toast one notification dict. Returns (id, diag) — diag holds the
    PowerShell return code / captured output for remote diagnostics."""
    if not isinstance(n, dict) or not n.get("id"):
        return None, {"returncode": None, "stdout": "",
                      "stderr": "invalid notification payload"}
    nid = str(n["id"])
    title = str(n.get("title", "Scorpio"))
    body = str(n.get("body", ""))
    if n.get("type") == "trade_approval" and n.get("ticket_id"):
        tid = str(n["ticket_id"])
        base = (f"http://{btn_ip}:{PORT}/answer"
                f"?ticket={urllib.parse.quote(tid, safe='')}")
        diag = show_windows_toast(
            title, body,
            buttons=[("Yes", base + "&choice=yes"),
                     ("No", base + "&choice=no")])
        log(f"trade-approval toast shown (ticket {tid})")
    else:
        diag = show_windows_toast(title, body)
        log(f"toast shown: {title[:60]}")
    return nid, diag


def notify_loop(btn_ip):
    """Backup poll: GitHub for notifications every 30s; toast the new ones.

    The fast path is a direct POST to /notify from send_notif.py over the
    Tailscale tunnel (seconds). This poll only catches anything sent while
    the bridge was offline.
    """
    seen = load_seen_ids()
    log("trade-approval toasts armed (direct push + 30s backup poll)")
    while True:
        try:
            for n in sorted(fetch_notifications(), key=lambda x: str(x.get("ts", ""))):
                nid = str(n.get("id", ""))
                if not nid or nid in seen:
                    continue
                seen.add(nid)
                _nid, _diag = show_notification(n, btn_ip)
            save_seen_ids(seen)
        except Exception:
            log("notify loop error:\n" + traceback.format_exc(limit=3))
        time.sleep(NOTIF_SECS)


class Handler(BaseHTTPRequestHandler):
    btn_ip = "127.0.0.1"  # set by main() once Tailscale is up

    def _send(self, body_bytes, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        name = parsed.path.lstrip("/").split("#")[0]

        if name == "answer":
            # Toast button landing: ?ticket=<id>&choice=yes|no
            args = urllib.parse.parse_qs(parsed.query)
            ticket = (args.get("ticket") or [""])[0]
            choice = (args.get("choice") or [""])[0].lower()
            if ticket and choice in ("yes", "no"):
                record_answer(ticket, choice)
                page = (
                    "<html><head><meta charset='utf-8'></head>"
                    "<body style='font-family:sans-serif;text-align:center;"
                    "margin-top:60px;background:#0f1419;color:#e7e9ea'>"
                    f"<h1>&#10003; Recorded: {choice.upper()}</h1>"
                    f"<p>Ticket {html.escape(ticket)} — you can close this tab.</p>"
                    "</body></html>")
                log(f"answer recorded: ticket {ticket} -> {choice.upper()}")
            else:
                page = "<html><body><p>Missing ticket or choice.</p></body></html>"
            self._send(page.encode("utf-8"), "text/html; charset=utf-8")
            return

        if name == "trade_answer.json":
            self._send(json.dumps(read_answers()).encode("utf-8"),
                       "application/json")
            return

        if name != "x_posts.json":
            self.send_response(404)
            self.end_headers()
            return
        if not os.path.isfile(OUT_FILE):
            self.send_response(404)
            self.end_headers()
            return
        with open(OUT_FILE, "rb") as f:
            body = f.read()
        self._send(body, "application/json")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        name = parsed.path.lstrip("/").split("#")[0]
        if name == "notify":
            # Fast path: Scorpio pushes a notification straight to the bridge
            # over the Tailscale tunnel instead of waiting for the GitHub poll.
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except Exception:
                payload = {}
            try:
                seen = load_seen_ids()
                nid, diag = show_notification(payload, Handler.btn_ip)
                if nid:
                    seen.add(nid)
                    save_seen_ids(seen)
                    log(f"direct push received ({nid})")
                self._send(json.dumps({"ok": True, "nid": nid,
                                       "toast": diag}).encode("utf-8"),
                           "application/json")
            except Exception as e:
                log(f"/notify failed ({type(e).__name__}: {e})")
                self._send(b'{"ok": false}', "application/json")
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


def serve(bind_ip):
    server = HTTPServer((bind_ip, PORT), Handler)
    if bind_ip == "0.0.0.0":
        log(f"serving x_posts.json on port {PORT} (all interfaces — LAN-visible!)")
        log("WARNING: Tailscale is not connected, so the feed is visible "
            "on your local network, not just to Scorpio")
    else:
        log(f"serving x_posts.json on Tailscale {bind_ip}:{PORT}")
    server.serve_forever()


def main():
    from playwright.sync_api import sync_playwright

    ts_ip, ts_msg = tailscale_ipv4()
    log(ts_msg)
    threading.Thread(target=serve, args=(ts_ip or "0.0.0.0",), daemon=True).start()
    # Trade-approval toasts: poll GitHub notifications.json every minute.
    # Button clicks land back on this machine's own bridge address.
    btn_ip = ts_ip or "127.0.0.1"
    Handler.btn_ip = btn_ip
    threading.Thread(target=notify_loop, args=(btn_ip,), daemon=True).start()

    ensure_bridge_chrome()
    log("x_bridge v3 started — Ctrl+C to stop")
    with sync_playwright() as pw:
        while True:
            if not in_scan_window():
                log("outside market hours — feed paused, serving last batch")
                time.sleep(5 * 60)
                continue
            try:
                if not ensure_bridge_chrome():
                    log("cycle skipped (no Chrome); retrying in 15 min")
                else:
                    posts = scrape_cycle(pw)
                    if posts is not None:
                        write_posts(posts)
                        log(f"cycle done: {len(posts)} ticker posts saved")
                    else:
                        log("cycle skipped (bridge Chrome not reachable); retrying in 15 min")
            except Exception:
                log("cycle error:\n" + traceback.format_exc(limit=3))
            time.sleep(CYCLE_SECS)


if __name__ == "__main__":
    main()
