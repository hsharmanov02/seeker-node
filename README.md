# Seeker Node — a buyer-finding node for YOUR computer

## What this is
A node you run on your own machine. Every hour (configurable) it checks
real, public sources of demand and records people/companies saying
"I will pay someone":

- **hn_hiring** — Hacker News monthly "Who is hiring?" thread (public API, no account)
- **remoteok** — RemoteOK public job feed (public API, no account)

Matches are filtered by YOUR keywords in `config.json` and saved to
`opportunities.jsonl`. `status.json` tracks each cycle.

## What this is NOT
Not passive income. Not autonomous money. The node hunts — it finds
buyers. You still apply, reply, or pitch. That 5-minute human step is
the part no script can do for you, and anyone who says otherwise is lying.

## How the monitor/upgrade loop works with Scorpio
1. You run the node: `python node.py` (plus `python serve.py` for the live link)
2. It writes `status.json`, `opportunities.jsonl`, `node.log`
3. I read the telemetry myself over our private Tailscale link, on a schedule
4. I tune keywords and ship upgraded seekers straight to this GitHub repo
5. You double-click `update.bat` to pull the upgrade, then restart the node.
   Repeat — the node gets sharper every round.

## Setup (your computer)
1. Install Python 3 (https://www.python.org/downloads/)
2. Copy this whole folder to your computer
3. Open a terminal in the folder:
   ```
   python3 node.py --once     # test run, prints what it found
   python3 monitor.py         # see the opportunities nicely
   python3 node.py            # full autonomous loop (Ctrl+C to stop)
   ```
4. Edit `config.json` to change keywords, interval, or seekers.

## Instant alerts (optional, 2 minutes)
Install Telegram on your phone, then:
1. Message **@BotFather** -> `/newbot` -> pick a name -> copy the token
2. Message your new bot anything (e.g. "hi")
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` and find
   your numeric chat id
4. Paste both into `config.json` under `"telegram"`

From then on, every cycle that finds new leads pings your phone instantly.
No token? The node just skips alerting — everything else works.

## Getting updates (GitHub)
Scorpio ships upgrades straight to this repo. To pull them onto your PC:
1. Install git (Windows: open PowerShell and run `winget install Git.Git`)
2. Clone once: `git clone https://github.com/hsharmanov02/seeker-node.git`
3. Whenever Scorpio says there's an update, double-click `update.bat`
   in the folder (or run `git pull`), then restart `node.py` / `serve.py`.

Your `config.json`, `seen.json`, and telemetry files are never touched by
updates — only the code changes. First-time setup from a fresh clone: copy
`config.example.json` to `config.json` and edit your keywords there.

No dependencies, no accounts, no API keys. Pure standard library.

## Direct link to Scorpio (Tailscale, optional)
This lets me read the node's telemetry myself instead of you pasting reports:
1. Install Tailscale on your computer (free, tailscale.com/download)
2. Open the approval link I give you in chat (approves my VM only)
3. Run the node as normal: `python3 node.py`
4. In a second terminal, run: `python3 serve.py`
5. Tell me your machine's Tailscale IP (shown in the Tailscale app)

I then read `status.json` through our private network — you approve that
address once, and I can check the node on a schedule, only bothering you
when something needs attention. I can't control your PC or see your screen;
I can only read the three telemetry files serve.py exposes.
