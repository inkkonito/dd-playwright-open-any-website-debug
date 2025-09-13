// app.js
// dd-playwright-open-any-website (enhanced logging + DataDome focus)

const pc = require('picocolors');
const { chromium, firefox, webkit, devices } = require('playwright');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const urlLib = require('node:url');
const querystring = require('node:querystring');
const setCookie = require('set-cookie-parser');
const { parse: tldParse } = require('tldts');

// ========================= Colors & helpers =========================
function cSection(t) { return pc.bold(pc.cyan(t)); }
function cSubhead(t) { return pc.bold(pc.white(t)); }
function cInfo(t) { return pc.white(t); }
function cRedirect(t) { return pc.yellow(t); }
function cOk(t) { return pc.bold(pc.green(t)); }
function cBlock() { return pc.white(pc.bold(pc.bgRed('403'))); }
function cStatus(n) {
  if (n >= 200 && n < 300) return cOk(String(n));
  if (n >= 300 && n < 400) return cRedirect(String(n));
  if (n === 403) return cBlock();
  return pc.bold(String(n));
}
function cDim(t) { return pc.dim(t); }
function cURL(t) { return pc.bold(t); }
function cCounter(n) { return pc.bold(pc.white(String(n))); }
function cTag(t) {
  if (/CAPTCHA/i.test(t)) return pc.bold(pc.magenta(t));
  if (/Device Check/i.test(t)) return pc.bold(pc.blue(t));
  if (/Block/i.test(t)) return pc.bold(pc.red(t));
  return pc.bold(pc.cyan(t));
}
function cCookieKey(k) { return pc.italic(pc.cyan(k)); }
function cCookieVal(v) { return pc.bold(pc.yellow(v)); }
function cHeaderKey(k) { return pc.italic(pc.magenta(k)); }
function cHeaderVal(v) { return pc.white(v); }
function cWarn(t) { return pc.yellow(t); }
function cError(t) { return pc.red(pc.bold(t)); }

const EXTENSION_FILTER_RE = /\.(avi|flv|mka|mkv|mov|mp4|mpeg|mpg|mp3|flac|ogg|ogm|opus|wav|webm|webp|bmp|gif|ico|jpeg|jpg|png|svg|svgz|swf|eot|otf|ttf|woff|woff2|css|less|js|map)(\?|$)/i;

const CHALLENGE_HOSTS = new Set([
  'captcha-delivery.com',
  'geo.captcha-delivery.com'
]);

// Paths → tags
function challengeTagForURL(u) {
  try {
    const { hostname, pathname } = new urlLib.URL(u);
    if (!hostname) return null;
    const path = pathname || '';
    if (/^\/interstitial\/?/i.test(path)) return 'Device Check';
    if (/^\/captca\/?/i.test(path) || /^\/captcha\/?/i.test(path)) return 'CAPTCHA/BLOCK';
  } catch { /* ignore */ }
  return null;
}

// truncate long URLs for single-line listing
function truncUrl(u, max = 140) {
  if (u.length <= max) return u;
  return u.slice(0, max - 1) + '…';
}

function parseQueryParams(u) {
  try {
    const parsed = new urlLib.URL(u);
    const obj = {};
    for (const [k, v] of parsed.searchParams.entries()) obj[k] = v;
    return obj;
  } catch {
    return null;
  }
}

function prettyPrintKV(obj, indent = '       ') {
  const keys = Object.keys(obj || {});
  if (!keys.length) return;
  console.log(indent + cDim('{'));
  keys.forEach((k, i) => {
    console.log(indent + '  ' + pc.cyan(k) + cDim(': ') + pc.yellow(String(obj[k])));
  });
  console.log(indent + cDim('}'));
}

function parseBody(request) {
  const bodyText = request.postData() || '';
  if (!bodyText) return null;
  const headers = request.headers() || {};
  const ct = headers['content-type'] || headers['Content-Type'] || '';
  if (/application\/json/i.test(ct)) {
    try { return JSON.parse(bodyText); } catch { return bodyText; }
  }
  if (/application\/x-www-form-urlencoded/i.test(ct)) {
    try { return querystring.parse(bodyText); } catch { return bodyText; }
  }
  return bodyText;
}

function parseDataDomeFromSetCookie(headersArray) {
  // headersArray: [{name, value}, ...]
  const setCookies = headersArray.filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value);
  if (!setCookies.length) return null;
  const parsed = setCookie.parse(setCookies, { map: false });
  // look for datadome
  for (const c of parsed) {
    if (c && typeof c.name === 'string' && c.name.toLowerCase() === 'datadome') {
      return {
        value: c.value,
        attributes: c
      };
    }
  }
  return null;
}

