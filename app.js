#!/usr/bin/env node
/* eslint-disable no-console */

// ===== Imports =====
const { chromium, firefox, webkit } = require('playwright');
const pc = require('picocolors');                  // color
const setCookie = require('set-cookie-parser');    // robust Set-Cookie parsing
const { parse: tldParse } = require('tldts');      // URL host validation
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');

// ===== Constants =====
const WATCHDOG_IDLE_MS = 5000;           // network idle window (ms)
const HARD_WATCHDOG_MS = 180000;         // hard stop after 3 min
const HAR_DIR = path.join(process.cwd(), 'har');

// ===== Helpers =====
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, (a) => res(a.trim())));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const iconForStatus = (s) => {
  if (s == null) return pc.cyan('ℹ️');
  if (s >= 200 && s < 300) return pc.green('✅');
  if (s >= 300 && s < 400) return pc.cyan('ℹ️');
  if (s === 403) return pc.red('🚫');
  if (s >= 400) return pc.yellow('⚠️');
  return pc.cyan('ℹ️');
};

const niceType = (t) => {
  const up = String(t || '').toUpperCase();
  if (up === 'DOCUMENT') return pc.bold(pc.white('DOCUMENT'));
  if (up === 'XHR')      return pc.bold(pc.white('XHR'));
  if (up === 'FETCH')    return pc.bold(pc.white('FETCH'));
  return up;
};

const isDocXhrFetch = (rt) => ['document', 'xhr', 'fetch'].includes(String(rt || '').toLowerCase());
const colorUrl = (u) => pc.white(u);
const ensureDir = (p) => { fs.mkdirSync(p, { recursive: true }); };

const extractDDCookies = (anySetCookieValues) => {
  if (!anySetCookieValues) return [];
  const pieces = [];
  const pushSplit = (val) => {
    if (!val) return;
    const split = setCookie.splitCookiesString(val); // handles commas in Expires
    for (const s of split) pieces.push(s);
  };
  if (Array.isArray(anySetCookieValues)) for (const v of anySetCookieValues) pushSplit(v);
  else if (typeof anySetCookieValues === 'string') pushSplit(anySetCookieValues);

  const parsed = setCookie.parse(pieces, { map: false });
  return parsed
    .filter(c => (c.name || '').toLowerCase() === 'datadome')
    .map(h => ({
      name: h.name,
      value: h.value,
      domain: h.domain,
      path: h.path,
      sameSite: h.sameSite,
      secure: !!h.secure,
      httpOnly: !!h.httpOnly,
      maxAge: h.maxAge,
      expires: h.expires
    }));
};

const showDDSetCookies = (dd) => {
  if (!dd || dd.length === 0) return;
  console.log(`   ${pc.yellow('🍪 DataDome Set-Cookie:')}`);
  for (const c of dd) {
    console.log(`     - ${pc.white(`${c.name}=${c.value}`)}`);
    const attrs = [];
    if (c.maxAge != null) attrs.push(`Max-Age=${c.maxAge}`);
    if (c.domain) attrs.push(`Domain=${c.domain}`);
    if (c.path) attrs.push(`Path=${c.path}`);
    if (c.secure) attrs.push('Secure');
    if (c.httpOnly) attrs.push('HttpOnly');
    if (c.sameSite) attrs.push(`SameSite=${c.sameSite}`);
    if (c.expires) attrs.push(`Expires=${new Date(c.expires).toUTCString()}`);
    if (attrs.length) console.log(`     ${pc.dim('•')} ${attrs.join(' ')}\n`);
  }
};

const parseQueryParams = (urlObj) => {
  const out = {};
  for (const [k, v] of urlObj.searchParams.entries()) {
    if (out[k] == null) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  }
  return out;
};

