/**
 * dd-playwright-open-any-website-debug — ONE-FILE APP
 * Fully updated per your latest requirements.
 *
 * - CommonJS (no "type": "module" needed)
 * - console.clear() on launch
 * - Polished, colorized prompts with spacing and numbering
 * - URL prompt loops until valid (with example hint)
 * - Egress IP shown in Run Recap (right after User-Agent)
 * - "What to test" (GET document/API or POST with payload)
 * - Network logging scope: Same-domain / Cross-origin / Any origin
 * - Logs ONLY Document/XHR/Fetch (no static assets), **except** always include geo.captcha-delivery.com (GET/POST) with query params & payloads
 * - For EVERY logged request:
 *     • Show request method + URL + status icon
 *     • If request headers include cookie "datadome", print FULL value
 *     • If request headers include "x-datadome-clientid", print it
 *     • If response headers include Set-Cookie "datadome", print FULL value(s)
 * - Robust against "Target ... has been closed" by snapshotting headers safely
 * - Datadome flow classification:
 *     • https://geo.captcha-delivery.com/captcha*  => "CAPTCHA/BLOCK"
 *     • https://geo.captcha-delivery.com/interstitial* => "Device Check"
 * - Works with Chromium, Firefox, WebKit
 * - HAR + cookies saved under ./har/<timestamp_host>/
 *
 * Run: npm start (ensure playwright browsers installed)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium, firefox, webkit } = require('playwright');
const https = require('https');

// ------------------------ Colors (chalk-like, no dependency) ------------------------
const supportsColor = process.stdout.isTTY;
const kleur = (() => {
  const wrap = (code) => (s) => supportsColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    magenta: wrap('35'),
    cyan: wrap('36'),
    gray: wrap('90'),
    bgGray: (s) => supportsColor ? `\x1b[100m${s}\x1b[0m` : String(s),
  };
})();

// ------------------------ Console clear on launch ------------------------
try { console.clear(); } catch { /* noop */ }

// ------------------------ Static assets filter (exclude) ------------------------
const STATIC_EXT_RE = /\.(avi|flv|mka|mkv|mov|mp4|mpeg|mpg|mp3|flac|ogg|ogm|opus|wav|webm|webp|bmp|gif|ico|jpeg|jpg|png|svg|svgz|swf|eot|otf|ttf|woff|woff2|css|less|js|map)$/i;

// ------------------------ Helpers: URL, time, paths ------------------------
function nowIsoCompact() {
  // 2025-09-15T131028Z
  const d = new Date();
  const pad = (n, l=2) => String(n).padStart(l,'0');
  const Z = 'Z';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${Z}`;
}
function hostFromUrl(u) {
  try { return new URL(u).host; } catch { return ''; }
}
function toAbsoluteUrlMaybe(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // try add https://
  return `https://${trimmed}`;
}
function isValidUrl(u) {
  try { new URL(u); return true; } catch { return false; }
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// ------------------------ Prompt UI ------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

async function promptSelect(title, options, defIndex=0) {
  console.log('');
  console.log(kleur.cyan(kleur.bold(title)));
  console.log('');
  options.forEach((opt, i) => {
    const def = (i === defIndex) ? ' (default)' : '';
    console.log(`  ${i}) ${opt}${def}`);
  });
  const ans = await ask(kleur.gray(`Enter number (default: ${defIndex}): `));
  if (ans === '') return defIndex;
  const num = Number(ans);
  if (Number.isInteger(num) && num >= 0 && num < options.length) return num;
  return defIndex;
}

async function promptUrlLoop() {
  console.log('');
  console.log(kleur.cyan(kleur.bold('Enter URL')));
  console.log('');
  while (true) {
    const input = await ask('Which website or API endpoint do you want to open? ');
    const maybe = toAbsoluteUrlMaybe(input);
    if (maybe && isValidUrl(maybe)) return maybe;
    console.log(kleur.red('❌ Invalid URL. Please try again (example: leboncoin.fr or https://leboncoin.fr).'));
  }
}

async function promptText(title, placeholder='') {
  console.log('');
  console.log(kleur.cyan(kleur.bold(title)));
  console.log('');
  const ans = await ask(placeholder ? `${placeholder}: ` : '> ');
  return ans;
}

// ------------------------ Egress IP ------------------------
function getEgressIP(timeoutMs=4000) {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', (res) => {
      let data=''; res.on('data', (c)=>data+=c);
      res.on('end', ()=> {
        try {
          const j = JSON.parse(data);
          resolve(j.ip || '(unknown)');
        } catch { resolve('(unknown)'); }
      });
    });
    req.on('error', ()=> resolve('(unknown)'));
    req.setTimeout(timeoutMs, ()=> { try{ req.destroy(); }catch{} resolve('(unknown)'); });
  });
}

