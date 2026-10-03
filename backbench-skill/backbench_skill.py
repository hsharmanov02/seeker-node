#!/usr/bin/env python3
"""BackBench skill CLI - free layer (open source, stdlib only).

Scans agent gig boards, fit-scores listings against YOUR capability card,
drafts GigFoundry-format applications (deliverable + objective acceptance
checks), tracks win/loss, and - the point - DETECTS the overflow moment:
a gig you won whose acceptance checks exceed your capability card or your
parallel capacity. Only then does it surface the paid BackBench delegation
offer (wholesale execution minutes from the BackBench VM swarm; you stay
merchant of record; the poster never sees BackBench).

The skill never holds keys and never pays anything itself. If you delegate,
it shows you the x402 challenge; settlement is your own wallet's business.

Usage (workspace dir = $BACKBENCH_WS or ./backbench_ws):
  backbench_skill.py init
  backbench_skill.py scan [--live] [--board-file board.json] [--limit 20]
  backbench_skill.py draft --gig-id <id>
  backbench_skill.py apply --gig-id <id>
  backbench_skill.py outcome --gig-id <id> --result won|lost [--deadline-hours 24]
  backbench_skill.py status
  backbench_skill.py delegate --gig-id <id> [--test] [--api-base URL]
"""
import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

WS = os.environ.get("BACKBENCH_WS", os.path.join(os.getcwd(), "backbench_ws"))
UGIG_API = "https://ugig.net/api/gigs"
USD_GBP = 0.76
FRICTION = 0.80
RATE_GATE = 0.30

BANNED = [
    ("money_mule_or_account_rental", r"money mule|u\.s\. resident who can work|rent (your|my) account|account rental"),
    ("credential_or_login_work", r"credential|password|login bypass|bypass.*captcha|captcha.*bypass|anti-detection"),
    ("fake_engagement_or_spam", r"fake engagement|follower farming|upvote.*spam|comment spam|backlink scheme"),
    ("personal_financial_documents", r"bank statement|passport|national id|tax return|personal data"),
    ("virtual_card_financial_product", r"virtual card|reloadable.*card|visa.*card"),
]
SELLER_PITCH = [r"FOR-HIRE SERVICE", r"this is not a request for another worker",
                r"I am an AI agent offering a service", r"please do not submit applications"]
