#!/usr/bin/env node
/* app.js — DataDome capture with colored logs
   - URL prompt loops until valid
   - Numeric prompts (browser 0/1/2, headless 0/1)
   - UA prompt: "0" (default), "1" (then ask), or paste UA directly
   - Hard UA replacement (context, headers, route, navigator)
   - Capture only Document/XHR/Fetch
   - Run Recap: Egress IP + UA (colored)
   - Network Requests:
       → Requested main doc (with full DataDome cookie attributes if 200/403)
       → HTTP 403 incidents after initial request (no duplication of main doc)
       → Subsequent requests after initial request (ALWAYS shown): method, full URL, payloads, cookies, and DD phase (Device Check/CAPTCHA/BLOCK)
   - HAR + cookies saved per session
   - Colors via chalk (CommonJS-compatible: use chalk@4)
*/
const { chromium, firefox, webkit } = require('playwright');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

const APP_DIR = path.resolve(__dirname);
const APP_HAR_ROOT = path.join(APP_DIR, 'har');
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

/* Tunables */
const QUIET_MS = 5000;           // time with no inflight requests to consider "idle"
const MAX_CAPTURE_MS = 120000;   // absolute cap per run (safety)
const ALLOWED_TYPES = new Set(['document','xhr','fetch']);
const MAX_RAW_BODY_CHARS = 4000; // bound for raw POST bodies

/* Helpers */
function clearScreen(){ process.stdout.write('\x1Bc'); }
function pad2(n){ return String(n).padStart(2,'0'); }
function ts(d=new Date()){
  return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function sanitize(s){ return s.replace(/[^a-z0-9._-]+/gi,'_').slice(0,120); }
function ensureDir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p,{ recursive:true }); }
function normalizeUrl(input){ try{ const has=/^https?:\/\//i.test(input); return new URL(has?input:`https://${input}`).toString(); }catch{ return null; } }
function writeJSONAtomic(file, obj){ const tmp=file+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj,null,2)); fs.renameSync(tmp,file); }
function statusIcon(s){ return s===403?chalk.red('🚫 403'):s===200?chalk.green('✅ 200'):chalk.yellow(`ℹ️ ${s}`); }

/* Query params pretty-printer */
function prettyQueryParams(urlStr){
  try{
    const u = new URL(urlStr);
    if (![...u.searchParams].length) return null;
    const obj={};
    for(const [k,v] of u.searchParams.entries()){
      if(obj[k]===undefined) obj[k]=v;
      else if(Array.isArray(obj[k])) obj[k].push(v);
      else obj[k]=[obj[k],v];
    }
    return JSON.stringify(obj,null,2);
  }catch{ return null; }
}