// ------------------------ UA options ------------------------
const DD_UA_CODES = {
  // Key => label shown in prompt
  'BLOCKUA': 'CAPTCHA',
  'BLOCKUAHARDBLOCKUA': 'CAPTCHA > Block',
  'HARDBLOCK': 'Block',
  'HARDBLOCK_UA': 'Block [Only on cross-origin XHR]',
  'DeviceCheckTestUA': 'Device Check',
  'DeviceCheckTestUA-BLOCKUA': 'Device Check > CAPTCHA',
  'DeviceCheckTestUA-HARDBLOCK': 'Device Check > Block',
};
const DD_UA_HEADERS = {
  // These are UA strings you want to assign; keep placeholders if desired
  'BLOCKUA': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) BLOCKUA Chrome/123.0.0.0 Safari/537.36',
  'BLOCKUAHARDBLOCKUA': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BLOCKUAHARDBLOCKUA Chrome/123.0.0.0 Safari/537.36',
  'HARDBLOCK': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HARDBLOCK Chrome/123.0.0.0 Safari/537.36',
  'HARDBLOCK_UA': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) HARDBLOCK_UA Chrome/123.0.0.0 Safari/537.36',
  'DeviceCheckTestUA': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeviceCheckTestUA Chrome/123.0.0.0 Safari/537.36',
  'DeviceCheckTestUA-BLOCKUA': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeviceCheckTestUA-BLOCKUA Chrome/123.0.0.0 Safari/537.36',
  'DeviceCheckTestUA-HARDBLOCK': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeviceCheckTestUA-HARDBLOCK Chrome/123.0.0.0 Safari/537.36',
};

// ------------------------ Safe header helpers (snapshot/defensive) ------------------------
function isClosedTarget(context, page) {
  return !context || (typeof context.isClosed === 'function' && context.isClosed()) ||
         !page || (typeof page.isClosed === 'function' && page.isClosed());
}
function safeHeadersArrayFromResponse(resp) {
  try {
    const arr = resp?.headersArray?.() || [];
    return Array.isArray(arr) ? arr.map(h => ({ name: h.name, value: h.value })) : [];
  } catch { return []; }
}
function safeRequestHeaders(req) {
  try { return req?.headers?.() || {}; } catch { return {}; }
}
function getDataDomeSetCookiesFromHeadersArray(headersArray) {
  const out = [];
  for (const h of headersArray) {
    if (!h || !h.name) continue;
    if (String(h.name).toLowerCase() === 'set-cookie') {
      const v = h.value || '';
      if (v.toLowerCase().startsWith('datadome=')) out.push(v);
    }
  }
  return out;
}
function getDataDomeCookieFromReq(req) {
  try {
    const headers = safeRequestHeaders(req);
    const cookieHeader = headers['cookie'] || headers['Cookie'];
    if (!cookieHeader || typeof cookieHeader !== 'string') return null;
    const m = cookieHeader.match(/(?:^|;\s*)datadome=([^;]+)/i);
    return m ? `datadome=${m[1]}` : null;
  } catch { return null; }
}
function getDataDomeClientIdFromReq(req) {
  try {
    const headers = safeRequestHeaders(req);
    return headers['x-datadome-clientid'] || headers['X-DataDome-ClientId'] || null;
  } catch { return null; }
}