# workflow class -> (title/body patterns, repeatability score, default minutes)
WORKFLOWS = [
    ("api_adapter", r"rest/api|api adapter|api integration|api wrapper|adapter.*json|json/xml/csv", 30, 90),
    ("csv_json_validation", r"csv|json file|data cleaning|convert.*valid|validation.*file", 28, 25),
    ("automation_pipeline", r"automation|pipeline|workflow build|data pipeline|cli tool", 27, 75),
    ("code_review", r"code review|review your.*code|security.*performance.*review", 24, 50),
    ("bug_fix", r"fix.*bug|reproducible.*bug|regression test|debugging", 22, 45),
    ("research_brief", r"research brief|source-cited|decision summary|decision scorecard|market scan", 24, 45),
    ("qa_evidence", r"qa|quality assurance|evidence packet|testing.*report", 24, 45),
    ("pdf_extraction", r"pdf|ocr|invoice.*csv|statement.*csv", 18, 60),
]
# GigFoundry executor-backed classes the BackBench swarm can run TODAY.
SWARM_CLASSES = ["catalogue_snapshot", "csv_clean"]
CLASS_ALIAS = {"csv_json_validation": "csv_clean"}
# Acceptance checks drafted per class (verbatim delegation contract later).
DRAFT_CHECKS = {
    "catalogue_snapshot": ["record_count_matches", "no_duplicate_ids", "snapshot_hash_recomputable"],
    "csv_clean": ["no_duplicate_keys", "all_rows_keyed", "snapshot_hash_recomputable"],
    "api_adapter": ["adapter runs against sample fixtures", "schema validation passes", "README run commands reproduce output"],
    "code_review": ["every finding cites file/line", "severity assigned per finding", "test-suite output included"],
    "bug_fix": ["regression test fails before patch", "regression test passes after patch", "root-cause note included"],
    "research_brief": ["every claim tied to a cited source", "source table included", "evidence gaps stated"],
    "automation_pipeline": ["pipeline runs end-to-end on sample input", "reconciliation counts match", "README included"],
    "qa_evidence": ["each check reproducible from the packet", "findings table with severity", "rerun recipe included"],
    "pdf_extraction": ["row count reconciles with source pages", "schema validation passes"],
    "generic_bounded_task": ["deliverable matches the posted spec", "acceptance evidence included"],
}
DELIVERABLE = {
    "csv_json_validation": "cleaned/converted file + validation report",
    "api_adapter": "working adapter + schema validation + sample fixtures + README with exact run commands",
    "automation_pipeline": "runnable pipeline + tests + reconciliation/QA report + README",
    "code_review": "severity-rated review with file/line findings, fix snippets, and test-suite output",
    "bug_fix": "focused patch + regression test (fails before, passes after) + root-cause note",
    "research_brief": "source-cited brief with source table, scorecard, recommendation, and evidence gaps",
    "qa_evidence": "QA evidence packet with reproducible checks, findings table, and rerun recipe",
    "pdf_extraction": "extracted table (CSV/JSON) + reconciliation counts",
    "catalogue_snapshot": "validated catalogue snapshot + brief + snapshot hash",
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def p(name):
    return os.path.join(WS, name)


def load(name, default):
    try:
        with open(p(name)) as f:
            return json.load(f)
    except Exception:
        return default


def save(name, obj):
    os.makedirs(WS, exist_ok=True)
    tmp = p(name) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, p(name))


def infer_workflow(text, title=""):
    low_title = (title or "").lower()
    for name, pat, repeat, minutes in WORKFLOWS:
        if re.search(pat, low_title):
            return name, repeat, minutes
    low = text.lower()
    for name, pat, repeat, minutes in WORKFLOWS:
        if re.search(pat, low):
            return name, repeat, minutes
    return "generic_bounded_task", 12, 60


def score_gig(gig):
    """Fit score, adapted from the GigFoundry scorer (fleet-proven gates)."""
    text = f"{gig.get('title','')} {gig.get('description','')} {' '.join(gig.get('skills_required') or [])}"
    low = text.lower()
    hard = []
    if gig.get("status") not in (None, "active"):
        hard.append("gig_not_active")
    if gig.get("listing_type") not in (None, "hiring"):
        hard.append("not_a_hiring_listing")
    for name, pat in BANNED:
        if re.search(pat, low):
            hard.append(name)
    for pat in SELLER_PITCH:
        if re.search(pat, text, re.I):
            hard.append("explicit_seller_pitch_not_buyer_demand")
            break
    budget_min = float(gig.get("budget_min") or 0)
    budget_max = float(gig.get("budget_max") or budget_min or 0)
    if budget_max <= 0:
        hard.append("no_budget")
    workflow, repeatability, default_minutes = infer_workflow(text, gig.get("title", ""))
    estimated = float(gig.get("estimated_minutes") or default_minutes)
    proposed = budget_max if budget_min == budget_max else round(budget_max * 0.8, 2)
    net_per_min = (proposed * USD_GBP * FRICTION) / estimated if estimated else 0.0
    objective_terms = ["test", "schema", "valid", "report", "citation", "cited", "source", "diff",
                       "count", "scorecard", "readme", "severity", "finding", "patch", "regression"]
    objective = min(25, 6 + 2 * sum(1 for t in objective_terms if t in low))
    total = (30 if net_per_min >= 0.45 else 22 if net_per_min >= RATE_GATE else 0) \
        + repeatability + objective + 16 + 8
    eligible = (not hard and total >= 62 and net_per_min >= RATE_GATE
                and repeatability >= 18 and objective >= 12)
    return {"gig_id": gig.get("id"), "title": gig.get("title"), "workflow_class": workflow,
            "score": max(0, min(100, total)), "eligible": eligible, "hard_rejects": hard,
            "economics": {"proposed_price_usd": proposed, "estimated_minutes": estimated,
                          "net_gbp_per_min": round(net_per_min, 4)}}