function printDataDome(dd, indent = '   ') {
  if (!dd) return;
  const attrsParts = [];
  if (dd.attributes['Max-Age'] != null) attrsParts.push(pc.gray(`Max-Age=${dd.attributes['Max-Age']}`));
  if (dd.attributes.Domain) attrsParts.push(pc.gray(`Domain=${dd.attributes.Domain}`));
  if (dd.attributes.Path) attrsParts.push(pc.gray(`Path=${dd.attributes.Path}`));
  if (dd.attributes.Secure) attrsParts.push(pc.gray('Secure'));
  if (dd.attributes.SameSite) attrsParts.push(pc.gray(`SameSite=${dd.attributes.SameSite}`));
  console.log(`${indent}${pc.bold('🍪 DataDome Set-Cookie:')}`);
  console.log(`${indent}  ${cCookieKey('datadome')}=${cCookieVal(dd.value)}`);
  if (attrsParts.length) console.log(`${indent}  • ${attrsParts.join(' ')}`);
}

function findDataDomeInCookieHeader(cookieHeader) {
  if (!cookieHeader) return null;
  // split cookies by '; ' pairs aware of semicolons within values? Simple approach works for this
  // safer: parse with set-cookie-parser does not parse request cookies. We'll do manual:
  const parts = cookieHeader.split(/;\s*/);
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    if (!k) continue;
    if (k.trim().toLowerCase() === 'datadome') {
      return rest.join('=');
    }
  }
  return null;
}

function normalizeInputURL(input) {
  let s = (input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function toRegistrable(hostname) {
  try {
    const info = tldParse(hostname, { allowPrivateDomains: true });
    // Prefer the full domain when available
    return info.domain || hostname || '';
  } catch {
    return hostname || '';
  }
}

function isStaticAsset(u) {
  try {
    const { pathname } = new urlLib.URL(u);
    return EXTENSION_FILTER_RE.test(pathname);
  } catch {
    return false;
  }
}

function isDocumentLike(request) {
  const t = request.resourceType();
  return t === 'document';
}

function isXHRorFetch(request) {
  const t = request.resourceType();
  return t === 'xhr' || t === 'fetch';
}

function isOnTargetOrChallenge(host, targetDomain) {
  if (!host) return false;
  const reg = toRegistrable(host);
  if (reg.endsWith(targetDomain)) return true;
  // challenge/ecosystem
  for (const ch of CHALLENGE_HOSTS) {
    if (reg.endsWith(ch)) return true;
  }
  return false;
}

// ========================= Prompt UI =========================
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans)));
}

const UA_TEST_CODES = {
  'BLOCKUA': 'BLOCKUA',
  'BLOCKUAHARDBLOCKUA': 'BLOCKUAHARDBLOCKUA',
  'HARDBLOCK': 'HARDBLOCK',
  'HARDBLOCK_UA': 'HARDBLOCK_UA',
  'DeviceCheckTestUA': 'DeviceCheckTestUA',
  'DeviceCheckTestUA-BLOCKUA': 'DeviceCheckTestUA-BLOCKUA',
  'DeviceCheckTestUA-HARDBLOCK': 'DeviceCheckTestUA-HARDBLOCK',
};

