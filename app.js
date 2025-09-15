// app.js — Playwright network debugger (CommonJS, single file)
// Node 18+  |  npm i playwright  |  run: node app.js
//
// WHAT THIS DOES (exactly as requested):
// - Single "Full network capture" section — no separate redirects section.
// - Logs ONLY resource types: Document / XHR / Fetch (never scripts, css, images, fonts, etc).
// - Excludes static assets by extension, always.
// - Obeys scope filter: same-domain / cross-origin / any.
// - ALWAYS includes geo.captcha-delivery.com requests (GET/POST), with query params (GET) or body (POST),
//   and labels them "CAPTCHA/BLOCK" (/captcha) or "Device Check" (/interstitial).
// - ALWAYS shows, when present:
//   • Request header: x-datadome-clientid (full value)
//   • Request Cookie: datadome=… (full value)
//   • RESPONSE Set-Cookie: datadome=… (full value)
// - If Playwright’s runtime APIs don’t expose Set-Cookie on navigation responses, we FALL BACK to the saved HAR
//   and augment each printed line, so you WILL see the DataDome Set-Cookie exactly under the matching response line.
// - Works on Chromium, Firefox, WebKit. Colorized output. Cross-platform console clear (best effort).

console.clear();

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { chromium, firefox, webkit } = require("playwright");