def fetch_board(board_file=None, live=False):
    if board_file:
        gigs = json.load(open(board_file))
        return [g for g in gigs if g.get("listing_type") in (None, "hiring")]
    gigs, page = [], 1
    while page <= 7:
        url = f"{UGIG_API}?limit=50&page={page}"
        req = urllib.request.Request(url, headers={"User-Agent": "backbench-skill/0.1"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        batch = data if isinstance(data, list) else data.get("gigs") or data.get("data") or []
        if not batch:
            break
        gigs.extend(batch)
        if len(batch) < 50:
            break
        page += 1
    return [g for g in gigs if g.get("listing_type") in (None, "hiring")]


def cmd_init(args):
    os.makedirs(WS, exist_ok=True)
    if not os.path.exists(p("capability_card.json")):
        save("capability_card.json", {
            "agent_id": "my-agent",
            "depth_classes": ["catalogue_snapshot", "csv_clean", "research_brief"],
            "capacity_slots": 1,
            "note": "depth_classes = work YOU can execute to acceptance-standard; capacity_slots = parallel gigs you can run. Edit honestly: BackBench triggers only on the gap between this card and your wins.",
        })
    if not os.path.exists(p("ledger.json")):
        save("ledger.json", {"applications": {}, "wins": {}, "losses": {}, "scan_log": []})
    print(f"BackBench workspace ready at {WS}. Edit capability_card.json honestly, then: scan")


def cmd_scan(args):
    gigs = fetch_board(args.board_file, args.live)
    seen, rows = set(), []
    for g in gigs:
        gid = g.get("id")
        if gid in seen:
            continue
        seen.add(gid)
        rows.append({"gig": g, "score": score_gig(g)})
    rows.sort(key=lambda r: (r["score"]["eligible"], r["score"]["economics"]["net_gbp_per_min"]), reverse=True)
    ledger = load("ledger.json", {"applications": {}, "wins": {}, "losses": {}, "scan_log": []})
    ledger["last_scan"] = {r["score"]["gig_id"]: r for r in rows}
    ledger.setdefault("scan_log", []).append({"at": now_iso(), "listings": len(rows),
                                             "eligible": sum(1 for r in rows if r["score"]["eligible"])})
    save("ledger.json", ledger)
    for r in rows[:args.limit]:
        s = r["score"]
        print(f"[{'FIT ' if s['eligible'] else 'skip'}] {s['score']:>3} {s['workflow_class']:<22} "
              f"net GBP/min {s['economics']['net_gbp_per_min']:.3f}  {str(s['title'])[:70]}")
    print(f"\n{len(rows)} hiring listings scanned, {sum(1 for r in rows if r['score']['eligible'])} fit your card. Draft with: draft --gig-id <id>")


def draft_text(gig, score):
    wf = score["workflow_class"]
    checks = DRAFT_CHECKS.get(CLASS_ALIAS.get(wf, wf), DRAFT_CHECKS["generic_bounded_task"])
    deliverable = DELIVERABLE.get(wf, "bounded deliverable with tests, a QA report, and a rerun recipe")
    eco = score["economics"]
    lines = [
        f"Application for: {gig.get('title')} ({gig.get('id')})",
        f"Proposed fixed price: ${eco['proposed_price_usd']:.2f}. Estimated production window: {eco['estimated_minutes']:.0f} minutes.",
        "",
        f"I will deliver: {deliverable}.",
        "Acceptance is objective - the delivery must pass these checks:",
    ] + [f"  - {c}" for c in checks] + [
        "",
        "Boundaries: public or buyer-authorised inputs only; no credentials, no login/CAPTCHA bypass, no personal data resale.",
    ]
    return "\n".join(lines), checks


def cmd_draft(args):
    ledger = load("ledger.json", {})
    row = (ledger.get("last_scan") or {}).get(args.gig_id)
    if not row:
        print("gig not in last scan; run scan first", file=sys.stderr)
        sys.exit(1)
    text, _ = draft_text(row["gig"], row["score"])
    print(text)


def cmd_apply(args):
    ledger = load("ledger.json", {"applications": {}, "wins": {}, "losses": {}, "scan_log": []})
    row = (ledger.get("last_scan") or {}).get(args.gig_id)
    if not row:
        print("gig not in last scan; run scan first", file=sys.stderr)
        sys.exit(1)
    text, checks = draft_text(row["gig"], row["score"])
    ledger.setdefault("applications", {})[args.gig_id] = {
        "gig": row["gig"], "score": row["score"], "draft": text,
        "acceptance_checks": checks, "applied_at": now_iso(), "status": "applied",
        "note": "Draft recorded locally. Submit via your own board tooling; BackBench never submits or pays for you.",
    }
    save("ledger.json", ledger)
    print(f"application recorded for {args.gig_id} (workflow {row['score']['workflow_class']}, "
          f"checks: {len(checks)}). Submit the draft with your board tooling, then record the outcome.")


def cmd_outcome(args):
    ledger = load("ledger.json", {"applications": {}, "wins": {}, "losses": {}, "scan_log": []})
    app = (ledger.get("applications") or {}).get(args.gig_id)
    if not app:
        print("no application recorded for that gig", file=sys.stderr)
        sys.exit(1)
    if args.result == "won":
        ledger.setdefault("wins", {})[args.gig_id] = {
            "gig": app["gig"], "score": app["score"],
            "acceptance_checks": app["acceptance_checks"],
            "won_at": now_iso(), "deadline_hours": args.deadline_hours,
            "delivered": False,
        }
        app["status"] = "won"
        print(f"WIN recorded: {args.gig_id} ({app['score']['workflow_class']}), deadline {args.deadline_hours}h. "
              f"Run `status` - if this exceeds your card, BackBench will say so.")
    else:
        ledger.setdefault("losses", {})[args.gig_id] = {"at": now_iso()}
        app["status"] = "lost"
        print(f"loss recorded: {args.gig_id}")
    save("ledger.json", ledger)


def detect_triggers(ledger, card):
    wins = [w for w in (ledger.get("wins") or {}).values() if not w.get("delivered")]
    capacity = int(card.get("capacity_slots") or 1)
    depth = set(card.get("depth_classes") or [])
    triggers = []
    for w in wins:
        wf = w["score"]["workflow_class"]
        if wf not in depth:
            triggers.append({"gig_id": w["score"]["gig_id"], "kind": "depth_gap",
                             "detail": f"won {wf} work outside your depth_classes {sorted(depth)}",
                             "win": w})
    if len(wins) > capacity:
        for w in wins[capacity:]:
            triggers.append({"gig_id": w["score"]["gig_id"], "kind": "capacity_overflow",
                             "detail": f"{len(wins)} live wins vs capacity_slots={capacity}",
                             "win": w})
    return triggers


def cmd_status(args):
    ledger = load("ledger.json", {"applications": {}, "wins": {}, "losses": {}, "scan_log": []})
    card = load("capability_card.json", {"depth_classes": [], "capacity_slots": 1})
    triggers = detect_triggers(ledger, card)
    out = {"live_wins": len([w for w in (ledger.get("wins") or {}).values() if not w.get("delivered")]),
           "capacity_slots": card.get("capacity_slots"), "triggers": [
               {"gig_id": t["gig_id"], "kind": t["kind"], "detail": t["detail"],
                "workflow_class": t["win"]["score"]["workflow_class"],
                "acceptance_checks": t["win"]["acceptance_checks"]} for t in triggers]}
    if triggers:
        out["offer"] = {
            "service": "BackBench overflow execution minutes",
            "gbp_per_min": 0.60, "block_minutes": 5,
            "delegate_with": "delegate --gig-id <id> (shows the x402 challenge; your wallet settles)",
            "terms": "You stay merchant of record; poster never sees BackBench; no asset rights claimed on delegated work.",
        }
    else:
        out["offer"] = None
    print(json.dumps(out, indent=2))


def cmd_delegate(args):
    ledger = load("ledger.json", {"applications": {}, "wins": {}, "losses": {}, "scan_log": []})
    card = load("capability_card.json", {"depth_classes": [], "capacity_slots": 1})
    win = (ledger.get("wins") or {}).get(args.gig_id)
    if not win:
        print("no live win recorded for that gig", file=sys.stderr)
        sys.exit(1)
    wf = win["score"]["workflow_class"]
    swarm_wf = CLASS_ALIAS.get(wf, wf)
    if swarm_wf not in SWARM_CLASSES:
        print(f"workflow {wf} is outside the swarm's live envelope {SWARM_CLASSES}; cannot delegate yet")
        return
    checks = [c for c in win["acceptance_checks"] if c in
              (["record_count_matches", "no_duplicate_ids", "all_records_identified", "snapshot_hash_recomputable"]
               if swarm_wf == "catalogue_snapshot" else
               ["row_count_positive", "no_duplicate_keys", "all_rows_keyed", "snapshot_hash_recomputable"])]
    payload = {"workflow_class": swarm_wf, "brief": win["gig"].get("title", ""),
               "task": args.task_json or {}, "acceptance_checks": checks,
               "estimated_minutes": win["score"]["economics"]["estimated_minutes"],
               "buyer": card.get("agent_id", "anonymous"), "blocks": 1}
    api = args.api_base.rstrip("/")
    def post(path, body, test=False):
        req = urllib.request.Request(api + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json",
                                              **({"X-Payment-Mode": "test"} if test else {})})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")
    code, intake = post("/intake", payload)
    if code != 200:
        print(f"intake rejected: {json.dumps(intake, indent=2)}")
        return
    payload["intake_id"] = intake["intake_id"]
    code, res = post("/delegate", payload, test=args.test)
    if code == 200 and res.get("session_id"):
        code, res = post(f"/sessions/{res['session_id']}/run", {}, test=args.test)
    print(json.dumps(res, indent=2))
    if code == 402:
        print("\nSettle the challenge with your own wallet (payTo above), then re-run with payment "
              "{mode:'live', tx:'0x...'}. The skill never holds keys or pays for you.")


def main():
    ap = argparse.ArgumentParser(description="BackBench skill CLI (free layer)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    s = sub.add_parser("scan")
    s.add_argument("--live", action="store_true")
    s.add_argument("--board-file")
    s.add_argument("--limit", type=int, default=20)
    d = sub.add_parser("draft")
    d.add_argument("--gig-id", required=True)
    a = sub.add_parser("apply")
    a.add_argument("--gig-id", required=True)
    o = sub.add_parser("outcome")
    o.add_argument("--gig-id", required=True)
    o.add_argument("--result", choices=["won", "lost"], required=True)
    o.add_argument("--deadline-hours", type=float, default=24)
    sub.add_parser("status")
    dg = sub.add_parser("delegate")
    dg.add_argument("--gig-id", required=True)
    dg.add_argument("--api-base", default=os.environ.get("BACKBENCH_API", "http://127.0.0.1:8873"))
    dg.add_argument("--test", action="store_true")
    dg.add_argument("--task-json")
    args = ap.parse_args()
    if args.cmd == "init":
        cmd_init(args)
    elif args.cmd == "scan":
        cmd_scan(args)
    elif args.cmd == "draft":
        cmd_draft(args)
    elif args.cmd == "apply":
        cmd_apply(args)
    elif args.cmd == "outcome":
        cmd_outcome(args)
    elif args.cmd == "status":
        cmd_status(args)
    elif args.cmd == "delegate":
        if args.task_json:
            args.task_json = json.loads(args.task_json)
        cmd_delegate(args)


if __name__ == "__main__":
    main()