/* Set-Cookie parsing */
function splitSetCookieValue(v){
  if(!v) return [];
  if(Array.isArray(v)) return v;
  if(typeof v==='string') return v.includes('\n')?v.split('\n'):[v];
  return [];
}
function parseSetCookie(raw){
  raw=(raw||'').trim(); if(!raw) return null;
  const parts=raw.split(';');
  const nv=(parts.shift()||'').trim();
  const eq=nv.indexOf('=');
  if(eq<=0) return null;
  const name=nv.slice(0,eq).trim();
  const value=nv.slice(eq+1).trim();

  const attrs={};
  for(const p of parts){
    const seg=p.trim(); if(!seg) continue;
    const i=seg.indexOf('=');
    if(i===-1){
      const key=seg.toLowerCase();
      if(key==='secure') attrs.Secure=true;
      else if(key==='httponly') attrs.HttpOnly=true;
      else attrs[seg]=true;
    } else {
      const k=seg.slice(0,i).trim(), v=seg.slice(i+1).trim(), key=k.toLowerCase();
      if(key==='domain') attrs.Domain=v;
      else if(key==='path') attrs.Path=v;
      else if(key==='expires') attrs.Expires=v;
      else if(key==='max-age') attrs['Max-Age']=v;
      else if(key==='samesite') attrs.SameSite=v;
      else attrs[k]=v;
    }
  }
  return {name,value,attrs};
}
function extractDDDetailed(setCookies){
  const out=[];
  for(const sc of setCookies||[]){
    const parsed=parseSetCookie(sc);
    if(parsed && /^datadome$/i.test(parsed.name)) out.push(parsed);
  }
  return out;
}
function extractDDFromHeadersObject(headersObj){
  const v=headersObj&&headersObj['set-cookie'];
  return extractDDDetailed(splitSetCookieValue(v));
}
function formatCookieLine(c){
  const base=chalk.yellow(`${c.name}=${c.value}`);
  const attrs=[];
  for(const [k,v] of Object.entries(c.attrs||{})){
    attrs.push(v===true?k:`${k}=${v}`);
  }
  return attrs.length?`${base}\n       ${chalk.gray(attrs.join(' • '))}`:base;
}
function classifyDD(url){
  if (/\/interstitial\//i.test(url)) return 'Device Check';
  if (/\/captcha\//i.test(url))      return 'CAPTCHA/BLOCK';
  return null;
}

/* Detect egress IP (public IP) via same browser context */
async function detectEgressIP(page){
  try{
    const ip6 = await page.evaluate(()=>fetch('https://api64.ipify.org?format=json',{cache:'no-store'}).then(r=>r.json()).then(j=>j.ip).catch(()=>null));
    if (ip6) return ip6;
    const ip4 = await page.evaluate(()=>fetch('https://api.ipify.org?format=json',{cache:'no-store'}).then(r=>r.json()).then(j=>j.ip).catch(()=>null));
    return ip4 || 'N/A';
  }catch{ return 'N/A'; }
}

/* Pretty POST body */
function prettyPostBody(body,contentType=''){
  if(!body) return null;
  const ct=(contentType||'').toLowerCase();
  if(ct.includes('application/json')){
    try{ return JSON.stringify(JSON.parse(body),null,2); }catch{}
  }
  if(ct.includes('application/x-www-form-urlencoded')){
    try{
      const params=new URLSearchParams(body);
      const obj={};
      for(const [k,v] of params.entries()){
        if(obj[k]===undefined) obj[k]=v;
        else if(Array.isArray(obj[k])) obj[k].push(v);
        else obj[k]=[obj[k],v];
      }
      return JSON.stringify(obj,null,2);
    }catch{}
  }
  return body.length>MAX_RAW_BODY_CHARS
    ? body.slice(0,MAX_RAW_BODY_CHARS)+`…[+${body.length-MAX_RAW_BODY_CHARS} chars]`
    : body;
}

async function main(){
  clearScreen();
  console.log(chalk.cyan.bold('🔎 Playwright Launcher\n'));

  // URL (loop until valid)
  let url;
  while (true) {
    const urlIn = await ask('Which website do you want to open? ');
    url = normalizeUrl(urlIn);
    if (url) break;
    console.log(chalk.red('❌ Invalid URL. Please try again.\n'));
  }

  // Browser
  console.log('\nChoose browser:\n  0) Chromium\n  1) Firefox\n  2) WebKit');
  const bRaw = await ask('Enter number (default: 0): ');
  const bIdx = Number(bRaw);
  const browserType = [chromium, firefox, webkit][(Number.isNaN(bIdx)||bIdx<0||bIdx>2)?0:bIdx];
  const browserName = ['Chromium','Firefox','WebKit'][(Number.isNaN(bIdx)||bIdx<0||bIdx>2)?0:bIdx];

  // Headless
  console.log('\nHeadless:\n  0) No\n  1) Yes');
  const hRaw = await ask('Enter number (default: 0): ');
  const headless = (hRaw==='1');

  // UA (accept "0", "1" then ask, or paste a UA directly)
  console.log('\nUser-Agent:\n  0) (default)\n  1) Custom\n  (or paste UA string directly)');
  const uRaw = await ask('Enter number or UA string (default: 0): ');
  let ua = null;
  if (uRaw === '1') {
    const custom = await ask('Enter full UA string: ');
    ua = (custom || '').trim() || null;
  } else if (uRaw && uRaw !== '0') {
    ua = uRaw.trim();
  }

  // Session paths
  ensureDir(APP_HAR_ROOT);
  const baseName = `${ts()}_${sanitize(new URL(url).host)}`;
  const APP_SESSION = path.join(APP_HAR_ROOT, baseName);
  ensureDir(APP_SESSION);

  const harFinal     = path.join(APP_SESSION, `${baseName}.har`);
  const harTemp      = harFinal + '.tmp';
  const cookiesFinal = path.join(APP_SESSION, `${baseName}.cookies.json`);
  const cookiesTemp  = cookiesFinal + '.tmp';

  // Launch & context
  const browser = await browserType.launch({ headless });
  const ctxOpts = { recordHar: { path: harTemp, omitContent: false } };
  if (ua) ctxOpts.userAgent = ua; // context UA
  const context = await browser.newContext(ctxOpts);

  // Extra headers for UA (belt and suspenders)
  if (ua) await context.setExtraHTTPHeaders({ 'user-agent': ua });

  // Page
  const page = await context.newPage();

  // Align JS-visible UA + neutralize Client Hints
  if (ua) {
    await context.addInitScript((forcedUA) => {
      try { Object.defineProperty(navigator, 'userAgent', { get: () => forcedUA }); } catch {}
      try { Object.defineProperty(navigator, 'userAgentData', { get: () => undefined }); } catch {}
    }, ua);
  }

  // HARD header replacement via routing — affects ALL requests (nav + XHR/fetch)
  if (ua) {
    await context.route('**/*', async (route) => {
      const req = route.request();
      const headers = { ...(await req.headers()) };
      headers['user-agent'] = ua;

      // Strip CH headers that could contradict the UA
      delete headers['sec-ch-ua'];
      delete headers['sec-ch-ua-mobile'];
      delete headers['sec-ch-ua-platform'];
      delete headers['sec-ch-ua-platform-version'];
      delete headers['sec-ch-ua-arch'];
      delete headers['sec-ch-ua-model'];
      delete headers['sec-ch-ua-bitness'];
      delete headers['sec-ch-ua-full-version'];
      delete headers['sec-ch-ua-full-version-list'];

      await route.continue({ headers });
    });
  }

  // Egress IP + actual UA observed on the wire (main request)
  const egressIP = await detectEgressIP(page);
  let mainUA = null;
  page.on('request', async (req) => {
    try {
      if (!mainUA && req.isNavigationRequest?.() && req.frame()===page.mainFrame()) {
        const hdrs = await req.allHeaders?.() || {};
        mainUA = hdrs['user-agent'] || mainUA;
      }
    } catch {}
  });

  // Collection
  const entries = []; // {url,status,type,isMain,ddCookiesDetailed,ddPhase,t0,method,reqCT,postBodyPretty,queryPretty}
  let mainNavResponse = null;

  page.on('response', async (res)=>{
    try{
      const req = res.request();
      const type = req.resourceType?.() || 'other';
      if (!ALLOWED_TYPES.has(type)) return;

      const method = req.method?.() || 'GET';
      let reqHeaders = {};
      try { reqHeaders = await req.headers?.() || {}; } catch {}
      const reqCT = (reqHeaders['content-type'] || reqHeaders['Content-Type'] || '').toString();

      let postBodyPretty = null;
      if (method === 'POST') {
        try {
          const body = (typeof req.postData === 'function') ? (req.postData() || '') : '';
          postBodyPretty = prettyPostBody(body, reqCT);
        } catch {}
      }

      const urlStr = res.url();
      const queryPretty = prettyQueryParams(urlStr);

      // DataDome cookies with attributes
      let ddDetailed = [];
      try {
        if (typeof res.headerValues === 'function') {
          const hv = await res.headerValues('set-cookie');
          ddDetailed = extractDDDetailed(hv);
        } else {
          const hs = res.headers?.() || {};
          ddDetailed = extractDDFromHeadersObject(hs);
        }
      } catch {}

      entries.push({
        url: urlStr,
        status: res.status(),
        type,
        isMain: (req.isNavigationRequest?.() && req.frame()===page.mainFrame()) || false,
        ddCookiesDetailed: ddDetailed,
        ddPhase: classifyDD(urlStr),
        t0: Date.now(),
        method,
        reqCT,
        postBodyPretty,
        queryPretty
      });
    }catch{}
  });

  // Network idle logic
  let finishRequested=false, idleTimer=null, inflight=0;
  function armIdleTimer(){
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(()=>{
      console.log(chalk.gray(`\n📴 Network idle ${QUIET_MS/1000}s — finishing`));
      finishRequested = true;
    }, QUIET_MS);
  }
  page.on('request',        ()=>{ inflight++; if (idleTimer) { clearTimeout(idleTimer); idleTimer=null; } });
  page.on('requestfinished',()=>{ inflight=Math.max(0,inflight-1); if (inflight===0) armIdleTimer(); });
  page.on('requestfailed',  ()=>{ inflight=Math.max(0,inflight-1); if (inflight===0) armIdleTimer(); });

  // Navigate & wait
  await page.goto(url, { waitUntil:'domcontentloaded', timeout:30000 }).catch(()=>{});
  armIdleTimer();

  const start=Date.now();
  while(!finishRequested){
    if ((Date.now()-start)>MAX_CAPTURE_MS) { console.log(chalk.red('\n⏱️ Max capture time reached')); break; }
    await sleep(250);
  }

  // Main doc
  const mains = entries.filter(e=>e.isMain && e.type==='document').sort((a,b)=>a.t0-b.t0);
  mainNavResponse = mains.length ? mains[mains.length-1] : null;

  const actualUA = mainUA || ua || '(browser default)';

  // Recap
  clearScreen();
  console.log(chalk.cyan.bold('🧾 Run Recap'));
  console.log(`  ${chalk.white('Timestamp')}: ${new Date().toISOString()}`);
  console.log(`  ${chalk.white('URL')}: ${chalk.green(url)}`);
  console.log(`  ${chalk.white('Browser')}: ${browserName}`);
  console.log(`  ${chalk.white('Headless')}: ${headless ? chalk.green('Yes') : chalk.red('No')}`);
  console.log(`  ${chalk.white('Egress IP')}: ${chalk.magenta(egressIP)}`);
  console.log(`  ${chalk.white('User-Agent')}: ${chalk.yellow(actualUA)}`);
  console.log(`  ${chalk.white('Session')}: ${APP_SESSION}`);
  console.log(`  ${chalk.white('HAR')}: ${harFinal}`);
  console.log(`  ${chalk.white('Cookies')}: ${cookiesFinal}`);
  console.log(`  ${chalk.white('Finish')}: auto on network idle + ${QUIET_MS/1000}s\n`);

  // Save artifacts
  try{
    const [state, jar] = await Promise.all([context.storageState(), context.cookies()]);
    writeJSONAtomic(cookiesTemp, { url, timestamp:new Date().toISOString(), storageState: state, cookies: jar });
    if (fs.existsSync(cookiesTemp)) fs.renameSync(cookiesTemp, cookiesFinal);
  }catch{}
  await context.close().catch(()=>{});
  if (fs.existsSync(harTemp)) fs.renameSync(harTemp, harFinal);

  // Output
  console.log(chalk.cyan.bold('📖 Network Requests'));

  // Requested (main)
  if (mainNavResponse) {
    console.log(`${chalk.bold('→ Requested:')} ${chalk.green(mainNavResponse.url)} [${statusIcon(mainNavResponse.status)}]`);
    if ((mainNavResponse.status===200 || mainNavResponse.status===403) && mainNavResponse.ddCookiesDetailed?.length) {
      console.log(chalk.yellow('   🍪 DataDome Set-Cookie:'));
      for (const c of mainNavResponse.ddCookiesDetailed) {
        console.log('     - ' + formatCookieLine(c));
      }
    }
  } else {
    console.log(chalk.red('→ Requested: (no main document)'));
  }

  // 403 incidents AFTER main request (exclude only the exact main doc entry)
  const incidents403 = entries
    .filter(e =>
      e.status === 403 &&
      ALLOWED_TYPES.has(e.type) &&
      (!mainNavResponse || e !== mainNavResponse)
    )
    .sort((a,b)=> a.t0 - b.t0);

  if (incidents403.length) {
    console.log(chalk.red.bold('\n❗ HTTP 403 incidents after initial request:'));
    let idx = 1;
    for (const inc of incidents403) {
      const scope = inc.isMain ? 'Main' : 'Subrequest';
      console.log(`  ${idx++}. [${scope}] ${chalk.white(inc.type.toUpperCase())} (${chalk.blue(inc.method)}) → ${chalk.green(inc.url)} [${statusIcon(inc.status)}]`);

      if (inc.queryPretty && inc.method === 'GET') {
        console.log(chalk.gray('     ↳ Query params:'));
        for (const line of inc.queryPretty.split('\n')) console.log(chalk.gray('       ' + line));
      }
      if (inc.method === 'POST' && inc.postBodyPretty) {
        console.log(chalk.gray(`     ↳ Body (${inc.reqCT || 'unknown'}):`));
        for (const line of inc.postBodyPretty.split('\n')) console.log(chalk.gray('       ' + line));
      }
      if (inc.ddCookiesDetailed?.length) {
        console.log(chalk.yellow('     🍪 DataDome Set-Cookie:'));
        for (const c of inc.ddCookiesDetailed) console.log('       - ' + formatCookieLine(c));
      }

      // Subsequent challenge steps (Device Check / CAPTCHA/BLOCK) after this 403
      const seq = entries
        .filter(e => e.t0 >= inc.t0 && e.ddPhase)
        .sort((a,b)=> a.t0 - b.t0);

      if (seq.length) {
        console.log(chalk.cyan('     Subsequent challenge steps:'));
        let step=1;
        for (const e of seq) {
          console.log(`       ${step++}. ${chalk.magenta(e.ddPhase)} (${chalk.blue(e.method)}) → ${chalk.green(e.url)} [${statusIcon(e.status)}]`);

          if (e.method === 'GET' && e.queryPretty) {
            console.log(chalk.gray('          ↳ Query params:'));
            for (const line of e.queryPretty.split('\n')) console.log(chalk.gray('            ' + line));
          }
          if (e.method === 'POST' && e.postBodyPretty) {
            console.log(chalk.gray(`          ↳ Body (${e.reqCT || 'unknown'}):`));
            for (const line of e.postBodyPretty.split('\n')) console.log(chalk.gray('            ' + line));
          }
          if (e.ddCookiesDetailed?.length) {
            console.log(chalk.yellow('          🍪 DataDome Set-Cookie:'));
            for (const c of e.ddCookiesDetailed) console.log('            - ' + formatCookieLine(c));
          }
        }
      }
    }
  } else {
    console.log(chalk.gray('\n(No HTTP 403 incidents after initial request.)'));
  }

  // ALWAYS show all subsequent requests (Document/XHR/Fetch) after initial request
  if (mainNavResponse) {
    const subs = entries
      .filter(e => ALLOWED_TYPES.has(e.type) && !(e.isMain && e.type==='document' && e === mainNavResponse))
      .filter(e => e.t0 >= mainNavResponse.t0)  // include same-ms events
      .sort((a,b)=> a.t0 - b.t0);

    if (subs.length) {
      console.log(chalk.cyan.bold('\n🔗 Subsequent requests after initial request:'));
      let i=1;
      for (const r of subs) {
        const phase = r.ddPhase ? ` ${chalk.magenta('['+r.ddPhase+']')}` : '';
        console.log(`  ${i++}. ${chalk.white(r.type.toUpperCase())} (${chalk.blue(r.method)}) → ${chalk.green(r.url)} [${statusIcon(r.status)}]${phase}`);

        // Payload prints
        if (r.method === 'GET' && r.queryPretty) {
          console.log(chalk.gray('     ↳ Query params:'));
          for (const line of r.queryPretty.split('\n')) console.log(chalk.gray('       ' + line));
        }
        if (r.method === 'POST' && r.postBodyPretty) {
          console.log(chalk.gray(`     ↳ Body (${r.reqCT || 'unknown'}):`));
          for (const line of r.postBodyPretty.split('\n')) console.log(chalk.gray('       ' + line));
        }

        // Any DataDome cookies on these responses
        if (r.ddCookiesDetailed?.length) {
          console.log(chalk.yellow('     🍪 DataDome Set-Cookie:'));
          for (const c of r.ddCookiesDetailed) console.log('       - ' + formatCookieLine(c));
        }
      }
    } else {
      console.log(chalk.gray('\n(No subsequent Document/XHR/Fetch requests captured.)'));
    }
  }

  // Saved
  console.log(chalk.cyan.bold('\n📦 Saved:'));
  console.log(`  HAR:     ${chalk.green(harFinal)}`);
  console.log(`  Cookies: ${chalk.green(cookiesFinal)}`);
  console.log(chalk.green('\n✅ Done'));

  await browser.close().catch(()=>{});
  process.exit(0);
}

main().catch(e=>{ console.error(chalk.red('Unexpected error:'), e); process.exit(1); });