async function promptUser() {
  console.clear()
  console.log(pc.bold(pc.cyan('🔎 Playwright Launcher\n')));

  // Browser
  console.log('Browser:');
  console.log('  0) Chromium');
  console.log('  1) Firefox');
  console.log('  2) WebKit');
  const b = (await ask('\nEnter number (default: 0): ')).trim() || '0';
  const browserKind = ({ '0': 'chromium', '1': 'firefox', '2': 'webkit' }[b] || 'chromium');

  // Headless
  console.log('\nHeadless:');
  console.log('  0) No');
  console.log('  1) Yes');
  const h = (await ask('Enter number (default: 0): ')).trim() || '0';
  const headless = (h === '1');

  // User-Agent
  console.log('\nUser-Agent:');
  console.log('  0) (default)');
  console.log('  1) Custom');
  console.log('  2) DD UA Test Codes');
  const uaMode = (await ask('Enter number (default: 0): ')).trim() || '0';
  let userAgent = null;

  if (uaMode === '1') {
    userAgent = (await ask('Enter custom User-Agent string: ')).trim();
  } else if (uaMode === '2') {
    console.log('\nDD UA Test Codes:');
    const keys = Object.keys(UA_TEST_CODES);
    keys.forEach((k, i) => console.log(`  ${i}) ${k}`));
    const pick = (await ask('Pick number: ')).trim();
    const idx = Math.max(0, Math.min(keys.length - 1, /^\d+$/.test(pick) ? Number(pick) : 0));
    const chosen = keys[idx];
    // Use the code itself as UA string (sites look for substrings)
    userAgent = chosen;
    console.log(pc.gray(`Selected: ${chosen}`));
  }

  // Finish mode
  console.log('\nFinish mode:');
  console.log('  0) Auto (network idle + 5s)');
  console.log('  1) Manual (press Enter)');
  const f = (await ask('Enter number (default: 0): ')).trim() || '0';
  const finishMode = (f === '1') ? 'manual' : 'auto';

  // URL
  let urlInput = (await ask('\nWhich website do you want to open? ')).trim();
  while (true) {
    const normalized = normalizeInputURL(urlInput);
    try {
      new urlLib.URL(normalized);
      urlInput = normalized.endsWith('/') ? normalized : normalized + '/';
      break;
    } catch {
      console.log(pc.red('❌ Invalid URL. Please try again (example: leboncoin.fr or https://leboncoin.fr).'));
      urlInput = (await ask('\nWhich website do you want to open? ')).trim();
    }
  }

  return { browserKind, headless, userAgent, finishMode, url: urlInput };
}