/* ==============================
   Colors (no deps)
============================== */
const C = {
  reset: "\x1b[0m",
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

/* ==============================
   Constants / helpers
============================== */
// NEVER log static assets in the capture:
const STATIC_EXT_RE =
  /\.(avi|flv|mka|mkv|mov|mp4|mpeg|mpg|mp3|flac|ogg|ogm|opus|wav|webm|webp|bmp|gif|ico|jpeg|jpg|png|svg|svgz|swf|eot|otf|ttf|woff|woff2|css|less|js|map)(\?|#|$)/i;

// Only these resource types are logged:
const LOG_TYPES = new Set(["document", "xhr", "fetch"]);

// DataDome / challenge related hosts (always include)
const DD_HOSTS = new Set([
  "geo.captcha-delivery.com",   // interstitial/captcha endpoints
  "dd.prod.captcha-delivery.com",
  "dd.immoscout24.ch",
]);

function pad2(n) {
  const s = String(n);
  return s.length >= 2 ? s : " " + s;
}
function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}
function originOf(u) {
  try {
    const { protocol, host } = new URL(u);
    return `${protocol}//${host}`;
  } catch {
    return "";
  }
}
function isStatic(url) {
  return STATIC_EXT_RE.test(url);
}
function suffixBase(host) {
  const parts = host.split(".");
  if (parts.length < 2) return host;
  return parts.slice(-2).join(".");
}
function sameDomain(uHost, baseHost) {
  return uHost === baseHost || uHost.endsWith("." + baseHost);
}
function parseQuery(urlStr) {
  try {
    const u = new URL(urlStr);
    const o = {};
    for (const [k, v] of u.searchParams.entries()) o[k] = v;
    return o;
  } catch {
    return null;
  }
}
function j2(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
function nowISO() {
  return new Date().toISOString();
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function sanitizePart(s) {
  return s.replace(/[^a-z0-9_.-]/gi, "_");
}
function classifyDD(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname !== "geo.captcha-delivery.com") return null;
    if (u.pathname.startsWith("/captcha")) return "CAPTCHA/BLOCK";
    if (u.pathname.startsWith("/interstitial")) return "Device Check";
    return "Challenge";
  } catch {
    return null;
  }
}
function prettyType(rt, ddLabel) {
  const up = rt.toUpperCase();
  return ddLabel ? `${up} ${C.yellow(`[${ddLabel}]`)}` : up;
}
function prettyStatus(status) {
  if (status >= 200 && status < 300) return `${C.green("✅")} ${status}`;
  if (status === 403) return `${C.red("🚫")} 403`;
  if (status >= 300 && status < 400) return `${C.blue("ℹ️")} ${status}`;
  if (status === 0) return `${C.red("✖")} 0`;
  return `${status}`;
}
function headerValueCase(headers, key) {
  const lower = key.toLowerCase();
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

/**
 * Robustly extract ALL Set-Cookie lines that contain datadome= from the response.
 * Uses multiple fallbacks to handle Playwright version differences.
 */
function getDataDomeSetCookies(response) {
  const hits = [];

  // 1) headerValues("set-cookie") → array
  try {
    if (typeof response.headerValues === "function") {
      const arr = response.headerValues("set-cookie") || [];
      for (const v of arr) if (typeof v === "string" && /datadome=/i.test(v)) hits.push(v);
      if (hits.length) return hits;
    }
  } catch {}

  // 2) headersArray()
  try {
    const arr = typeof response.headersArray === "function" ? response.headersArray() : null;
    if (Array.isArray(arr) && arr.length) {
      for (const h of arr) {
        if (h && typeof h.name === "string" && h.name.toLowerCase() === "set-cookie" && /datadome=/i.test(h.value || "")) {
          hits.push(h.value);
        }
      }
      if (hits.length) return hits;
    }
  } catch {}

  // 3) headers() (lower-cased, may be compressed)
  try {
    const hobj = response.headers?.() || {};
    const raw = hobj["set-cookie"];
    if (!raw) return hits;
    if (Array.isArray(raw)) {
      for (const v of raw) if (typeof v === "string" && /datadome=/i.test(v)) hits.push(v);
    } else if (typeof raw === "string") {
      const parts = raw.split(/,(?=[^;]+?=)/g).map((s) => s.trim());
      for (const p of parts) if (/datadome=/i.test(p)) hits.push(p);
    }
  } catch {}

  return hits;
}

/* ==============================
   Prompt helpers
============================== */
async function askChoice(rl, title, items, defIdx = 0) {
  output.write(`\n${C.bold(title)}\n\n`);
  items.forEach((label, i) => {
    const def = i === defIdx ? " (default)" : "";
    output.write(`  ${i}) ${label}${def}\n`);
  });
  const ans = await rl.question(`Enter number (default: ${defIdx}): `);
  const n = ans.trim() === "" ? defIdx : Number(ans.trim());
  return Number.isInteger(n) && n >= 0 && n < items.length ? n : defIdx;
}

async function askUrl(rl) {
  while (true) {
    const raw = await rl.question(`\nWhich website or API endpoint do you want to open? `);
    const s = raw.trim();
    if (!s) {
      output.write(
        `${C.red("❌ Invalid URL.")} ${C.dim(
          "Please try again (example: leboncoin.fr or https://leboncoin.fr)."
        )}\n`
      );
      continue;
    }
    let url = s;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    try {
      new URL(url);
      return url;
    } catch {
      output.write(
        `${C.red("❌ Invalid URL.")} ${C.dim(
          "Please try again (example: leboncoin.fr or https://leboncoin.fr)."
        )}\n`
      );
    }
  }
}

/* ==============================
   Main
============================== */
(async () => {
  const rl = readline.createInterface({ input, output });

  // 1) What to test
  const modeIdx = await askChoice(
    rl,
    "1/ Choose what to test",
    ["GET a document/API", "POST a request to an API/Form"],
    0
  );
  const modeLabel = modeIdx === 0 ? "GET (document/API)" : "POST (API/Form)";

  // 2) Browser
  const browserIdx = await askChoice(
    rl,
    "2/ Pick a browser engine",
    ["Chromium", "Firefox", "WebKit"],
    0
  );
  const engine = [chromium, firefox, webkit][browserIdx];
  const engineLabel = ["Chromium", "Firefox", "WebKit"][browserIdx];

  // 3) Headless
  const headIdx = await askChoice(rl, "3/ Headless or headful", ["No", "Yes"], 0);
  const headless = headIdx === 1;

  // 4) UA selection
  const uaIdx = await askChoice(
    rl,
    "4/ User-Agent selection",
    ["Default", "Custom", "DD UA Test Codes"],
    0
  );
  let userAgent = null;
  let uaPresetLabel = "Default";
  if (uaIdx === 1) {
    const ans = await rl.question("\nEnter a custom User-Agent: ");
    userAgent = ans.trim() || null;
    uaPresetLabel = userAgent ? "Custom" : "Default";
  } else if (uaIdx === 2) {
    output.write(
      `\nPick a DD UA Test Code:\n\n` +
        `  0) BLOCKUA = CAPTCHA\n` +
        `  1) BLOCKUAHARDBLOCKUA = CAPTCHA > Block\n` +
        `  2) HARDBLOCK = Block\n` +
        `  3) HARDBLOCK_UA = Block [Only on cross-origin XHR]\n` +
        `  4) DeviceCheckTestUA = Device Check\n` +
        `  5) DeviceCheckTestUA-BLOCKUA = Device Check > CAPTCHA\n` +
        `  6) DeviceCheckTestUA-HARDBLOCK = Device Check > Block\n`
    );
    const pick = await rl.question(`Enter number (default: 0): `);
    const n = pick.trim() === "" ? 0 : Number(pick.trim());
    const codes = [
      "BLOCKUA",
      "BLOCKUAHARDBLOCKUA",
      "HARDBLOCK",
      "HARDBLOCK_UA",
      "DeviceCheckTestUA",
      "DeviceCheckTestUA-BLOCKUA",
      "DeviceCheckTestUA-HARDBLOCK",
    ];
    const code = codes[n] || codes[0];
    userAgent = `Mozilla/5.0 (DD-UA-Test ${code}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36`;
    uaPresetLabel = `DD UA Test Codes (${code})`;
  }

  // 5) Network logging scope
  const scopeIdx = await askChoice(
    rl,
    "5/ Network logging scope",
    [
      "Only same-domain requests (XHR/Fetch/Document)",
      "Only cross-origin requests (XHR/Fetch/Document)",
      "Any origin requests (XHR/Fetch/Document)",
    ],
    0
  );
  const scopeLabel =
    scopeIdx === 0 ? "Same-domain only" : scopeIdx === 1 ? "Cross-origin only" : "Any origin";

  // 6) Finish mode
  const finishIdx = await askChoice(
    rl,
    "6/ Finish mode",
    ["Auto (network idle + 5s)", "Manual (press Enter)"],
    0
  );
  const finishLabel = finishIdx === 0 ? "auto on network idle + 5s" : "manual";

  // 7) URL
  const url = await askUrl(rl);
  const targetHost = hostOf(url);
  const baseHost = suffixBase(targetHost);

  // POST payload (when applicable)
  let postPayload = null;
  if (modeIdx === 1) {
    output.write(`\nEnter JSON payload for POST (single or multi-line; blank line to finish):\n`);
    let buf = "";
    while (true) {
      const line = await rl.question("> ");
      if (!line.trim()) break;
      buf += line + "\n";
    }
    postPayload = buf.trim() ? buf : null;
  }

  // Session paths
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const sessionName = `${stamp}_${sanitizePart(targetHost)}`;
  const baseDir = path.resolve(__dirname, "har", sessionName);
  ensureDir(baseDir);
  const harPath = path.join(baseDir, `${sessionName}.har`);
  const cookiePath = path.join(baseDir, `${sessionName}.cookies.json`);

  // Launch
  const browser = await engine.launch({ headless });
  const context = await browser.newContext({
    userAgent: userAgent || undefined,
    recordHar: { path: harPath, mode: "minimal" },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  // Resolve egress IP (best effort)
  let egressIP = "(unknown)";
  try {
    const r = await context.request.get("https://api.ipify.org?format=json", { timeout: 10000 });
    if (r.ok()) {
      const j = await r.json();
      if (j && j.ip) egressIP = j.ip;
    }
  } catch {}

  // Scope matcher
  function matchesScope(u) {
    const h = hostOf(u);
    if (DD_HOSTS.has(h)) return true; // ALWAYS include DataDome endpoints
    if (scopeIdx === 2) return true; // any origin
    if (scopeIdx === 0) return sameDomain(h, baseHost); // same
    return !sameDomain(h, baseHost); // cross
  }

  // Capture store (structured, we will augment from HAR later)
  const captured = []; // {i, url, method, status, type, ddLabel, reqHeaders, reqCookie, ddClientId, ddSetCookiesRuntime:[]}

  // UNIVERSAL response listener at CONTEXT level
  context.on("response", async (response) => {
    try {
      const req = response.request();
      const rt = req.resourceType(); // document|xhr|fetch|...
      if (!LOG_TYPES.has(rt)) return;        // Only our types
      const urlStr = response.url();
      if (isStatic(urlStr)) return;          // exclude static always
      if (!matchesScope(urlStr)) return;

      const h = hostOf(urlStr);
      const ddLabel = classifyDD(urlStr);
      const method = req.method();
      const status = response.status();

      // Request headers for datadome signals
      let reqHeaders = {};
      try { reqHeaders = req.headers(); } catch {}

      const ddClientId = headerValueCase(reqHeaders, "x-datadome-clientid") || null;

      // Request cookie datadome full value
      const cookieHdr = headerValueCase(reqHeaders, "cookie") || headerValueCase(reqHeaders, "Cookie");
      let reqCookieDatadome = null;
      if (cookieHdr && /(^|;\s*)datadome=/i.test(cookieHdr)) {
        const m = cookieHdr.match(/datadome=[^;]+/i);
        reqCookieDatadome = m ? m[0] : "datadome=(present in Cookie header)";
      }

      // RESPONSE Set-Cookie with datadome= (runtime)
      const ddSetCookiesRuntime = getDataDomeSetCookies(response);

      captured.push({
        url: urlStr,
        method,
        status,
        type: rt,
        ddLabel,
        ddClientId,
        reqCookieDatadome,
        ddSetCookiesRuntime,
        ddAlways: h === "geo.captcha-delivery.com",
        geoHost: h === "geo.captcha-delivery.com",
        reqHasBody: false,
        reqBody: null,
      });

      // For geo.captcha-delivery.com POST, store body (up to 4k)
      if (h === "geo.captcha-delivery.com" && !/^get$/i.test(method)) {
        try {
          const body = req.postData();
          if (body) {
            captured[captured.length - 1].reqHasBody = true;
            captured[captured.length - 1].reqBody = body.slice(0, 4000);
          }
        } catch {}
      }
    } catch {
      // swallow
    }
  });

  // Drive the action
  try {
    if (modeIdx === 0) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      await page.goto("about:blank");
      await page.evaluate(
        async ({ u, bodyStr }) => {
          const headers = { "content-type": "application/json" };
          try {
            await fetch(u, {
              method: "POST",
              headers,
              body: bodyStr || "{}",
              credentials: "include",
              mode: "cors",
            });
          } catch {}
        },
        { u: url, bodyStr: postPayload }
      );
    }
  } catch {
    // Continue; logging still prints what we captured
  }

  // Finish policy
  if (finishIdx === 0) {
    try {
      await page.waitForLoadState("networkidle", { timeout: 45000 });
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  } else {
    await rl.question(`\nPress ${C.bold("Enter")} to finish logging…`);
  }

  // Save cookies for reference
  try {
    const ck = await context.cookies();
    fs.writeFileSync(cookiePath, JSON.stringify(ck, null, 2), "utf8");
  } catch {}

  // Close browser to flush HAR to disk before we read it.
  await context.close();
  await browser.close();

  // === AUGMENT FROM HAR (to guarantee DataDome Set-Cookie visibility) ===
  let harEntries = [];
  try {
    const harRaw = fs.readFileSync(harPath, "utf8");
    const har = JSON.parse(harRaw);
    harEntries = (har?.log?.entries || []).map((e, idx) => ({
      idx,
      reqUrl: e?.request?.url || "",
      reqMethod: e?.request?.method || "",
      respStatus: e?.response?.status ?? 0,
      reqHeaders: e?.request?.headers || [],
      respHeaders: e?.response?.headers || [],
      used: false,
    }));
  } catch {
    // no HAR or unreadable
  }

  // helper: find first unused HAR entry that matches url+method+status (exact)
  function findHarFor(item) {
    for (const e of harEntries) {
      if (e.used) continue;
      if (e.reqUrl === item.url && e.reqMethod === item.method && e.respStatus === item.status) {
        e.used = true;
        return e;
      }
    }
    // relaxed fallback: same url+method, ignore status
    for (const e of harEntries) {
      if (e.used) continue;
      if (e.reqUrl === item.url && e.reqMethod === item.method) {
        e.used = true;
        return e;
      }
    }
    return null;
  }

  // augment each captured line with HAR-derived cookie details if runtime missed them
  for (const item of captured) {
    const har = findHarFor(item);
    if (!har) continue;

    // request Cookie header datadome
    if (!item.reqCookieDatadome && Array.isArray(har.reqHeaders)) {
      const cookieH = har.reqHeaders.find((h) => h?.name?.toLowerCase() === "cookie")?.value || "";
      const m = cookieH.match(/datadome=[^;]+/i);
      if (m) item.reqCookieDatadome = m[0];
    }
    // request x-datadome-clientid
    if (!item.ddClientId && Array.isArray(har.reqHeaders)) {
      const ddh = har.reqHeaders.find((h) => h?.name?.toLowerCase() === "x-datadome-clientid");
      if (ddh?.value) item.ddClientId = ddh.value;
    }
    // response Set-Cookie: datadome (full values)
    if ((!item.ddSetCookiesRuntime || item.ddSetCookiesRuntime.length === 0) && Array.isArray(har.respHeaders)) {
      const setc = har.respHeaders
        .filter((h) => h?.name?.toLowerCase() === "set-cookie" && /datadome=/i.test(h?.value || ""))
        .map((h) => h.value);
      if (setc.length) item.ddSetCookiesRuntime = setc; // reuse field name for printing
    }
  }

  // Recap + FULL CAPTURE ONLY (print AFTER augmentation so cookies appear right under the line)
  output.write(
    `\n${C.bold("🧾 Run Recap")}\n${"".padEnd(112, "—")}\n` +
      `  Timestamp:             ${nowISO()}\n` +
      `  URL:                   ${url}\n` +
      `  What to test:          ${modeLabel}\n` +
      `  Browser:               ${engineLabel}\n` +
      `  Headless:              ${headless ? "Yes" : "No"}\n` +
      `  User-Agent:            ${uaPresetLabel}\n` +
      `  Egress IP:             ${egressIP}\n` +
      `  Network logging scope: ${scopeLabel}\n` +
      `  Session:               ${baseDir}\n` +
      `  HAR:                   ${path.join(baseDir, `${sessionName}.har`)}\n` +
      `  Cookies:               ${cookiePath}\n` +
      `  Finish:                ${finishLabel}\n\n` +
      `Launching browser… capturing network. \n\n`
  );

  const scopeTitle =
    scopeIdx === 0 ? "same-domain only" : scopeIdx === 1 ? "cross-origin only" : "any origin";
  output.write(
    `${C.bold(
      `📦 Full network capture (XHR/Fetch/Document • ${scopeTitle} • static assets excluded)`
    )}\n${"".padEnd(112, "—")}\n`
  );

  if (!captured.length) {
    output.write(`  ${C.dim("No capture entries.")}\n`);
  } else {
    let printedIdx = 0;
    for (const it of captured) {
      printedIdx += 1;
      const typeStr = prettyType(it.type, it.ddLabel);
      output.write(
        `  ${pad2(printedIdx)}. ${typeStr} (${it.method}) → ${it.url} [${prettyStatus(it.status)}]\n`
      );

      // Request header: x-datadome-clientid
      if (it.ddClientId) {
        output.write(`      ↳ Request header ${C.cyan("x-datadome-clientid")}: ${it.ddClientId}\n`);
      }

      // Request Cookie: datadome=...
      if (it.reqCookieDatadome) {
        output.write(`      ↳ Request cookie ${C.cyan(it.reqCookieDatadome)}\n`);
      }

      // Response Set-Cookie (DataDome) — FULL VALUE(S)
      if (Array.isArray(it.ddSetCookiesRuntime) && it.ddSetCookiesRuntime.length) {
        output.write(`      🍪 DataDome Set-Cookie:\n`);
        for (const sc of it.ddSetCookiesRuntime) {
          output.write(`        ${sc}\n`);
        }
      }

      // geo.captcha-delivery.com: show params/body
      const host = hostOf(it.url);
      if (host === "geo.captcha-delivery.com") {
        if (/^get$/i.test(it.method)) {
          const qp = parseQuery(it.url);
          if (qp && Object.keys(qp).length) {
            output.write(`      ↳ Query params:\n`);
            const indented = j2(qp).replace(/\n/g, "\n        ");
            output.write(`        ${indented}\n`);
          }
        } else if (it.reqHasBody && it.reqBody) {
          output.write(`      ↳ Body:\n`);
          output.write(`        ${it.reqBody.replace(/\n/g, "\n        ")}\n`);
        }
      }
    }
  }

  output.write(
    `\n${C.bold("📦 Saved:")}\n${"".padEnd(112, "—")}\n` +
      `  HAR:                   ${path.join(baseDir, `${sessionName}.har`)}\n` +
      `  Cookies:               ${cookiePath}\n`
  );

  output.write(`\n${C.green("✅ Done")}\n`);
})().catch((err) => {
  console.error(`${C.red("Unexpected error:")} ${err?.message || err}`);
  process.exit(1);
});