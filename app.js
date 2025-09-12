#!/usr/bin/env node
/* app.js — Narrative-first DataDome flow
   - Numeric prompts (browser/headless/UA: default or custom)
   - Auto-finish on network idle (no user action)
   - Shows ONLY Document/XHR/Fetch
   - Run Recap (top): Request IP (Chromium) + actual User-Agent
   - "Network Requests" section:
       → Requested (main) → status
       → Always show DataDome Set-Cookie line right under the requested line when status is 200/403
       → If 403 → list subsequent Device Check and CAPTCHA/BLOCK steps; also show their DataDome cookies on a separate line when 200/403
   - HAR & cookies saved atomically in a dated folder
*/
const { chromium, firefox, webkit } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

const APP_DIR = path.resolve(__dirname);
const APP_HAR_ROOT = path.join(APP_DIR, 'har');
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

/* Tunables */
const QUIET_MS = 5000;          // Finish after this much network silence
const MAX_CAPTURE_MS = 120000;  // Safety cap for the whole run
const ALLOWED_TYPES = new Set(['document','xhr','fetch']); // keep the signal only

/* Helpers */
function clearScreen(){ process.stdout.write('\x1Bc'); }
function pad2(n){ return String(n).padStart(2,'0'); }
function ts(d=new Date()){ return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; }
function sanitize(s){ return s.replace(/[^a-z0-9._-]+/gi,'_').slice(0,120); }
function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{ recursive:true }); }
function normalizeUrl(input){ try{ const has=/^https?:\/\//i.test(input); return new URL(has?input:`https://${input}`).toString(); }catch{ return null; } }
function writeJSONAtomic(file, obj){ const tmp=file+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj,null,2)); fs.renameSync(tmp,file); }
function trunc(u,max=100){ return u.length<=max?u:u.slice(0,max-1)+'…'; }
function statusIcon(s){ return s===403?'🚫':(s===200?'✅':'ℹ️'); }