// ------------------------ Classification & filters ------------------------
function isDocXhrFetch(rt) {
  return rt === 'document' || rt === 'xhr' || rt === 'fetch';
}
function isStaticAsset(urlStr) {
  try {
    const u = new URL(urlStr);
    return STATIC_EXT_RE.test(u.pathname);
  } catch { return STATIC_EXT_RE.test(urlStr); }
}
function isGeoCaptchaDelivery(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname === 'geo.captcha-delivery.com';
  } catch { return false; }
}
function geoLabel(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.pathname.startsWith('/captcha')) return 'CAPTCHA/BLOCK';
    if (u.pathname.startsWith('/interstitial')) return 'Device Check';
  } catch {}
  return 'Challenge';
}
function sameDomain(urlStr, baseHost) {
  try { return new URL(urlStr).host === baseHost; } catch { return false; }
}
function crossOrigin(urlStr, baseHost) {
  try { return new URL(urlStr).host !== baseHost; } catch { return false; }
}
function parseQueryParams(urlStr) {
  try {
    const u = new URL(urlStr);
    const out = {};
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
    return out;
  } catch { return null; }
}

// Pretty status icon
function statusIcon(status) {
  if (status >= 200 && status < 300) return kleur.green('✅');
  if (status >= 300 && status < 400) return kleur.blue('ℹ️');
  if (status >= 400 && status < 500) return kleur.yellow('🚫');
  if (status >= 500) return kleur.red('💥');
  return kleur.gray('•');
}
function rtLabel(rt) {
  if (rt === 'document') return 'DOCUMENT';
  if (rt === 'xhr') return 'XHR';
  if (rt === 'fetch') return 'FETCH';
  return rt.toUpperCase();
}