const safeJSON = (v) => {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

const decodeIfForm = (contentType, body) => {
  if (!body) return { bodyKind: 'unknown', bodyOut: body };
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json')) {
    try { return { bodyKind: 'json', bodyOut: JSON.stringify(JSON.parse(body), null, 2) }; }
    catch { return { bodyKind: 'json', bodyOut: body }; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = {};
    for (const part of String(body).split('&')) {
      const [k, v=''] = part.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    return { bodyKind: 'form', bodyOut: JSON.stringify(params, null, 2) };
  }
  return { bodyKind: 'unknown', bodyOut: body };
};

const getExternalIP = () => new Promise((resolve) => {
  const req = https.get('https://api.ipify.org?format=json', (res) => {
    let data = '';
    res.on('data', (c) => data += c);
    res.on('end', () => {
      try {
        const obj = JSON.parse(data);
        resolve(obj.ip || 'unknown');
      } catch {
        resolve('unknown');
      }
    });
  });
  req.on('error', () => resolve('unknown'));
  req.setTimeout(3000, () => { req.destroy(); resolve('unknown'); });
});

const normalizeURL = (raw) => {
  try {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const u = new URL(s);
    const tp = tldParse(u.hostname || '');
    if (!tp || !tp.domain) return null;
    return u.toString();
  } catch {
    return null;
  }
};

// ===== Main =====
async function main() {
  ensureDir(HAR_DIR);

  console.log(pc.bold(pc.cyan('🔎 Playwright Launcher\n')));

  // Browser choice
  console.log(`Browser:
  ${pc.bold('0)')} Chromium
  ${pc.bold('1)')} Firefox
  ${pc.bold('2)')} WebKit`);
  let bNum = await ask(pc.dim('Enter number (default: 0): '));
  if (!/^[0-2]$/.test(bNum)) bNum = '0';
  const browserKind = ['chromium','firefox','webkit'][Number(bNum)];

  // Headless
  console.log(`\nHeadless:
  ${pc.bold('0)')} No
  ${pc.bold('1)')} Yes`);
  let hNum = await ask(pc.dim('Enter number (default: 0): '));
  if (!/^[0-1]$/.test(hNum)) hNum = '0';
  const headless = hNum === '1';

  // UA
  console.log(`\nUser-Agent:
  ${pc.bold('0)')} (default)
  ${pc.bold('1)')} Custom`);
  let uaNum = await ask(pc.dim('Enter number (default: 0): '));
  if (!/^[0-1]$/.test(uaNum)) uaNum = '0';
  let customUA = '';
  if (uaNum === '1') {
    customUA = await ask(pc.dim('Enter custom User-Agent string: '));
  }

  // Finish mode
  console.log(`\nFinish mode:
  ${pc.bold('0)')} Auto (network idle + 5s)
  ${pc.bold('1)')} Manual (press Enter)`);
  let fNum = await ask(pc.dim('Enter number (default: 0): '));
  if (!/^[0-1]$/.test(fNum)) fNum = '0';
  const manualFinish = fNum === '1';

  // URL ask (loop until valid)
  let startURL = null;
  while (!startURL) {
    const raw = await ask(pc.bold('\nWhich website do you want to open? '));
    const normalized = normalizeURL(raw);
    if (!normalized) {
      console.log(pc.red('❌ Invalid URL. Please try again (example: leboncoin.fr or https://leboncoin.fr).'));
    } else {
      startURL = normalized;
    }
  }

  // Gather external IP
  const egressIP = await getExternalIP();

  // Session folder (within /har)
  const hostForName = new URL(startURL).hostname.replace(/^www\./,'');
  const stamp = new Date().toISOString().replace(/[-:]/g,'').slice(0,15);
  const sessionDir = path.join(HAR_DIR, `${stamp}_${hostForName}`);
  ensureDir(sessionDir);
  const harPath = path.join(sessionDir, `${stamp}_${hostForName}.har`);
  const cookiesPath = path.join(sessionDir, `${stamp}_${hostForName}.cookies.json`);

  // Launch
  const b = { chromium, firefox, webkit }[browserKind];
  const launch = await b.launch({ headless });
  const context = await launch.newContext({
    userAgent: customUA || undefined,
    recordHar: { path: harPath, mode: 'minimal' },
  });
  const page = await context.newPage();

  // CDP extras (Chromium only): capture raw Set-Cookie from ExtraInfo
  const isChromium = browserKind === 'chromium';
  /** requestId -> { url, method, status, setCookieStrings[] } */
  const cdpById = new Map();
  if (isChromium) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable', { extraInfoSpec: ['IncludeExtraInfo'] });

    cdp.on('Network.requestWillBeSent', (evt) => {
      const { requestId, request } = evt || {};
      if (!requestId || !request) return;
      const rec = cdpById.get(requestId) || { setCookieStrings: [] };
      rec.url = request.url;
      rec.method = request.method || 'GET';
      cdpById.set(requestId, rec);
    });

    cdp.on('Network.responseReceived', (evt) => {
      const { requestId, response } = evt || {};
      if (!requestId || !response) return;
      const rec = cdpById.get(requestId) || { setCookieStrings: [] };
      rec.status = response.status;
      if (!rec.url) rec.url = response.url;
      cdpById.set(requestId, rec);
    });

    cdp.on('Network.responseReceivedExtraInfo', (evt) => {
      const { requestId, headers } = evt || {};
      if (!requestId) return;
      const rec = cdpById.get(requestId) || { setCookieStrings: [] };
      // headers["set-cookie"] may be string or array; normalize
      const h = headers || {};
      const sc = h['set-cookie'] ?? h['Set-Cookie'];
      if (Array.isArray(sc)) rec.setCookieStrings.push(...sc);
      else if (typeof sc === 'string') rec.setCookieStrings.push(sc);
      cdpById.set(requestId, rec);
    });
  }

  // Recap
  console.log('\n' + pc.bold(pc.magenta('🧾 Run Recap')));
  console.log(`  Timestamp : ${pc.white(new Date().toISOString())}`);
  console.log(`  URL       : ${pc.white(startURL)}`);
  console.log(`  Browser   : ${pc.white(browserKind[0].toUpperCase() + browserKind.slice(1))}`);
  console.log(`  Headless  : ${pc.white(headless ? 'Yes' : 'No')}`);
  console.log(`  Egress IP : ${pc.white(egressIP)}`);
  console.log(`  User-Agent: ${pc.white(customUA || '(default)')}`);
  console.log(`  Session   : ${pc.white(sessionDir)}`);
  console.log(`  HAR       : ${pc.white(harPath)}`);
  console.log(`  Cookies   : ${pc.white(cookiesPath)}`);
  console.log(`  Finish    : ${pc.white(manualFinish ? 'manual (press Enter)' : 'auto on network idle + 5s')}\n`);

  // Filters
  const targetHost = new URL(startURL).hostname.toLowerCase();
  const challengeHost = 'geo.captcha-delivery.com';

  // Capture arrays
  const events = []; // our printed list (doc/xhr/fetch on target/challenge)
  let reqIdx = 0;

  // Also collect “document” request order for better initial redirect rendering
  const docEvents = [];

  // Request listener
  page.on('request', (req) => {
    const rt = req.resourceType();
    if (!isDocXhrFetch(rt)) return;

    const url = req.url();
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    if (host !== targetHost && host !== challengeHost && !host.endsWith('.' + targetHost)) return;

    const idx = ++reqIdx;
    const method = req.method();
    const type = rt;
    const reqHeaders = req.headers() || {};

    const cookieHeader = reqHeaders['cookie'] || reqHeaders['Cookie'];
    let ddReqCookie = '';
    if (cookieHeader) {
      try {
        const cookies = cookieHeader.split(/;\s*/).map(x => x.trim());
        for (const c of cookies) {
          const [k, ...rest] = c.split('=');
          if (k.toLowerCase() === 'datadome') {
            ddReqCookie = rest.join('=');
            break;
          }
        }
      } catch {}
    }
    const ddReqHeader = reqHeaders['x-datadome-clientid'] || reqHeaders['X-DataDome-ClientId'];

    let reqBody = undefined;
    try {
      const post = req.postData();
      if (post) reqBody = post;
    } catch {}

    const ev = {
      idx, ts: Date.now(), url, method, type, status: null,
      reqHeaders, resHeaders: {}, reqBody, ddReqCookie, ddReqHeader, ddSetCookies: []
    };
    events.push(ev);
    if (type === 'document') docEvents.push(ev);
  });

  // Response listener
  page.on('response', async (res) => {
    try {
      const req = res.request();
      const rt = req.resourceType();
      if (!isDocXhrFetch(rt)) return;

      const url = req.url();
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host !== targetHost && host !== challengeHost && !host.endsWith('.' + targetHost)) return;

      const status = res.status();

      // Map back to our event (same url & method, last with null status)
      const ev = [...events].reverse().find(e => e.url === url && e.status == null && e.method === req.method());
      if (ev) {
        ev.status = status;

        // Try standard header APIs first
        let resHeaders = {};
        let ddSetCookies = [];
        try {
          if (typeof res.headersArray === 'function') {
            const arr = res.headersArray(); // [{name,value}]
            const scStrings = [];
            for (const { name, value } of arr) {
              const key = name.toLowerCase();
              if (key === 'set-cookie') scStrings.push(value);
              if (resHeaders[key] == null) resHeaders[key] = value;
              else if (Array.isArray(resHeaders[key])) resHeaders[key].push(value);
              else resHeaders[key] = [resHeaders[key], value];
            }
            ddSetCookies = extractDDCookies(scStrings);
          } else {
            const obj = res.headers() || {};
            const scRaw = [];
            for (const [k, v] of Object.entries(obj)) {
              const key = k.toLowerCase();
              if (key === 'set-cookie') {
                if (Array.isArray(v)) scRaw.push(...v);
                else scRaw.push(v);
              }
              resHeaders[key] = v;
            }
            ddSetCookies = extractDDCookies(scRaw);
          }
        } catch {
          try {
            const obj = res.headers() || {};
            const scRaw = [];
            const v = obj['set-cookie'] || obj['Set-Cookie'];
            if (v) {
              if (Array.isArray(v)) scRaw.push(...v);
              else scRaw.push(v);
            }
            resHeaders = obj;
            ddSetCookies = extractDDCookies(scRaw);
          } catch {}
        }
        ev.resHeaders = resHeaders;
        ev.ddSetCookies = ddSetCookies;

        // If still no Set-Cookie and Chromium, try CDP ExtraInfo (authoritative)
        if (isChromium && (!ev.ddSetCookies || ev.ddSetCookies.length === 0)) {
          // find a CDP entry with same URL+method and status if known
          const matches = [];
          for (const rec of cdpById.values()) {
            if (!rec.url || !rec.method) continue;
            if (rec.url === ev.url && rec.method === ev.method && (rec.status == null || rec.status === ev.status)) {
              matches.push(rec);
            }
          }
          // prefer last
          const m = matches[matches.length - 1];
          if (m && m.setCookieStrings && m.setCookieStrings.length) {
            ev.ddSetCookies = extractDDCookies(m.setCookieStrings);
          }
        }
      }
    } catch {
      // ignore
    }
  });

  // Start navigation
  console.log(pc.dim(`Launching browser… capturing network. ${manualFinish ? 'Interact if needed.' : ''}`));
  await page.goto(startURL, { waitUntil: 'domcontentloaded' }).catch(() => null);

  // Wait strategy
  if (manualFinish) {
    console.log(pc.dim('Press Enter here when you want to finish capture…'));
    await Promise.race([
      ask(''),
      (async () => { await sleep(HARD_WATCHDOG_MS); })()
    ]);
  } else {
    await page.waitForLoadState('networkidle', { timeout: HARD_WATCHDOG_MS }).catch(() => {});
    await sleep(WATCHDOG_IDLE_MS);
  }

  // Persist cookies
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  } catch {
    fs.writeFileSync(cookiesPath, JSON.stringify({ note: 'no cookies captured' }, null, 2));
  }

  await context.close().catch(()=>{});
  await launch.close().catch(()=>{});
  rl.close();

  // ===== Merge CDP Set-Cookie for any remaining events (belt & suspenders) =====
  // ^ we won’t re-use CDP here if not Chromium, but leaving constant as true wouldn’t hurt prints below.
  // To be precise, skip if not chromium:
  if (browserKind === 'chromium') {
    for (const ev of events) {
      if (ev.ddSetCookies && ev.ddSetCookies.length) continue;
      const candidates = [];
      for (const rec of cdpById.values()) {
        if (rec.url === ev.url && rec.method === ev.method) candidates.push(rec);
      }
      const last = candidates[candidates.length - 1];
      if (last && last.setCookieStrings && last.setCookieStrings.length) {
        ev.ddSetCookies = extractDDCookies(last.setCookieStrings);
      }
    }
  }

  // ===== PRINT RESULTS =====

  // Initial request & redirects
  console.log('\n' + pc.bold(pc.cyan('📍 Initial request & redirects')));
  const docOnTarget = docEvents.filter(d => {
    const host = new URL(d.url).hostname.toLowerCase();
    return host === targetHost || host.endsWith('.' + targetHost);
  }).sort((a,b)=>a.idx-b.idx);

  if (docOnTarget.length === 0) {
    console.log(pc.dim('   (No initial response captured.)'));
  } else {
    const first = docOnTarget[0];
    const icn = iconForStatus(first.status);
    console.log(`→ Requested: ${colorUrl(first.url)} [${icn} ${first.status ?? ''}]`);
    if (first.ddSetCookies && first.ddSetCookies.length) showDDSetCookies(first.ddSetCookies);
    else console.log(pc.dim('   No DataDome Set-Cookie on this response.'));

    if (docOnTarget.length >= 2) {
      const second = docOnTarget[1];
      console.log(`   ↪ redirected to: ${colorUrl(second.url)} [${iconForStatus(second.status)} ${second.status ?? ''}]`);
      if (second.ddSetCookies && second.ddSetCookies.length) showDDSetCookies(second.ddSetCookies);
    }
  }

  // 2) Full network capture (target + challenge; only Document/XHR/Fetch)
  events.sort((a,b) => a.idx - b.idx);

  console.log('\n' + pc.bold(pc.cyan('📦 Full network capture (Document/XHR/Fetch on target or challenge domains)')));

  let shown = 0;
  const skipInline = new Set(); // indices we already printed inline (avoid duplicate numbered rows)

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (skipInline.has(ev.idx)) continue; // suppress duplicates

    const u = new URL(ev.url);
    const host = u.hostname.toLowerCase();
    const isChallenge = host === 'geo.captcha-delivery.com';

    // Log
    const statusIcon = iconForStatus(ev.status);
    const method = ev.method || 'GET';
    const typ = niceType(ev.type);
    shown++;
    const numStr = String(shown).padStart(3, ' ');
    console.log(` ${numStr}. ${typ} (${method}) → ${colorUrl(ev.url)} [${statusIcon} ${ev.status ?? ''}]`);

    // Always show DataDome Set-Cookie if present
    if (ev.ddSetCookies && ev.ddSetCookies.length) {
      showDDSetCookies(ev.ddSetCookies);
    }

    // Request-side data: x-datadome-clientid + datadome cookie
    if (ev.ddReqCookie || ev.ddReqHeader) {
      console.log(pc.yellow('     ↳ Request headers:'));
      if (ev.ddReqHeader) {
        console.log(`       x-datadome-clientid: ${pc.white(ev.ddReqHeader)}`);
      }
      if (ev.ddReqCookie) {
        console.log(`       cookie: ${pc.white('datadome=')}${pc.white(ev.ddReqCookie)}`);
      }
    }

    // Query params for GET-like
    if (method === 'GET') {
      const qp = parseQueryParams(u);
      if (Object.keys(qp).length) {
        console.log(pc.dim('     ↳ Query params:'));
        console.log(pc.dim('       ' + safeJSON(qp).split('\n').join('\n       ')));
      }
    }

    // Body for POST/PUT/PATCH etc
    if (method !== 'GET' && ev.reqBody) {
      const ct = ev.reqHeaders['content-type'] || ev.reqHeaders['Content-Type'] || '';
      const { bodyKind, bodyOut } = decodeIfForm(ct, ev.reqBody);
      console.log(pc.dim(`     ↳ Body (${bodyKind || 'unknown'}):`));
      const lines = String(bodyOut).split('\n');
      for (const ln of lines.slice(0, 400)) {
        console.log(pc.dim('       ' + ln));
      }
      if (lines.length > 400) console.log(pc.dim('       … (truncated)'));
    }

    // If this was a 403, show the very next matching “challenge” request inline,
    // and mark it as printed so we don't output it again as a numbered item.
    if (ev.status === 403) {
      const next = events[i+1];
      if (next) {
        const nHost = new URL(next.url).hostname.toLowerCase();
        if (nHost === 'geo.captcha-delivery.com') {
          const label = next.url.includes('/interstitial/') ? 'Device Check' : (next.url.includes('/captcha/') ? 'CAPTCHA/BLOCK' : 'Challenge');
          console.log(`     ↪ Next request after 403: ${label} (${next.method || 'GET'}) → ${colorUrl(next.url)} [${iconForStatus(next.status)} ${next.status ?? ''}]`);

          // Show its DataDome Set-Cookie if present
          if (next.ddSetCookies && next.ddSetCookies.length) {
            // indent inside inline block
            const orig = console.log;
            console.log = (...args) => orig('      ' + args.join(' '));
            showDDSetCookies(next.ddSetCookies);
            console.log = orig;
          }

          // Show request headers (x-datadome-clientid/datadome)
          if (next.ddReqCookie || next.ddReqHeader) {
            console.log(pc.yellow('       ↳ Request headers:'));
            if (next.ddReqHeader) {
              console.log(`         x-datadome-clientid: ${pc.white(next.ddReqHeader)}`);
            }
            if (next.ddReqCookie) {
              console.log(`         cookie: ${pc.white('datadome=')}${pc.white(next.ddReqCookie)}`);
            }
          }

          // Params/body
          const nu = new URL(next.url);
          const qpn = parseQueryParams(nu);
          if (Object.keys(qpn).length) {
            console.log(pc.dim('       ↳ Query params:'));
            console.log(pc.dim('         ' + safeJSON(qpn).split('\n').join('\n         ')));
          }
          if ((next.method || 'GET') !== 'GET' && next.reqBody) {
            const ctn = next.reqHeaders['content-type'] || next.reqHeaders['Content-Type'] || '';
            const { bodyKind, bodyOut } = decodeIfForm(ctn, next.reqBody);
            console.log(pc.dim(`       ↳ Body (${bodyKind || 'unknown'}):`));
            const linesN = String(bodyOut).split('\n');
            for (const ln of linesN.slice(0, 400)) {
              console.log(pc.dim('         ' + ln));
            }
            if (linesN.length > 400) console.log(pc.dim('         … (truncated)'));
          }

          // avoid duplicate numbered row for this immediate challenge request
          skipInline.add(next.idx);
        }
      }
    }
  }

  if (shown === 0) {
    console.log(pc.dim('(No matching requests were captured.)'));
  }

  console.log('\n' + pc.green('📦 Saved:'));
  console.log(`  HAR:     ${pc.white(harPath)}`);
  console.log(`  Cookies: ${pc.white(cookiesPath)}`);
  console.log('\n' + pc.green('✅ Done'));
}

// ===== Run =====
main().catch(err => {
  const red = (pc && typeof pc.red === 'function') ? pc.red : (x)=>x;
  console.error(red('Unexpected error:'), err);
  process.exit(1);
});