/* Robust Set-Cookie parsing */
function splitSetCookieValue(v) {
  // Playwright may return:
  // - headerValues('set-cookie') → string[]
  // - headers()['set-cookie'] → string (possibly "\n"-separated)
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return v.includes('\n') ? v.split('\n') : [v];
  return [];
}
function extractDDFromHeadersObject(headersObj){
  const v = headersObj && headersObj['set-cookie'];
  return extractDD(splitSetCookieValue(v));
}
function extractDD(setCookies){
  const out=[];
  for(const sc of setCookies||[]){
    const first=(sc||'').split(';',1)[0].trim();
    const i=first.indexOf('=');
    if(i>0){
      const name=first.slice(0,i), val=first.slice(i+1);
      if(/^datadome$/i.test(name)) out.push(`${name}=${val}`);
    }
  }
  return out;
}
function classifyDD(url){
  if (!url) return null;
  if (/\/interstitial\//i.test(url)) return 'Device Check';
  if (/\/captcha\//i.test(url))      return 'CAPTCHA/BLOCK'; // indistinguishable → label both
  return null;
}

async function main(){
  clearScreen();
  console.log('🔎 Playwright Launcher\n');

  // URL
  const urlIn = await ask('Which website do you want to open? ');
  const url = normalizeUrl(urlIn);
  if (!url) { console.log('❌ Invalid URL.'); process.exit(1); }

  // Browser (0 Chromium / 1 Firefox / 2 WebKit)
  console.log('\nChoose browser:\n  0) Chromium\n  1) Firefox\n  2) WebKit');
  const bRaw = await ask('Enter number (default: 0): ');
  const bIdx = Number(bRaw);
  const browserType = [chromium, firefox, webkit][(Number.isNaN(bIdx)||bIdx<0||bIdx>2)?0:bIdx];
  const browserName = ['Chromium','Firefox','WebKit'][(Number.isNaN(bIdx)||bIdx<0||bIdx>2)?0:bIdx];

  // Headless (0 No / 1 Yes)
  console.log('\nHeadless:\n  0) No\n  1) Yes');
  const hRaw = await ask('Enter number (default: 0): ');
  const headless = (hRaw==='1');

  // UA (0 default; 1 custom)
  console.log('\nUser-Agent:\n  0) (default)\n  1) Custom');
  const uRaw = await ask('Enter number (default: 0): ');
  let ua = null;
  if (uRaw==='1') { const custom = await ask('Enter full UA string: '); ua = custom.trim()||null; }

  // Session folder
  ensureDir(APP_HAR_ROOT);
  const baseName   = `${ts()}_${sanitize(new URL(url).host)}`;
  const APP_SESSION = path.join(APP_HAR_ROOT, baseName);
  ensureDir(APP_SESSION);

  const harFinal     = path.join(APP_SESSION, `${baseName}.har`);
  const harTemp      = harFinal + '.tmp';
  const cookiesFinal = path.join(APP_SESSION, `${baseName}.cookies.json`);
  const cookiesTemp  = cookiesFinal + '.tmp';

  // Launch & context (recap printed later once IP + UA are known)
  const browser = await browserType.launch({ headless });
  const ctxOpts = { recordHar: { path: harTemp, omitContent: false } };
  if (ua) ctxOpts.userAgent = ua;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  // External Request IP (Chromium) + Actual main-request UA
  let requestIP = 'N/A';
  let mainUA = null;
  if (browserType === chromium) {
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      const targetHost = new URL(url).host;
      cdp.on('Network.responseReceived', (ev) => {
        try {
          const resp = ev.response || {};
          const u = resp.url || '';
          if (resp.remoteIPAddress && (ev.type === 'Document' || u.includes(targetHost))) {
            requestIP = resp.remoteIPAddress + (resp.remotePort?`:${resp.remotePort}`:'');
          }
        } catch {}
      });
    } catch {}
  }
  page.on('request', async (req) => {
    try {
      if (!mainUA && req.isNavigationRequest?.() && req.frame()===page.mainFrame()) {
        const hdrs = await req.allHeaders?.() || {};
        mainUA = hdrs['user-agent'] || mainUA;
      }
    } catch {}
  });

  // Records for flow
  const entries = [];            // only Document/XHR/Fetch
  let mainNavResponse = null;    // last main document response

  // Response listener (robust Set-Cookie extraction)
  page.on('response', async (res)=>{
    try{
      const req = res.request();
      const type = req.resourceType?.() || 'other';
      if (!ALLOWED_TYPES.has(type)) return;

      let dd=[];
      try {
        if (typeof res.headerValues === 'function') {
          const hv = await res.headerValues('set-cookie'); // string[] (PW >=1.45)
          dd = extractDD(hv);
        } else {
          const hs = res.headers?.() || {};
          dd = extractDDFromHeadersObject(hs);            // string or "\n"-joined string
        }
      } catch {}

      const rec = {
        url: res.url(),
        status: res.status(),
        type,
        isMain: (req.isNavigationRequest?.() && req.frame()===page.mainFrame()) || false,
        ddCookies: dd,
        ddPhase: classifyDD(res.url()),
        t0: Date.now()
      };
      entries.push(rec);
    }catch{}
  });

  // Network idle logic
  let finishRequested = false, idleTimer=null, inflight=0;
  function armIdleTimer(){
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(()=>{
      console.log(`\n📴 Network idle detected for ${QUIET_MS/1000}s — capture complete`);
      finishRequested = true;
    }, QUIET_MS);
  }
  page.on('request',        ()=>{ inflight++; if (idleTimer) { clearTimeout(idleTimer); idleTimer=null; } });
  page.on('requestfinished',()=>{ inflight=Math.max(0,inflight-1); if (inflight===0) armIdleTimer(); });
  page.on('requestfailed',  ()=>{ inflight=Math.max(0,inflight-1); if (inflight===0) armIdleTimer(); });

  await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 }).catch(()=>{});
  armIdleTimer();

  const start=Date.now();
  while(!finishRequested){
    if ((Date.now()-start)>MAX_CAPTURE_MS) { console.log('\n⏱️ Max capture time reached — finishing.'); break; }
    await sleep(250);
  }

  // Main document (last main doc among allowed)
  const mains = entries.filter(e=>e.isMain && e.type==='document').sort((a,b)=>a.t0-b.t0);
  mainNavResponse = mains.length ? mains[mains.length-1] : null;

  // “Actual UA” used (prefer header from main request, else context UA, else fallback)
  const actualUA = mainUA || ua || '(browser default)';

  // ---- Run Recap (top) ----
  clearScreen();
  console.log('🧾 Run Recap');
  console.log(`  Timestamp : ${new Date().toISOString()}`);
  console.log(`  URL       : ${url}`);
  console.log(`  Browser   : ${browserName}`);
  console.log(`  Headless  : ${headless ? 'Yes' : 'No'}`);
  console.log(`  Request IP: ${requestIP}`);         // only at top
  console.log(`  User-Agent: ${actualUA}`);
  console.log(`  Session   : ${APP_SESSION}`);
  console.log(`  HAR       : ${harFinal}`);
  console.log(`  Cookies   : ${cookiesFinal}`);
  console.log(`  Finish    : auto on network idle + ${QUIET_MS/1000}s\n`);

  // Persist cookies & HAR
  try {
    const [state, jar] = await Promise.all([context.storageState(), context.cookies()]);
    writeJSONAtomic(cookiesTemp, { url, timestamp:new Date().toISOString(), storageState: state, cookies: jar });
    if (fs.existsSync(cookiesTemp)) fs.renameSync(cookiesTemp, cookiesFinal);
  } catch {}
  await context.close().catch(()=>{});
  if (fs.existsSync(harTemp)) fs.renameSync(harTemp, harFinal);

  // ---- Network Requests (simple & clear) ----
  console.log('📖 Network Requests');
  if (mainNavResponse) {
    const s = mainNavResponse.status;
    console.log(`→ Requested: ${trunc(mainNavResponse.url)} [${statusIcon(s)} ${s}]`);
    // ALWAYS show DataDome Set-Cookie on its own line when main status is 200/403
    if ((s===200 || s===403) && mainNavResponse.ddCookies && mainNavResponse.ddCookies.length){
      console.log(`   🍪 DataDome Set-Cookie: ${mainNavResponse.ddCookies.join('; ')}`);
    }

    if (s===403) {
      // Only subsequent DD-classified steps, sorted; print cookie on its own line when 200/403
      const seq = entries
        .filter(e => !e.isMain && e.ddPhase)
        .sort((a,b)=>a.t0 - b.t0);
      if (seq.length){
        console.log('   Subsequent requests triggered:');
        let i=1;
        for (const e of seq){
          console.log(`     ${i++}. ${e.ddPhase} → ${trunc(e.url, 140)} [${statusIcon(e.status)} ${e.status}]`);
          if ((e.status===200 || e.status===403) && e.ddCookies && e.ddCookies.length){
            console.log(`        🍪 DataDome Set-Cookie: ${e.ddCookies.join('; ')}`);
          }
        }
      } else {
        console.log('   No challenge sequence detected.');
      }
    }
  } else {
    console.log('No main document captured.');
  }

  console.log('\n📦 Saved:');
  console.log(`  HAR:     ${harFinal}`);
  console.log(`  Cookies: ${cookiesFinal}`);
  console.log('\n✅ Done');

  await browser.close().catch(()=>{});
  process.exit(0);
}

main().catch(e=>{ console.error('Unexpected error:', e); process.exit(1); });