// ------------------------ Main ------------------------
(async () => {
  // 1/ Choose what to test
  const modeIdx = await promptSelect('1/ Choose what to test', [
    'GET a document/API',
    'POST a request to an API/Form (provide payload)',
  ], 0);

  // 2/ Pick a browser engine
  const browserIdx = await promptSelect('2/ Pick a browser engine', [
    'Chromium',
    'Firefox',
    'WebKit',
  ], 0);

  // 3/ Headless or headful
  const headlessIdx = await promptSelect('3/ Headless or headful', [
    'No',
    'Yes',
  ], 0);

  // 4/ User-Agent selection
  const uaModeIdx = await promptSelect('4/ User-Agent selection', [
    'Default',
    'Custom',
    'DD UA Test Codes',
  ], 0);

  let customUA = null;
  let ddUAKey = null;
  if (uaModeIdx === 1) {
    customUA = await promptText('Enter your custom User-Agent', 'User-Agent');
    if (!customUA) customUA = null;
  } else if (uaModeIdx === 2) {
    const ddKeys = Object.keys(DD_UA_CODES);
    const ddOptions = ddKeys.map(k => `${k} (${DD_UA_CODES[k]})`);
    const keyIdx = await promptSelect('Select a DD UA Test Code', ddOptions, 0);
    ddUAKey = ddKeys[keyIdx];
  }

  // 5/ Network logging scope
  const scopeIdx = await promptSelect('5/ Network logging scope', [
    'Only same-domain requests (XHR/Fetch/Document, no static assets)',
    'Only cross-origin requests (XHR/Fetch/Document, no static assets)',
    'Any origin requests (XHR/Fetch/Document, no static assets)',
  ], 0);

  // 6/ Finish mode
  const finishIdx = await promptSelect('6/ Finish mode', [
    'Auto (network idle + 5s)',
    'Manual (press Enter)',
  ], 0);

  // 7/ Enter URL (loop until valid)
  const url = await promptUrlLoop();
  const baseHost = hostFromUrl(url);

  // If POST mode, ask payload (JSON or raw)
  let postPayload = null;
  let postContentType = null;
  if (modeIdx === 1) {
    console.log('');
    console.log(kleur.cyan(kleur.bold('POST payload')));
    console.log('');
    console.log(kleur.dim('Tip: paste JSON or any body string; press Enter twice to finish.'));
    const lines = [];
    rl.setPrompt('');
    for await (const line of rl) {
      if (line === '') break;
      lines.push(line);
      // prompt continues until blank line
      console.log(kleur.gray('(…continue or press Enter on blank line to finish)'));
    }
    const body = lines.join('\n').trim();
    if (body) {
      postPayload = body;
      // Guess content-type
      try { JSON.parse(body); postContentType = 'application/json'; }
      catch { postContentType = 'text/plain;charset=utf-8'; }
    }
  }

  // Egress IP
  const egressIP = await getEgressIP();

  // Prepare session dir
  const ts = nowIsoCompact();
  const sessionSlug = `${ts}_${baseHost || 'session'}`;
  const outRoot = path.resolve(process.cwd(), 'har', sessionSlug);
  ensureDir(outRoot);

  // UA string picked
  let uaFinalLabel = 'Default';
  let userAgentOverride = null;
  if (customUA) {
    uaFinalLabel = 'Custom';
    userAgentOverride = customUA;
  } else if (ddUAKey) {
    uaFinalLabel = `DD UA Test Codes (${ddUAKey})`;
    userAgentOverride = DD_UA_HEADERS[ddUAKey] || null;
  }

  // Show Run Recap (harmonized labels, include Egress IP after UA)
  console.log('');
  console.log(kleur.magenta(kleur.bold('🧾 Run Recap')));
  console.log(kleur.gray('—'.repeat(112)));
  console.log(`  ${kleur.bold('Timestamp:')}             ${new Date().toISOString()}`);
  console.log(`  ${kleur.bold('URL:')}                   ${url}`);
  console.log(`  ${kleur.bold('What to test:')}          ${modeIdx === 0 ? 'GET (document/API)' : 'POST (API/Form)'}`);
  console.log(`  ${kleur.bold('Browser:')}               ${['Chromium','Firefox','WebKit'][browserIdx]}`);
  console.log(`  ${kleur.bold('Headless:')}              ${headlessIdx === 1 ? 'Yes' : 'No'}`);
  console.log(`  ${kleur.bold('User-Agent:')}            ${uaFinalLabel}`);
  console.log(`  ${kleur.bold('Egress IP:')}             ${egressIP}`);
  console.log(`  ${kleur.bold('Network logging scope:')} ${['Same-domain only','Cross-origin only','Any origin'][scopeIdx]}`);
  console.log(`  ${kleur.bold('Session:')}               ${outRoot}`);
  console.log(`  ${kleur.bold('HAR:')}                   ${path.join(outRoot, `${sessionSlug}.har`)}`);
  console.log(`  ${kleur.bold('Cookies:')}               ${path.join(outRoot, `${sessionSlug}.cookies.json`)}`);
  console.log(`  ${kleur.bold('Finish:')}                ${finishIdx === 0 ? 'auto on network idle + 5s' : 'manual (press Enter)'}`);
  console.log('');

  console.log(kleur.bold('Launching browser… capturing network. '));

  // Launch browser
  const browser = await (browserIdx === 0 ? chromium : browserIdx === 1 ? firefox : webkit).launch({
    headless: headlessIdx === 1
  });
  const context = await browser.newContext({
    userAgent: userAgentOverride || undefined,
    ignoreHTTPSErrors: true,
    recordHar: { path: path.join(outRoot, `${sessionSlug}.har`), content: 'embed' },
  });
  const page = await context.newPage();

  // ------------------------ Capture arrays (snapshots only) ------------------------
  const captured = []; // { idx, rt, method, url, status, headersArraySnap, reqHeadersSnap, geoType?, query?, reqBodyPreview? }
  let counter = 0;

  // Request body collection for XHR/Fetch/geo.*
  const requestBodies = new Map(); // request -> small preview
  context.on('request', async (req) => {
    try {
      const urlStr = req.url();
      const rt = req.resourceType?.();
      if (isDocXhrFetch(rt) || isGeoCaptchaDelivery(urlStr)) {
        // snapshot a small body for POST/PUT/PATCH
        const method = req.method?.() || 'GET';
        if (['POST','PUT','PATCH','DELETE','OPTIONS'].includes(method)) {
          let postData = null;
          try { postData = req.postData?.() ?? null; } catch { postData = null; }
          if (postData) {
            // keep small preview only
            requestBodies.set(req, (postData.length > 10000) ? (postData.slice(0, 10000) + '…') : postData);
          }
        }
      }
    } catch { /* ignore */ }
  });

  // Response handler with safe snapshotting
  context.on('response', async (response) => {
    try {
      if (isClosedTarget(context, page)) return; // target gone

      const req = response.request?.();
      const urlStr = response.url?.() || '';
      const rt = req?.resourceType?.() || '';
      const method = req?.method?.() || 'GET';
      const status = response.status?.() ?? 0;

      // Include only doc/xhr/fetch — and always include geo.captcha-delivery.com
      const includeThis =
        (isDocXhrFetch(rt) && !isStaticAsset(urlStr)) || isGeoCaptchaDelivery(urlStr);

      if (!includeThis) return;

      const idx = ++counter;

      // Snapshot response headers safely
      const headersArraySnap = safeHeadersArrayFromResponse(response);

      // Snapshot request headers safely
      const reqHeadersSnap = safeRequestHeaders(req);

      // Geo classification + query params for geo.*
      let geoType = null, query = null;
      if (isGeoCaptchaDelivery(urlStr)) {
        geoType = geoLabel(urlStr);
        query = parseQueryParams(urlStr);
      }

      // Request cookies/header for DataDome
      const ddReqCookie = getDataDomeCookieFromReq(req);
      const ddClientId  = getDataDomeClientIdFromReq(req);

      // Response Set-Cookie DataDome (full)
      const ddSetCookies = getDataDomeSetCookiesFromHeadersArray(headersArraySnap);

      // Request body preview (only captured if present)
      const reqBodyPreview = requestBodies.get(req) || null;

      // Push snapshot
      captured.push({
        idx, rt, method, url: urlStr, status,
        headersArraySnap, reqHeadersSnap,
        geoType, query,
        ddReqCookie, ddClientId, ddSetCookies,
        reqBodyPreview
      });
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (!/Target .* has been closed/i.test(msg)) {
        // non-fatal log
        // console.log(kleur.gray(`(response handler) ${msg}`));
      }
    }
  });

  // Navigate / perform GET or POST
  try {
    if (modeIdx === 0) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } else {
      // POST flow: we still open the URL with POST (fetch from page context)
      await page.goto('about:blank');
      await page.evaluate(async ({ targetUrl, body, contentType }) => {
        const opts = {
          method: 'POST',
          headers: contentType ? { 'Content-Type': contentType } : undefined,
          body: body ?? undefined
        };
        try {
          await fetch(targetUrl, opts);
        } catch (e) {
          // swallow
        }
      }, { targetUrl: url, body: postPayload, contentType: postContentType });
    }
  } catch (e) {
    // navigation errors are ok
  }

  // Finish mode
  if (finishIdx === 0) {
    // Auto: wait for network idle then 5s
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    await new Promise(r => setTimeout(r, 5000));
  } else {
    await ask(kleur.gray('Press Enter to finish logging…'));
  }

  // Save cookies
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(path.join(outRoot, `${sessionSlug}.cookies.json`), JSON.stringify(cookies, null, 2));
  } catch {}

  // Close targets BEFORE printing (we snapshot already)
  try { await page.close({ runBeforeUnload: false }); } catch {}
  try { await context.close(); } catch {}
  try { await browser.close(); } catch {}

  // ------------------------ PRINT LOGS (single section, no static assets, scoped) ------------------------
  const scopeName = ['same-domain only', 'cross-origin only', 'any origin'][scopeIdx];
  console.log('');
  console.log(kleur.magenta(kleur.bold(`📦 Full network capture (XHR/Fetch/Document • ${scopeName} • static assets excluded)`)));
  console.log(kleur.gray('—'.repeat(112)));

  // Scope filtering & sorting by idx
  const filtered = captured
    .filter(item => {
      if (isGeoCaptchaDelivery(item.url)) return true; // always include geo.captcha-delivery.com
      if (scopeIdx === 0) return sameDomain(item.url, baseHost);
      if (scopeIdx === 1) return crossOrigin(item.url, baseHost);
      return true; // any
    })
    .sort((a,b) => a.idx - b.idx);

  for (const item of filtered) {
    const icon = statusIcon(item.status);
    const rtTxt = rtLabel(item.rt);
    const geoPrefix = item.geoType ? ` [${item.geoType}]` : '';
    console.log(`  ${item.idx}. ${rtTxt}${geoPrefix} (${item.method}) → ${item.url} [${icon} ${item.status || '•'}]`);

    // For geo.* print query params
    if (item.geoType && item.query && Object.keys(item.query).length) {
      console.log(kleur.dim('      ↳ Query params:'));
      const prettyQ = JSON.stringify(item.query, null, 2).split('\n').map(l => '        ' + l).join('\n');
      console.log(kleur.dim(prettyQ));
    }

    // DataDome request header pieces
    if (item.ddClientId) {
      console.log(`      ${kleur.yellow('↳ Request header x-datadome-clientid:')} ${item.ddClientId}`);
    }
    if (item.ddReqCookie) {
      console.log(`      ${kleur.yellow('🍪 Request Cookie:')} ${item.ddReqCookie}`);
    }

    // DataDome Set-Cookie response (full)
    if (item.ddSetCookies && item.ddSetCookies.length) {
      console.log(`      ${kleur.green('🍪 Response Set-Cookie (DataDome):')}`);
      for (const sc of item.ddSetCookies) console.log(`        - ${sc}`);
    }

    // For APIs (non-HTML likely) or geo.* POSTs, show short request body preview (if any)
    if (item.reqBodyPreview) {
      console.log(kleur.dim('      ↳ Request body preview:'));
      const bodyStr = (''+item.reqBodyPreview);
      const bodyOut = bodyStr.length > 2000 ? (bodyStr.slice(0,2000) + '…') : bodyStr;
      const prettyBody = bodyOut.split('\n').map(l => '        ' + l).join('\n');
      console.log(kleur.dim(prettyBody));
    }
  }

  // Saved paths
  console.log('');
  console.log(kleur.magenta(kleur.bold('📦 Saved:')));
  console.log(kleur.gray('—'.repeat(112)));
  console.log(`  ${kleur.bold('HAR:')}                   ${path.join(outRoot, `${sessionSlug}.har`)}`);
  console.log(`  ${kleur.bold('Cookies:')}               ${path.join(outRoot, `${sessionSlug}.cookies.json`)}`);
  console.log('');
  console.log(kleur.green('✅ Done'));
  rl.close();
})().catch((err) => {
  const msg = String(err?.message || err || '');
  if (/Target .* has been closed/i.test(msg)) {
    console.log(kleur.yellow('(!) Target was closed during logging, but snapshots were saved where possible.'));
  } else {
    console.error(kleur.red('Unexpected error:'), msg);
  }
  try { rl.close(); } catch {}
  process.exitCode = 1;
});