// ========================= Main =========================
(async () => {
  const { browserKind, headless, userAgent, finishMode, url } = await promptUser();

  // Create output dirs
  const tstamp = new Date().toISOString().replace(/[:-]/g, '').replace(/\..+/, '');
  const host = new urlLib.URL(url).hostname;
  const sessionDir = path.join(process.cwd(), 'har', `${tstamp}_${host}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Session recap
  console.log('\n' + cSection('🧾 Run Recap'));
  console.log('  ' + cSubhead('Timestamp') + ' : ' + new Date().toISOString());
  console.log('  ' + cSubhead('URL') + '       : ' + url);
  console.log('  ' + cSubhead('Browser') + '   : ' + { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' }[browserKind]);
  console.log('  ' + cSubhead('Headless') + '  : ' + (headless ? 'Yes' : 'No'));
  console.log('  ' + cSubhead('Egress IP') + ' : ' + '(detects by site; not pre-fetched)');
  console.log('  ' + cSubhead('User-Agent') + ': ' + (userAgent || '(default)'));
  console.log('  ' + cSubhead('Session') + '   : ' + sessionDir);
  const harPath = path.join(sessionDir, `${tstamp}_${host}.har`);
  const cookiesPath = path.join(sessionDir, `${tstamp}_${host}.cookies.json`);
  console.log('  ' + cSubhead('HAR') + '       : ' + harPath);
  console.log('  ' + cSubhead('Cookies') + '   : ' + cookiesPath);
  console.log('  ' + cSubhead('Finish') + '    : ' + (finishMode === 'auto' ? 'auto on network idle + 5s' : 'manual (press Enter)'));

  const targetDomain = toRegistrable(host);

  // Launch proper browser
  const browsers = { chromium, firefox, webkit };
  const launch = browsers[browserKind];

  const contextOpts = {
    userAgent: userAgent || undefined,
    recordHar: {
      path: harPath,
      mode: 'full',
      content: 'embed',
    },
    ignoreHTTPSErrors: true,
  };

  // Note: headless is a page-level option in launch()
  const browser = await launch.launch({ headless });
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  // Local state for capture
  const captured = []; // { id, ts, method, url, status, resourceType, reqHeaders, resHeadersArray, reqBody, tag?, isTarget?, hostname }
  const byRequestId = new Map(); // req → idx
  const inlinedAfter403 = new Set(); // entries that we already printed as "Next after 403"

  let initialDocumentRequest = null;
  let initialChain = []; // sequence of DOCUMENT responses starting from first navigation
  let main403Idx = -1;

  // Shield against page closing mid-iteration
  async function safeHeadersArray(response) {
    try {
      const arr = await response.headersArray();
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  page.on('request', (request) => {
    try {
      const urlStr = request.url();
      const hostname = (new urlLib.URL(urlStr)).hostname;

      // store doc/xhr/fetch only and exclude static assets
      const rt = request.resourceType();
      if (!(rt === 'document' || rt === 'xhr' || rt === 'fetch')) return;
      if (isStaticAsset(urlStr)) return;

      const id = request._guid || `${request.method()} ${urlStr} ${Date.now()} ${Math.random()}`; // best-effort identity
      const entry = {
        id,
        ts: Date.now(),
        method: request.method(),
        url: urlStr,
        status: null,
        resourceType: rt.toUpperCase(),
        reqHeaders: request.headers(),
        resHeadersArray: [],
        reqBody: (request.method() !== 'GET') ? parseBody(request) : null,
        tag: challengeTagForURL(urlStr),
        isTarget: isOnTargetOrChallenge(hostname, targetDomain),
        hostname,
      };
      byRequestId.set(request, captured.length);
      captured.push(entry);

      if (rt === 'document' && !initialDocumentRequest) {
        initialDocumentRequest = request;
      }
    } catch { /* ignore */ }
  });

  page.on('response', async (response) => {
    // Match response to request
    try {
      const request = response.request();
      const idx = byRequestId.get(request);
      // Ignore if not in our map (filtered out earlier)
      if (idx === undefined) return;

      const arr = await safeHeadersArray(response);

      captured[idx].resHeadersArray = arr;
      captured[idx].status = response.status();

      // Build initial chain (DOCUMENT only)
      if (request.resourceType() === 'document') {
        initialChain.push({
          url: request.url(),
          status: response.status(),
          headersArray: arr
        });
      }
    } catch { /* ignore */ }
  });

  console.log('\n' + cInfo('Launching browser… capturing network. ') + (finishMode === 'auto' ? '' : cDim('(Manual finish)')));
  // Navigate
  let mainResponse = null;
  try {
    mainResponse = await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    console.log(cError(`Navigation error: ${e.message}`));
  }

  // Finish mode handling
  if (finishMode === 'manual') {
    await ask(pc.gray('\nPress Enter to stop capture… '));
  } else {
    // network idle + 5s
    try {
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(5000);
    } catch {}
  }

  // Persist cookies
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  } catch {}

  // Close HAR recording
  try {
    await context.close(); // ensures HAR is flushed
  } catch {}

  // ========================= Printing =========================

  // INITIAL REQUEST + REDIRECTS (DOCUMENT chain)
  console.log('\n' + cSection('📍 Initial request & redirects'));
  if (initialChain.length === 0 && mainResponse) {
    // Fallback: single main response
    const s = mainResponse.status();
    const h = await safeHeadersArray(mainResponse);
    console.log(`→ Requested: ${cURL(url)} [${cStatus(s)}]`);
    const dd = parseDataDomeFromSetCookie(h);
    if (dd) printDataDome(dd, '   ');
  } else if (initialChain.length > 0) {
    // Print first
    const first = initialChain[0];
    console.log(`→ Requested: ${cURL(first.url)} [${cStatus(first.status)}]`);
    const dd0 = parseDataDomeFromSetCookie(first.headersArray || []);
    if (dd0) {
      printDataDome(dd0, '   ');
    } else {
      console.log('   ' + cDim('No DataDome Set-Cookie on this response.'));
    }
    // Print the redirects + terminal
    for (let i = 1; i < initialChain.length; i++) {
      const it = initialChain[i];
      const label = `[${cStatus(it.status)}]`;
      console.log(`   ↪ redirected to: ${cURL(it.url)} ${label}`);
      const dd = parseDataDomeFromSetCookie(it.headersArray || []);
      if (dd) printDataDome(dd, '   ');
      if (it.status === 403 && main403Idx === -1) {
        // mark that later when we print full capture we will connect "next after 403"
        // We'll find the index in captured that matches this URL + document
        const idx = captured.findIndex(
          e => e.resourceType === 'DOCUMENT' && e.url === it.url && e.status === 403
        );
        main403Idx = idx;
      }
    }
  } else {
    console.log(cWarn('No initial DOCUMENT responses captured.'));
  }

  // Build a filtered, ordered list:
  // Only target or challenge domains; only DOCUMENT/XHR/FETCH; exclude static assets (already excluded)
  const list = captured
    .filter(e => e.isTarget && (e.resourceType === 'DOCUMENT' || e.resourceType === 'XHR' || e.resourceType === 'FETCH'))
    .sort((a, b) => a.ts - b.ts);

  // Build a map from index to "next after 403" if any
  const idxToNext = new Map(); // idx -> nextIdx
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.status === 403 && e.resourceType === 'DOCUMENT') {
      // find next chronological item
      const next = list[i + 1];
      if (next) {
        idxToNext.set(i, i + 1);
        inlinedAfter403.add(i + 1);
      }
    }
  }

  // ========================= FULL NETWORK CAPTURE =========================
  console.log('\n' + cSection('📦 Full network capture (Document/XHR/Fetch on target or challenge domains)'));
  let counter = 0;
  for (let i = 0; i < list.length; i++) {
    if (inlinedAfter403.has(i)) {
      // skip duplicates already inlined under a 403 block
      continue;
    }
    const e = list[i];
    const statusLabel = (e.status === 403 ? cBlock() : cStatus(e.status || 0));
    const tagStr = e.tag ? cTag(e.tag) : e.resourceType;
    console.log(`  ${cCounter(++counter)}. ${tagStr} (${e.method}) → ${cURL(truncUrl(e.url))} [${statusLabel}]`);

    // If response had DataDome set-cookie
    const ddSet = parseDataDomeFromSetCookie(e.resHeadersArray || []);
    if (ddSet) printDataDome(ddSet, '   ');

    // Request headers of interest
    const reqHeaders = e.reqHeaders || {};
    const ddClient = reqHeaders['x-datadome-clientid'] || reqHeaders['X-Datadome-Clientid'] || reqHeaders['x-datadomeclientid'];
    if (ddClient) {
      console.log(`   ${cHeaderKey('x-datadome-clientid')}: ${cHeaderVal(ddClient)}`);
    }
    const cookieHeader = reqHeaders.cookie || reqHeaders.Cookie;
    const ddReqCookie = findDataDomeInCookieHeader(cookieHeader);
    if (ddReqCookie) {
      console.log(`   ${cCookieKey('cookie.datadome')}: ${cCookieVal(ddReqCookie)}`);
    }

    // Payload (query/body)
    if (e.method === 'GET') {
      const qp = parseQueryParams(e.url);
      if (qp && Object.keys(qp).length) {
        console.log('   ' + pc.bold('↳ Query params:'));
        prettyPrintKV(qp);
      }
    } else {
      if (e.reqBody != null) {
        console.log('   ' + pc.bold('↳ Body:'));
        if (typeof e.reqBody === 'string') {
          console.log('     ' + cDim(e.reqBody));
        } else {
          prettyPrintKV(e.reqBody);
        }
      }
    }

    // For a 403 DOCUMENT, inline the very next request if present
    if (e.status === 403 && e.resourceType === 'DOCUMENT') {
      const nextIdx = idxToNext.get(i);
      if (typeof nextIdx === 'number') {
        const n = list[nextIdx];
        const nstatus = (n.status === 403 ? cBlock() : cStatus(n.status || 0));
        const nlabel = n.tag ? cTag(n.tag) : (n.resourceType || '');
        console.log(`     ↪ Next request after 403: ${nlabel} (${n.method}) → ${cURL(truncUrl(n.url))} [${nstatus}]`);

        const ddSetN = parseDataDomeFromSetCookie(n.resHeadersArray || []);
        if (ddSetN) printDataDome(ddSetN, '       ');

        const reqHeadersN = n.reqHeaders || {};
        const ddClientN = reqHeadersN['x-datadome-clientid'] || reqHeadersN['X-Datadome-Clientid'] || reqHeadersN['x-datadomeclientid'];
        if (ddClientN) console.log(`       ${cHeaderKey('x-datadome-clientid')}: ${cHeaderVal(ddClientN)}`);
        const cookieHeaderN = reqHeadersN.cookie || reqHeadersN.Cookie;
        const ddReqCookieN = findDataDomeInCookieHeader(cookieHeaderN);
        if (ddReqCookieN) console.log(`       ${cCookieKey('cookie.datadome')}: ${cCookieVal(ddReqCookieN)}`);

        if (n.method === 'GET') {
          const qpN = parseQueryParams(n.url);
          if (qpN && Object.keys(qpN).length) {
            console.log('       ' + pc.bold('↳ Query params:'));
            prettyPrintKV(qpN, '         ');
          }
        } else {
          if (n.reqBody != null) {
            console.log('       ' + pc.bold('↳ Body:'));
            if (typeof n.reqBody === 'string') {
              console.log('         ' + cDim(n.reqBody));
            } else {
              prettyPrintKV(n.reqBody, '         ');
            }
          }
        }
      }
    }
  }

  // ========================= SAVED PATHS =========================
  console.log('\n' + cSection('📦 Saved:'));
  console.log('  ' + cSubhead('HAR:') + '     ' + harPath);
  console.log('  ' + cSubhead('Cookies:') + ' ' + cookiesPath);

  console.log('\n' + pc.bold(pc.green('✅ Done')));
  rl.close();
})().catch((err) => {
  console.error(cError(err?.stack || String(err)));
  try { rl.close(); } catch {}
  process.exit(1);
});