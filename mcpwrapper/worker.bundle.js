// src/shared_hosts.js
var SHARED_HOSTS = /* @__PURE__ */ new Set([
  "github.com",
  "google.com",
  "microsoft.com",
  "gist.github.com",
  "github.io",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "docs.google.com",
  "drive.google.com",
  "sites.google.com",
  "storage.googleapis.com",
  "live.com",
  "onedrive.live.com",
  "amazonaws.com",
  "s3.amazonaws.com",
  "cloudfront.net",
  "cloudflare.com",
  "workers.dev",
  "pages.dev",
  "netlify.app",
  "vercel.app",
  "herokuapp.com",
  "azurewebsites.net",
  "blob.core.windows.net",
  "blogspot.com",
  "wordpress.com",
  "wixsite.com",
  "weebly.com",
  "glitch.me",
  "replit.dev",
  "dropbox.com",
  "dl.dropboxusercontent.com",
  "mediafire.com",
  "discord.com",
  "cdn.discordapp.com",
  "telegram.org",
  "tinyurl.com",
  "archive.org"
]);
var shared_hosts_default = SHARED_HOSTS;

// src/reputation.js
var FETCH_TIMEOUT_MS = 2500;
var _cache = /* @__PURE__ */ new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e)
    return void 0;
  if (Date.now() > e.expires) {
    _cache.delete(key);
    return void 0;
  }
  return e.value;
}
function cacheSet(key, value, ttlMs) {
  _cache.set(key, { value, expires: Date.now() + ttlMs });
  if (_cache.size > 500) {
    const first = _cache.keys().next().value;
    _cache.delete(first);
  }
}
async function fetchWithTimeout(url, { timeout = FETCH_TIMEOUT_MS, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    return res;
  } finally {
    clearTimeout(t);
  }
}
async function fetchJson(url, opts = {}) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok)
    throw new Error(`HTTP ${res.status} for feed`);
  return res.json();
}
async function settled(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}
async function dohQuery(name, type = "A") {
  const key = `doh:${type}:${name}`;
  const hit = cacheGet(key);
  if (hit !== void 0)
    return hit;
  const data = await fetchJson(
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`
  );
  const answers = (data.Answer || []).map((a) => a.data);
  cacheSet(key, answers, 10 * 60 * 1e3);
  return answers;
}
async function resolveIPv4(host) {
  const answers = await dohQuery(host, "A");
  const ip = answers.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) || null;
  return ip;
}
function isPrivateIP(ip) {
  const p = ip.split(".").map(Number);
  if (p[0] === 10)
    return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    return true;
  if (p[0] === 192 && p[1] === 168)
    return true;
  if (p[0] === 127)
    return true;
  if (p[0] === 169 && p[1] === 254)
    return true;
  if (p[0] === 192 && p[1] === 0 && p[2] === 2)
    return true;
  if (p[0] === 198 && p[1] === 51 && p[2] === 100)
    return true;
  if (p[0] === 203 && p[1] === 0 && p[2] === 113)
    return true;
  if (p[0] === 0)
    return true;
  return false;
}
var _urlhausInflight = null;
async function getUrlhausLists() {
  const hit = cacheGet("urlhaus:lists");
  if (hit)
    return hit;
  if (_urlhausInflight)
    return _urlhausInflight;
  _urlhausInflight = (async () => {
    const res = await fetchWithTimeout("https://urlhaus.abuse.ch/downloads/text/");
    if (!res.ok)
      throw new Error(`URLhaus HTTP ${res.status}`);
    const text = await res.text();
    const urls = /* @__PURE__ */ new Set();
    const hosts = /* @__PURE__ */ new Set();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#"))
        continue;
      urls.add(t.replace(/\/+$/, "").toLowerCase());
      try {
        const h = new URL(t).hostname.toLowerCase();
        if (h)
          hosts.add(h);
      } catch {
      }
    }
    const lists = { urls, hosts };
    cacheSet("urlhaus:lists", lists, 30 * 60 * 1e3);
    return lists;
  })();
  try {
    return await _urlhausInflight;
  } finally {
    _urlhausInflight = null;
  }
}
function urlhausMatch(lists, host, normalizedUrl) {
  if (normalizedUrl && lists.urls.has(normalizedUrl))
    return { matched: true, via: "exact_url" };
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join(".");
    if (lists.hosts.has(suffix)) {
      if (shared_hosts_default.has(suffix) || shared_hosts_default.has(host)) {
        return { matched: false, shared_host: suffix };
      }
      return { matched: true, via: "host", host: suffix };
    }
  }
  return { matched: false };
}
async function checkAbuseIPDB(ip, apiKey) {
  if (!apiKey)
    return { status: "skipped", reason: "no_api_key" };
  if (isPrivateIP(ip))
    return { status: "skipped", reason: "private_ip" };
  const data = await fetchJson(
    `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose`,
    { headers: { Key: apiKey, Accept: "application/json" } }
  );
  const d = data.data || {};
  return {
    status: "ok",
    ipAddress: d.ipAddress || ip,
    abuseConfidenceScore: d.abuseConfidenceScore ?? 0,
    totalReports: d.totalReports ?? 0,
    countryCode: d.countryCode || null,
    usageType: d.usageType || null,
    isp: d.isp || null
  };
}
var SPAMHAUS_LISTED_CODES = /* @__PURE__ */ new Set([
  "127.0.0.2",
  "127.0.0.3",
  // SBL
  "127.0.0.4",
  "127.0.0.5",
  "127.0.0.6",
  "127.0.0.7",
  // XBL
  "127.0.0.10",
  "127.0.0.11"
  // PBL
]);
var SPAMHAUS_BLOCKED_CODES = /* @__PURE__ */ new Set([
  "127.255.255.252",
  "127.255.255.254",
  "127.255.255.255"
]);
async function checkSpamhaus(ip) {
  if (isPrivateIP(ip))
    return { status: "skipped", reason: "private_ip" };
  const reversed = ip.split(".").reverse().join(".");
  const answers = await dohQuery(`${reversed}.zen.spamhaus.org`, "A");
  const records = answers.map((a) => String(a).trim().replace(/\.$/, ""));
  if (records.some((r) => SPAMHAUS_BLOCKED_CODES.has(r))) {
    return { status: "unavailable", reason: "resolver_blocked", listed: false };
  }
  const hits = records.filter((r) => SPAMHAUS_LISTED_CODES.has(r));
  return { status: "ok", listed: hits.length > 0, records: hits };
}
async function getDomainAgeDays(host) {
  const reg = registrableDomain(host);
  const key = `rdap:${reg}`;
  const hit = cacheGet(key);
  if (hit !== void 0)
    return hit;
  try {
    const data = await fetchJson(`https://rdap.org/domain/${encodeURIComponent(reg)}`);
    const events = data.events || [];
    const reg2 = events.find((e) => e.eventAction === "registration");
    if (!reg2 || !reg2.eventDate) {
      cacheSet(key, null, 24 * 3600 * 1e3);
      return null;
    }
    const days = Math.floor((Date.now() - new Date(reg2.eventDate).getTime()) / 864e5);
    const age = days >= 0 ? days : null;
    cacheSet(key, age, 24 * 3600 * 1e3);
    return age;
  } catch {
    cacheSet(key, null, 6 * 3600 * 1e3);
    return null;
  }
}
function registrableDomain(host) {
  const labels = host.split(".");
  const twoLevel = /* @__PURE__ */ new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.nz", "co.jp", "com.br"]);
  if (labels.length >= 3 && twoLevel.has(labels.slice(-2).join("."))) {
    return labels.slice(-3).join(".");
  }
  return labels.length >= 2 ? labels.slice(-2).join(".") : host;
}
var SUSPICIOUS_TLDS = /* @__PURE__ */ new Set([
  "tk",
  "ml",
  "ga",
  "cf",
  "gq",
  "xyz",
  "top",
  "buzz",
  "click",
  "link",
  "zip",
  "mov",
  "sbs",
  "cyou",
  "rest",
  "cam",
  "bar",
  "party",
  "stream",
  "download",
  "review",
  "country",
  "kim",
  "cricket",
  "science",
  "work",
  "men",
  "loan",
  "win",
  "bid",
  "trade",
  "webcam",
  "date",
  "faith",
  "racing",
  "accountant"
]);
var URL_SHORTENERS = /* @__PURE__ */ new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "shorturl.at",
  "cutt.ly",
  "rebrand.ly",
  "tiny.cc",
  "rb.gy",
  "s.id",
  "shorturl.com",
  "bl.ink",
  "soo.gd",
  "v.gd",
  "clck.ru",
  "t.ly"
]);
var IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
function analyzeHeuristics({ host, rawUrl, registrable }) {
  const h = {
    punycode: /(^|\.)xn--/.test(host),
    ip_literal: IPV4_RE.test(host) || host.includes(":"),
    url_shortener: URL_SHORTENERS.has(host),
    suspicious_tld: SUSPICIOUS_TLDS.has(host.split(".").pop()),
    hyphen_count: (registrable.match(/-/g) || []).length,
    digit_count: (registrable.match(/\d/g) || []).length,
    label_count: host.split(".").length,
    has_at_symbol: rawUrl.includes("@"),
    long_url: rawUrl.length > 150
  };
  h.excessive_hyphens = h.hyphen_count >= 4;
  h.digit_heavy = h.digit_count >= 5;
  h.deep_subdomains = h.label_count >= 5;
  return h;
}
function heuristicScore(h) {
  let s = 0;
  const applied = [];
  const add = (cond, pts, name) => {
    if (cond) {
      s += pts;
      applied.push(name);
    }
  };
  add(h.punycode, 15, "punycode");
  add(h.ip_literal, 20, "ip_literal");
  add(h.url_shortener, 10, "url_shortener");
  add(h.suspicious_tld, 10, "suspicious_tld");
  add(h.excessive_hyphens, 10, "excessive_hyphens");
  add(h.digit_heavy, 5, "digit_heavy");
  add(h.deep_subdomains, 10, "deep_subdomains");
  add(h.has_at_symbol, 15, "at_symbol");
  add(h.long_url, 5, "long_url");
  return { score: s, applied };
}
function parseInput(raw) {
  const input = String(raw || "").trim().slice(0, 2048);
  if (!input)
    throw Object.assign(new Error("missing url/domain/ip parameter"), { statusCode: 400 });
  if (IPV4_RE.test(input)) {
    return { kind: "ip", host: input, ip: input, rawUrl: input, registrable: input };
  }
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw Object.assign(new Error("invalid url/domain"), { statusCode: 400 });
  }
  if (!/^[a-z0-9.-]+$/i.test(url.hostname)) {
    throw Object.assign(new Error("invalid hostname"), { statusCode: 400 });
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const normalized = `${url.protocol}//${host}${url.pathname}`.replace(/\/+$/, "").toLowerCase() + (url.search || "");
  return {
    kind: "url",
    host,
    rawUrl: input,
    normalizedUrl: normalized,
    registrable: registrableDomain(host)
  };
}
async function checkReputation(rawInput, { abuseIPDBKey = null } = {}) {
  const parsed = parseInput(rawInput);
  const t0 = Date.now();
  let ip = parsed.kind === "ip" ? parsed.ip : null;
  if (!ip) {
    const r = await settled(resolveIPv4(parsed.host));
    ip = r.ok ? r.value : null;
  }
  const heuristics = parsed.kind === "ip" ? { ip_literal: true } : analyzeHeuristics(parsed);
  const [urlhausR, abuseR, spamhausR, ageR] = await Promise.all([
    settled(getUrlhausLists().then(
      (lists) => parsed.kind === "ip" ? { matched: false } : urlhausMatch(lists, parsed.host, parsed.normalizedUrl)
    )),
    settled(ip ? checkAbuseIPDB(ip, abuseIPDBKey) : { status: "skipped", reason: "no_ip" }),
    settled(ip ? checkSpamhaus(ip) : { status: "skipped", reason: "no_ip" }),
    settled(parsed.kind === "ip" ? null : getDomainAgeDays(parsed.host))
  ]);
  let score = 0;
  const contributions = [];
  const add = (pts, name) => {
    score += pts;
    contributions.push({ signal: name, points: pts });
  };
  const signals = { heuristics };
  if (urlhausR.ok) {
    signals.urlhaus = urlhausR.value.matched ? { listed: true, via: urlhausR.value.via, matched_host: urlhausR.value.host || null } : { listed: false };
    if (urlhausR.value.matched)
      add(70, "urlhaus_listed");
  } else {
    signals.urlhaus = { listed: false, status: "error", error: urlhausR.error };
  }
  if (abuseR.ok) {
    const a = abuseR.value;
    signals.abuseipdb = a;
    if (a.status === "ok") {
      const c = a.abuseConfidenceScore || 0;
      if (c >= 75)
        add(60, "abuseipdb_confidence>=75");
      else if (c >= 50)
        add(40, "abuseipdb_confidence>=50");
      else if (c >= 25)
        add(20, "abuseipdb_confidence>=25");
    }
  } else {
    signals.abuseipdb = { status: "error", error: abuseR.error };
  }
  if (spamhausR.ok) {
    const s = spamhausR.value;
    signals.spamhaus = s.status === "ok" ? { listed: s.listed } : { listed: false, status: s.status, reason: s.reason };
    if (s.status === "ok" && s.listed)
      add(50, "spamhaus_listed");
  } else {
    signals.spamhaus = { listed: false, status: "error", error: spamhausR.error };
  }
  const ageDays = ageR.ok ? ageR.value : null;
  signals.domain_age_days = ageDays;
  if (ageDays !== null && parsed.kind !== "ip") {
    if (ageDays < 30)
      add(25, "domain_age<30d");
    else if (ageDays < 90)
      add(15, "domain_age<90d");
  }
  if (parsed.kind !== "ip") {
    const hs = heuristicScore(heuristics);
    if (hs.score > 0) {
      score += hs.score;
      for (const name of hs.applied)
        contributions.push({ signal: `heuristic:${name}`, points: null });
    }
    signals.heuristics_applied = hs.applied;
  }
  score = Math.min(100, Math.max(0, score));
  const verdict = score >= 60 ? "malicious" : score >= 30 ? "suspicious" : "clean";
  return {
    verdict,
    score,
    signals,
    contributions,
    checked_at: (/* @__PURE__ */ new Date()).toISOString(),
    query: { input: parsed.kind === "ip" ? parsed.ip : parsed.host, kind: parsed.kind, resolved_ip: ip },
    elapsed_ms: Date.now() - t0
  };
}

// src/index.js
var JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
  // verdicts are per-query; never cache at edge
};
var FACILITATOR = "https://facilitator.xpay.sh";
var NETWORK = "eip155:8453";
var USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
var PAY_TO = "0x48Cda0da34816Db1F997C3D3b167a4f6af850CB2";
var MONAD_NETWORK = "eip155:143";
var MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
var MONAD_FACILITATOR = "https://facilitator.pieverse.io";
var PRICE_ATOMIC = "10000";
var PRICE_HUMAN = "$0.01";
var MAX_TIMEOUT = 300;
var _hits = /* @__PURE__ */ new Map();
var RATE_LIMIT = 120;
var RATE_WINDOW_MS = 6e4;
function rateLimited(ip) {
  const now = Date.now();
  let e = _hits.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + RATE_WINDOW_MS };
    _hits.set(ip, e);
    if (_hits.size > 2e3)
      _hits.clear();
  }
  e.count += 1;
  return e.count > RATE_LIMIT;
}
function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}
function b64encode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes)
    bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(s) {
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function paymentRequirements() {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: PRICE_ATOMIC,
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT,
    extra: {
      assetTransferMethod: "eip3009",
      name: "USDC",
      version: "2"
    }
  };
}
function paymentRequirementsMonad() {
  return {
    scheme: "exact",
    network: MONAD_NETWORK,
    amount: PRICE_ATOMIC,
    asset: MONAD_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT,
    extra: {
      assetTransferMethod: "eip3009",
      name: "MONAD_USDC",
      version: "2"
    }
  };
}
var TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "Full URL to check, e.g. https://example.com/login"
    },
    domain: {
      type: "string",
      description: "Domain to check, e.g. example.com"
    },
    ip: {
      type: "string",
      description: "IPv4 or IPv6 address to check, e.g. 203.0.113.7"
    }
  },
  minProperties: 1,
  anyOf: [{ required: ["url"] }, { required: ["domain"] }, { required: ["ip"] }]
};
var TOOL_EXAMPLE_OUTPUT = {
  input: "https://example.com/login",
  verdict: "clean",
  score: 0,
  signals: {
    urlhaus_listed: false,
    abuseipdb_confidence: null,
    spamhaus_listed: false,
    domain_age_days: 11231
  },
  checked_at: "2026-09-29T10:00:00.000Z"
};
function bazaarExtension() {
  return {
    info: {
      input: {
        type: "mcp",
        protocol: "Streamable HTTP (JSON-RPC 2.0)",
        method: "tools/call",
        tool: "check_reputation",
        argsSchema: TOOL_INPUT_SCHEMA
      },
      output: {
        type: "json",
        example: TOOL_EXAMPLE_OUTPUT
      }
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["input", "output"],
      properties: {
        input: { type: "object", additionalProperties: true },
        output: { type: "object", additionalProperties: true }
      },
      additionalProperties: true
    }
  };
}
function paymentRequiredResponse(base) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: base + "/mcp",
      description: `MCP tool check_reputation: is this URL/domain/IP malicious? Verdict + score + signals. Price: ${PRICE_HUMAN} USDC on Base per call.`,
      mimeType: "application/json",
      serviceName: "Threat Reputation MCP",
      tags: ["security", "threat-intel", "reputation", "mcp", "x402"]
    },
    accepts: [paymentRequirements(), paymentRequirementsMonad()],
    extensions: { bazaar: bazaarExtension() }
  };
}
function mcpFail402(reason, base, rpcId) {
  const body = {
    jsonrpc: "2.0",
    ...rpcId !== void 0 ? { id: rpcId } : {},
    error: {
      code: 402,
      message: `Payment required: ${PRICE_HUMAN} USDC on Base (${NETWORK}) via x402 v2. Sign an EIP-3009 TransferWithAuthorization and retry this tools/call with a PAYMENT-SIGNATURE header carrying the base64 payment payload. Settlement is sponsored (no gas needed); funds go to ${PAY_TO}.`,
      data: {
        x402Version: 2,
        reason,
        accepts: [paymentRequirements(), paymentRequirementsMonad()],
        facilitator: FACILITATOR
      }
    }
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": b64encode(paymentRequiredResponse(base))
    }
  });
}
async function settleViaXpay(paymentPayload) {
  const _reqNet = paymentPayload.network || (paymentPayload.accepted || {}).network;
  const _fac = _reqNet === MONAD_NETWORK ? MONAD_FACILITATOR : FACILITATOR;
  const body = {
    x402Version: 2,
    paymentPayload,
    paymentRequirements: paymentRequirements()
  };
  let v;
  try {
    const r = await fetch(`${_fac}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25e3)
    });
    v = await r.json();
  } catch (e) {
    return { ok: false, reason: `facilitator /verify unreachable: ${e}` };
  }
  if (!v.isValid) {
    return { ok: false, reason: `payment invalid: ${v.invalidReason || "unknown"}` };
  }
  let s;
  try {
    const r = await fetch(`${_fac}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9e4)
    });
    s = await r.json();
  } catch (e) {
    return { ok: false, reason: `facilitator /settle unreachable: ${e}` };
  }
  if (!s.success) {
    return { ok: false, reason: `settlement failed: ${s.errorReason || "unknown"}` };
  }
  return { ok: true, info: s };
}
var MCP_PROTOCOL_VERSION = "2025-06-18";
var SERVER_INFO = {
  name: "threat-reputation",
  title: "Threat Reputation API",
  version: "1.0.0"
};
function toolDefinition() {
  return {
    name: "check_reputation",
    title: "Check threat reputation",
    description: `Check whether a URL, domain, or IP address is malicious. Returns a verdict (clean / suspicious / malicious), a 0-100 risk score, and the threat-intel signals behind it (URLhaus, AbuseIPDB, Spamhaus ZEN, domain age, heuristics). PRICE: ${PRICE_HUMAN} USDC on Base (${NETWORK}) per call, paid via x402 v2: call without payment to receive HTTP 402 with payment instructions, then retry with a PAYMENT-SIGNATURE header carrying the signed EIP-3009 authorization. No API key needed.`,
    inputSchema: TOOL_INPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    _meta: {
      "x402/payment": {
        price: PRICE_HUMAN,
        atomicAmount: PRICE_ATOMIC,
        asset: "USDC",
        assetContract: USDC,
        network: NETWORK,
        scheme: "exact",
        payTo: PAY_TO,
        facilitator: FACILITATOR
      }
    }
  };
}
function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== void 0)
    err.data = data;
  return json({ jsonrpc: "2.0", id, error: err });
}
async function handleToolsCall(id, params, request, env, base) {
  const name = params && params.name;
  if (name !== "check_reputation") {
    return rpcError(id, -32602, `unknown tool: ${name || "(missing)"}`);
  }
  const args = params && params.arguments || {};
  const raw = args.url || args.domain || args.ip;
  if (!raw || typeof raw !== "string") {
    return rpcError(id, -32602, "provide one of: url, domain, ip (string)");
  }
  const sigHeader = request.headers.get("PAYMENT-SIGNATURE");
  if (!sigHeader)
    return mcpFail402("payment required", base, id);
  let payload;
  try {
    payload = b64decode(sigHeader);
  } catch (e) {
    return rpcError(id, -32602, `bad PAYMENT-SIGNATURE: ${e}`);
  }
  const accepted = payload.accepted || {};
  const scheme = payload.scheme || accepted.scheme;
  const network = payload.network || accepted.network;
  if (payload.x402Version !== 2 || scheme !== "exact") {
    return mcpFail402("unsupported payment scheme/version", base, id);
  }
  if (network !== NETWORK && network !== MONAD_NETWORK) {
    return mcpFail402(`wrong network: ${network}`, base, id);
  }
  const { ok, info, reason } = await settleViaXpay(payload);
  if (!ok)
    return mcpFail402(reason, base, id);
  let verdict;
  try {
    verdict = await checkReputation(raw, { abuseIPDBKey: env.ABUSEIPDB_KEY || null });
  } catch (err) {
    const status = err.statusCode || 500;
    return rpcError(
      id,
      -32603,
      status === 400 ? "bad_request: provide a valid url, domain, or ip" : "internal_error"
    );
  }
  const paymentResponse = b64encode({
    success: true,
    transaction: info.transaction,
    network: info.network || NETWORK,
    payer: info.payer
  });
  return json(
    {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(verdict) }],
        isError: false
      }
    },
    200,
    { "PAYMENT-RESPONSE": paymentResponse }
  );
}
async function handleMcpMessage(msg, request, env, base) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id, -32600, "invalid JSON-RPC 2.0 request");
  }
  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: `Threat-intel lookups for AI agents. tools/list is free. tools/call check_reputation costs ${PRICE_HUMAN} USDC on Base per call (x402 v2, EIP-3009 exact). Call unpaid to receive payment instructions (HTTP 402).`
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "tools/list":
      return rpcResult(id, { tools: [toolDefinition()] });
    case "tools/call":
      return handleToolsCall(id, msg.params, request, env, base);
    case "ping":
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}
async function handleMcp(request, env, base) {
  if (request.method !== "POST") {
    return json(
      { error: "method_not_allowed", hint: "POST JSON-RPC 2.0 to /mcp (Streamable HTTP)" },
      405
    );
  }
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return json({ error: "bad_request", hint: "Content-Type must be application/json" }, 400);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad_request", hint: "invalid JSON body" }, 400);
  }
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (rateLimited(ip)) {
    return json({ error: "rate_limited", retry_after_seconds: 60 }, 429);
  }
  if (Array.isArray(body)) {
    const out = [];
    for (const m of body) {
      const r = await handleMcpMessage(m, request, env, base);
      if (r.status !== 202)
        out.push(await r.json());
    }
    return json(out.length ? out : null, out.length ? 200 : 202);
  }
  return handleMcpMessage(body, request, env, base);
}
function x402WellKnown(base) {
  return {
    x402Version: 2,
    resources: [
      {
        url: base + "/mcp",
        method: "POST",
        protocol: "MCP Streamable HTTP (JSON-RPC 2.0)",
        description: paymentRequiredResponse(base).resource.description,
        accepts: [paymentRequirements(), paymentRequirementsMonad()],
        extensions: { bazaar: bazaarExtension() }
      }
    ]
  };
}
function agentJson(base) {
  const origin = base.replace(/^https?:\/\//, "");
  return {
    version: "1.3",
    origin,
    display_name: "Threat Reputation MCP",
    description: `MCP server (Streamable HTTP): check whether a URL, domain, or IP is malicious. ${PRICE_HUMAN} USDC per tool call on Base, paid via x402 v2 (no API key).`,
    payout_address: PAY_TO,
    payments: {
      x402: {
        networks: [{ network: "base", asset: "USDC", contract: USDC }]
      }
    },
    mcp: {
      endpoint: base + "/mcp",
      transport: "streamable-http",
      tools: [
        {
          name: "check_reputation",
          price: { amount: 0.01, currency: "USDC" }
        }
      ]
    }
  };
}
function skillMd(base) {
  return `# Threat Reputation MCP

Threat-intel lookups for AI agents, pay-per-call via x402 v2.

- MCP endpoint (Streamable HTTP): \`POST ${base}/mcp\`
- Tool: \`check_reputation({url | domain | ip})\` \u2192 {verdict: clean|suspicious|malicious, score 0-100, signals}
- Price: ${PRICE_HUMAN} USDC on Base (${NETWORK}), scheme \`exact\` (EIP-3009)
- Pay-to: \`${PAY_TO}\` (receive-only; server never signs)
- Facilitator: ${FACILITATOR} (sponsors settlement gas \u2014 buyer needs no ETH)
- Flow: \`initialize\` \u2192 \`tools/list\` (free) \u2192 \`tools/call\` unpaid \u2192 HTTP 402 with base64 \`PAYMENT-REQUIRED\` header \u2192 retry with \`PAYMENT-SIGNATURE\` header.
- Discovery: \`/.well-known/x402\`, \`/.well-known/agent.json\`, Bazaar \`extensions.bazaar\` on every 402.
- Also served via RapidAPI (human tier): https://rapidapi.com/hsharmanov07/api/threat-reputation-api
`;
}
var src_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const base = `${url.protocol}//${url.host}`;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok", time: (/* @__PURE__ */ new Date()).toISOString() });
    }
    if (url.pathname === "/mcp") {
      return handleMcp(request, env, base);
    }
    if (url.pathname === "/.well-known/x402" && request.method === "GET") {
      return json(x402WellKnown(base));
    }
    if (url.pathname === "/.well-known/agent.json" && request.method === "GET") {
      return json(agentJson(base));
    }
    if (url.pathname === "/skill.md" && request.method === "GET") {
      return new Response(skillMd(base), {
        headers: { "content-type": "text/markdown; charset=utf-8" }
      });
    }
    if (url.pathname === "/" && request.method === "GET") {
      return json({
        service: "threat-reputation",
        tiers: {
          rapidapi: "GET /reputation (human tier, RapidAPI key)",
          mcp_x402: `POST /mcp (machine tier, ${PRICE_HUMAN} USDC/call on Base)`
        },
        mcp_endpoint: base + "/mcp",
        price_per_call: PRICE_HUMAN,
        asset: "USDC on Base",
        payTo: PAY_TO,
        protocol: "MCP Streamable HTTP + x402 v2, scheme exact (EIP-3009)"
      });
    }
    if (url.pathname !== "/reputation" || request.method !== "GET") {
      return json(
        { error: "not_found", hint: "GET /reputation?url=<url-or-domain> or POST /mcp" },
        404
      );
    }
    const expected = env.PROXY_SECRET;
    if (expected) {
      const got = request.headers.get("X-RapidAPI-Proxy-Secret");
      if (!got || got !== expected) {
        return json({ error: "unauthorized", hint: "missing or invalid proxy secret" }, 401);
      }
    }
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (rateLimited(ip)) {
      return json({ error: "rate_limited", retry_after_seconds: 60 }, 429);
    }
    const raw = url.searchParams.get("url") || url.searchParams.get("domain") || url.searchParams.get("ip");
    if (!raw) {
      return json({ error: "bad_request", hint: "provide ?url=<url-or-domain> (or ?domain= / ?ip=)" }, 400);
    }
    try {
      const result = await checkReputation(raw, { abuseIPDBKey: env.ABUSEIPDB_KEY || null });
      return json(result);
    } catch (err) {
      const status = err.statusCode || 500;
      return json({ error: status === 400 ? "bad_request" : "internal_error" }, status);
    }
  }
};
export {
  src_default as default
};
