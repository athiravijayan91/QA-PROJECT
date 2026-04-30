#!/usr/bin/env node
/**
 * Route Integration — Automated QA Runner
 * Usage: node route-qa.js <site-url> [--headless]
 * Example: node route-qa.js "https://patbo.com/?preview_theme_id=164057415715"
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');

// URL and headless are set via the interactive config prompt below
let BASE_URL = process.argv[2] || '';
let HEADLESS  = false;

// ── Live Dashboard Server ──────────────────────────────────────────────────
let _sseClients = [];
let _liveServer = null;

function sseEmit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  _sseClients.forEach(res => { try { res.write(payload); } catch (_) {} });
}

function startLiveServer() {
  const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Route QA — Live</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#1d1d1f;min-height:100vh}
  header{background:#fff;border-bottom:1px solid #e2e2ea;padding:18px 32px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:10}
  header h1{font-size:18px;font-weight:700}
  header .url{font-size:13px;color:#636366;margin-top:2px}
  .counters{display:flex;gap:10px;margin-left:auto}
  .pill{padding:5px 14px;border-radius:20px;font-size:13px;font-weight:600}
  .pill.pass{background:#e8f8f0;color:#1a7a4a}
  .pill.fail{background:#ffeaea;color:#c0392b}
  .pill.warn{background:#fffbe6;color:#b07d00}
  .progress-wrap{height:4px;background:#e2e2ea}
  .progress-bar{height:4px;background:#0071e3;transition:width 0.3s ease;width:0}
  main{max-width:860px;margin:28px auto;padding:0 24px 48px}
  .section-block{background:#fff;border:1px solid #e2e2ea;border-radius:12px;margin-bottom:14px;overflow:hidden}
  .section-title{padding:12px 18px;font-size:14px;font-weight:700;background:#fafafa;border-bottom:1px solid #f0f0f5;display:flex;align-items:center;gap:8px}
  .section-title .badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:#e2e2ea;color:#636366}
  .result-row{padding:10px 18px;font-size:13px;border-top:1px solid #f5f5f7;display:flex;align-items:flex-start;gap:10px;animation:fadeIn 0.2s ease}
  @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .result-row .icon{font-size:15px;flex-shrink:0;margin-top:1px}
  .result-row .name{flex:1;font-weight:500}
  .result-row .detail{font-size:12px;color:#636366;margin-top:3px}
  .result-row.FAIL .name{color:#c0392b}
  .result-row.WARN .name{color:#b07d00}
  .result-row.PASS .name{color:#1a7a4a}
  .fix-toggle{display:inline-flex;align-items:center;gap:4px;margin-top:5px;font-size:11px;font-weight:600;color:#0071e3;cursor:pointer;border:none;background:none;padding:0;user-select:none}
  .fix-toggle:hover{text-decoration:underline}
  .fix-body{display:none;margin-top:6px;padding:10px 12px;background:#f0f6ff;border-left:3px solid #0071e3;border-radius:0 6px 6px 0;font-size:12px;color:#1d1d1f;line-height:1.6}
  .fix-body.open{display:block;animation:fadeIn 0.15s ease}
  .done-banner{text-align:center;padding:28px;background:#fff;border:1px solid #e2e2ea;border-radius:12px;margin-top:8px}
  .done-banner h2{font-size:22px;margin-bottom:8px}
  .done-banner .sub{color:#636366;font-size:14px}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid #e2e2ea;border-top-color:#0071e3;border-radius:50%;animation:spin 0.7s linear infinite;vertical-align:middle;margin-right:6px}
  @keyframes spin{to{transform:rotate(360deg)}}
  #status-bar{padding:8px 32px;font-size:12px;color:#636366;background:#fafafa;border-bottom:1px solid #e2e2ea;display:flex;align-items:center}
</style>
</head>
<body>
<header>
  <div>
    <h1>🛡️ Route QA — Live Results</h1>
    <div class="url" id="site-url">Waiting for run to start…</div>
  </div>
  <div class="counters">
    <div class="pill pass">✅ <span id="cnt-pass">0</span></div>
    <div class="pill fail">❌ <span id="cnt-fail">0</span></div>
    <div class="pill warn">⚠️ <span id="cnt-warn">0</span></div>
  </div>
</header>
<div id="status-bar"><span class="spinner"></span> Connecting…</div>
<div class="progress-wrap"><div class="progress-bar" id="prog"></div></div>
<main id="main"></main>

<script>
const TOTAL_SECTIONS = 11;
let pass=0,fail=0,warn=0;
const sections={};

const es = new EventSource('/events');
const statusBar = document.getElementById('status-bar');

es.addEventListener('start', e => {
  const d = JSON.parse(e.data);
  document.getElementById('site-url').textContent = '🌐 ' + d.url;
  statusBar.innerHTML = '<span class="spinner"></span> Running checks…';
});

es.addEventListener('section', e => {
  const d = JSON.parse(e.data);
  const block = document.createElement('div');
  block.className = 'section-block';
  block.id = 'sec-' + d.index;
  block.innerHTML = \`<div class="section-title">\${d.title} <span class="badge" id="badge-\${d.index}">running…</span></div>\`;
  document.getElementById('main').appendChild(block);
  document.getElementById('prog').style.width = ((d.index-1)/TOTAL_SECTIONS*100)+'%';
  block.scrollIntoView({behavior:'smooth',block:'end'});
  sections[d.index] = { pass:0, fail:0, warn:0 };
});

es.addEventListener('result', e => {
  const d = JSON.parse(e.data);
  const block = document.getElementById('sec-' + d.sectionIndex);
  if (!block) return;
  const icons = {PASS:'✅',FAIL:'❌',WARN:'⚠️',INFO:'ℹ️'};
  const fixId = 'fix-' + Math.random().toString(36).slice(2);
  const fixHtml = d.fix
    ? \`<button class="fix-toggle" onclick="document.getElementById('\${fixId}').classList.toggle('open');this.textContent=document.getElementById('\${fixId}').classList.contains('open')?'💡 Hide fix':'💡 How to fix'">💡 How to fix</button>
       <div class="fix-body" id="\${fixId}">\${d.fix}</div>\`
    : '';
  const row = document.createElement('div');
  row.className = 'result-row ' + d.status;
  row.innerHTML = \`<div class="icon">\${icons[d.status]||'·'}</div>
    <div><div class="name">\${d.name}</div>\${d.detail?'<div class="detail">→ '+d.detail+'</div>':''}\${fixHtml}</div>\`;
  block.appendChild(row);
  if (d.status==='PASS'){pass++;sections[d.sectionIndex].pass++}
  else if (d.status==='FAIL'){fail++;sections[d.sectionIndex].fail++}
  else if (d.status==='WARN'){warn++;sections[d.sectionIndex].warn++}
  document.getElementById('cnt-pass').textContent=pass;
  document.getElementById('cnt-fail').textContent=fail;
  document.getElementById('cnt-warn').textContent=warn;
  // update section badge
  const s=sections[d.sectionIndex];
  const badge=document.getElementById('badge-'+d.sectionIndex);
  if(badge) badge.textContent=(s.fail?'❌ '+s.fail+' fail ':'')+(s.warn?'⚠️ '+s.warn+' warn ':'')+(s.fail===0&&s.warn===0?'✅ all pass':'');
  row.scrollIntoView({behavior:'smooth',block:'end'});
});

es.addEventListener('done', e => {
  const d = JSON.parse(e.data);
  document.getElementById('prog').style.width='100%';
  statusBar.innerHTML = '✓ Run complete in ' + d.duration + 's';
  const banner = document.createElement('div');
  banner.className='done-banner';
  const emoji = d.fail===0 ? '🎉' : '⚠️';
  banner.innerHTML=\`<h2>\${emoji} \${d.fail===0?'All checks passed!':d.fail+' check(s) failed'}</h2>
    <div class="sub">✅ \${d.pass} passed &nbsp;·&nbsp; ❌ \${d.fail} failed &nbsp;·&nbsp; ⚠️ \${d.warn} warnings &nbsp;·&nbsp; \${d.duration}s</div>\`;
  document.getElementById('main').appendChild(banner);
  banner.scrollIntoView({behavior:'smooth'});
  es.close();
});

es.onerror = () => { statusBar.textContent = 'Connection lost — run may have ended.'; es.close(); };
</script>
</body>
</html>`;

  _liveServer = http.createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 1000\n\n');
      _sseClients.push(res);
      // Replay current state for late-connecting browser
      sseEmit('start', { url: BASE_URL });
      req.on('close', () => { _sseClients = _sseClients.filter(c => c !== res); });
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DASHBOARD_HTML);
    }
  });

  _liveServer.listen(3000, '127.0.0.1', () => {
    console.log('  📡  Live dashboard → http://localhost:3000\n');
    // Auto-open browser
    try {
      const { execSync } = require('child_process');
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execSync(`${openCmd} http://localhost:3000`);
    } catch (_) {}
  });
}

// ── Fix Suggestion Map ─────────────────────────────────────────────────────
// Returns a merchant-facing fix string for each known FAIL check.
function getFix(section, name) {
  const n = name.toLowerCase();
  const s = section.toLowerCase();

  // ── Script Loading ──────────────────────────────────────────────────────
  if (n.includes('site is reachable'))
    return 'The automated browser was blocked. Make sure the store is publicly accessible (password removed) or share a preview link. Then re-run without --headless.';
  if (n.includes('route script tag'))
    return 'The Route <script> tag is missing from the theme. In Shopify Admin → Online Store → Themes → Edit Code, open theme.liquid and add the Route script snippet before </body>. Then republish the theme.';
  if (n.includes('route js global'))
    return 'The Route JavaScript object is not initialising. Check that the Route script loaded without errors in the browser console (F12 → Console tab). A Content Security Policy (CSP) header may be blocking it.';

  // ── Cart Widget ─────────────────────────────────────────────────────────
  if (n.includes('widget is visible to user'))
    return 'The Route widget is in the DOM but hidden. Check for CSS rules like display:none or visibility:hidden targeting the widget. Also confirm the Route app is enabled in the Route merchant dashboard → Settings → Widget.';
  if (n.includes('widget present in cart dom'))
    return 'Route widget not found in the cart. Verify the Route app is installed and the widget snippet is included in the cart template (cart.liquid or cart-drawer.liquid). Check the Route dashboard to confirm the widget is toggled ON.';
  if (n.includes('route product text visible'))
    return 'Route line item text not detected in cart. This usually means the cart template is not rendering Route\'s product row. Confirm the Route liquid snippet is present in the cart template.';

  // ── Premium Rate ────────────────────────────────────────────────────────
  if (n.includes('premium') && (n.includes('match') || n.includes('rate')))
    return 'The displayed premium does not match the configured rate. Update the rates in Route Dashboard → Settings → Protection Rates. If rates were recently changed, clear the Shopify theme cache and hard-reload the cart page (Cmd+Shift+R).';

  // ── Coverage Limit ──────────────────────────────────────────────────────
  if (n.includes('widget hidden when cart'))
    return 'Route widget is still showing above the coverage limit. In the Route dashboard → Settings, confirm the coverage limit is set correctly. If it is correct, the widget script may be cached — republish the theme or purge the CDN cache.';

  // ── Mobile ──────────────────────────────────────────────────────────────
  if (n.includes('widget visible on mobile'))
    return 'Route widget is hidden on mobile. Check for CSS media queries that set display:none on the widget container below a certain breakpoint. The widget\'s parent container may also have overflow:hidden cutting it off.';
  if (n.includes('overflowing screen width'))
    return 'The Route widget is wider than the mobile viewport. Add max-width:100% and box-sizing:border-box to the widget\'s wrapper element in the theme CSS, or contact Route support to adjust the widget\'s responsive styles.';

  // ── BFCache ─────────────────────────────────────────────────────────────
  if (s.includes('bfcache') && n.includes('pageshow'))
    return 'The BFCache handler\'s pageshow listener is missing or not listening for persisted:true events. Paste the full Route BFCache handler script into theme.liquid just before </body> and republish the theme.';
  if (s.includes('bfcache') && n.includes('popstate'))
    return 'The BFCache handler is missing the popstate fallback. The complete handler must attach both window.addEventListener("pageshow",...) and window.addEventListener("popstate",...). Re-paste the latest handler from the Route implementation guide.';
  if (s.includes('bfcache') && n.includes('/cart/update.js'))
    return 'The BFCache handler is not using /cart/update.js to remove the Route item. Ensure the handler calls fetch("/cart/update.js", { method:"POST", body: JSON.stringify({ updates: { [key]: 0 } }) }). Using /cart/change.js or other endpoints will not work correctly.';
  if (s.includes('bfcache') && n.includes('vendor'))
    return 'The BFCache handler is detecting Route items by title/handle instead of vendor === "Route". Update the detection logic to use item.vendor === "Route" as the primary check to match the cart API response.';
  if (s.includes('bfcache') && n.includes('removed route item after back'))
    return 'The BFCache handler did not fire after back navigation. Confirm the handler script is loaded on all pages (not just the cart), that it checks e.persisted === true in the pageshow event, and that it runs location.reload() after removing the Route item.';

  // ── Digital Items ───────────────────────────────────────────────────────
  if (s.includes('digital') && n.includes('correctly absent'))
    return 'Route widget is appearing for digital / gift card items. The Route script should check requires_shipping and gift_card flags from /cart.js and hide the widget when all items are digital. Contact Route support — this may require a script update or a theme-level conditional.';

  // ── Console / Network ───────────────────────────────────────────────────
  if (n.includes('route-related js errors') || (n.includes('js errors') && s.includes('console')))
    return 'JavaScript errors are originating from the Route script. Open the browser console (F12), reproduce the error, and share the full stack trace with Route support. Common causes: conflicting Shopify apps, CSP policy blocking fetch calls, or an outdated Route script version.';
  if (n.includes('route api calls successful'))
    return 'One or more Route API network calls are failing. Check the browser Network tab (filter by "route") to see which endpoint is returning an error. Common causes: merchant API key mismatch, CORS policy, or the Route service being temporarily unavailable.';

  // ── Updates[] / Duplicates ──────────────────────────────────────────────
  if (n.includes('duplicate'))
    return 'Duplicate Route line items are appearing in the cart. This usually means the Route script is initialising more than once. Check theme.liquid for multiple Route script includes. Also verify the cart fetch/update calls aren\'t triggering a re-render loop.';

  return null; // no specific fix — don't show the accordion
}

// ── Helpers ────────────────────────────────────────────────────────────────
const results = [];
const startTime = Date.now();

function log(section, name, status, detail = '') {
  const icons = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', INFO: 'ℹ️ ' };
  results.push({ section, name, status, detail });
  const icon = icons[status] || '   ';
  // Show detail only for FAIL and WARN — keeps PASS/INFO lines clean and scannable
  const suffix = (status === 'FAIL' || status === 'WARN') && detail
    ? `\n       → ${detail.replace(/\s+/g, ' ').trim().slice(0, 120)}`
    : '';
  console.log(`    ${icon} ${name}${suffix}`);
  // Push to live dashboard (include fix suggestion for FAIL rows)
  const fix = status === 'FAIL' ? getFix(section, name) : null;
  sseEmit('result', { sectionIndex: _sectionCounter, name, status, detail: detail.slice(0, 200), fix });
}

let _sectionCounter = 0;
let _totalSections  = 11;
function sectionHeader(title) {
  _sectionCounter++;
  console.log(`\n  ${'─'.repeat(52)}`);
  console.log(`  [${_sectionCounter}/${_totalSections}]  ${title}`);
  console.log(`  ${'─'.repeat(52)}`);
  sseEmit('section', { index: _sectionCounter, title });
}

const ROUTE_SELECTORS = [
  '#route-widget', '.route-widget', '[id*="route-widget"]', '[class*="route-widget"]',
  '[data-route-widget]', '[data-route]', 'route-widget', '#route-protection',
  '.route-protection', '[class*="route-protection"]', '[id*="route"]',
];

async function findRouteWidget(page) {
  return page.evaluate((selectors) => {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return {
            found: true,
            selector: sel,
            visible: style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null,
            text: el.innerText?.slice(0, 120) || '',
            width: rect.width,
            right: rect.right,
          };
        }
      } catch (_) {}
    }
    return { found: false };
  }, ROUTE_SELECTORS);
}

async function findRouteScripts(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    return scripts.map(s => s.src).filter(s => s.toLowerCase().includes('route'));
  });
}

// Fetch the live cart state via Shopify's /cart.js and count Route line items.
// Detection mirrors the actual BFCache handler: primary = vendor === "Route",
// with title/handle regex as fallback for non-standard setups.
async function getRouteLineItemCount(page) {
  try {
    const cartData = await page.evaluate(async () => {
      const resp = await fetch('/cart.js');
      return resp.ok ? resp.json() : { items: [] };
    });
    return (cartData.items || []).filter(item =>
      item.vendor === 'Route' ||
      /route/i.test(item.title) ||
      /route/i.test(item.handle || '')
    ).length;
  } catch (_) {
    return -1; // unknown
  }
}

// Return full Route item details from cart (for vendor/key verification)
async function getRouteLineItems(page) {
  try {
    const cartData = await page.evaluate(async () => {
      const resp = await fetch('/cart.js');
      return resp.ok ? resp.json() : { items: [] };
    });
    return (cartData.items || []).filter(item =>
      item.vendor === 'Route' ||
      /route/i.test(item.title) ||
      /route/i.test(item.handle || '')
    );
  } catch (_) {
    return [];
  }
}

// Wait for the Route widget to appear in the DOM (up to `timeout` ms).
// Falls through gracefully if it never appears — the caller then logs FAIL/WARN.
async function waitForRouteWidget(page, timeout = 5000) {
  const selectors = [
    '#route-widget', '.route-widget', '[id*="route-widget"]',
    '[class*="route-widget"]', '[data-route-widget]', 'route-widget',
    '#route-protection', '[class*="route-protection"]',
  ];
  try {
    await Promise.race(
      selectors.map(sel =>
        page.waitForSelector(sel, { timeout }).catch(() => null)
      )
    );
  } catch (_) {} // widget didn't appear — that's fine, let the caller handle it
}

// Find and click an add-to-cart button on the current page
async function clickAddToCart(page) {
  const selectors = [
    'button[name="add"]',
    '[data-add-to-cart]',
    'button[id*="add-to-cart"]',
    'button[class*="add-to-cart"]',
    'input[name="add"]',
    '.btn-addtocart',
    '.add-to-cart-btn',
    'form[action*="/cart/add"] button[type="submit"]',
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      try {
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(3500); // wait for cart drawer / redirect to settle
        return true;
      } catch (_) {}
    }
  }
  return false;
}

// ── Unified Startup Prompt ──────────────────────────────────────────────────
async function promptConfig() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def = '') => new Promise(res =>
    rl.question(q, ans => res(ans.trim() || def))
  );

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           Route Integration — QA Runner                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ── 1. Site URL ────────────────────────────────────────────────────────
  if (!BASE_URL) {
    BASE_URL = await ask('  🌐  Site URL: ');
    if (!BASE_URL) { console.error('  URL required.'); rl.close(); process.exit(1); }
  } else {
    console.log(`  🌐  Site: ${BASE_URL}`);
  }

  // ── 2. Browser mode ────────────────────────────────────────────────────
  const visibleAns = await ask('  👁   Visible browser? [Y/n]: ', 'y');
  HEADLESS = visibleAns.toLowerCase() === 'n';

  // ── 3. Premium rates (one compact line each) ───────────────────────────
  console.log('\n  Premium rates — press Enter to keep defaults in [ ]\n');
  const t1Max  = parseFloat(await ask('    Lower tier max order value  [$100]  : $', '100'))   || 100;
  const t1Rate = parseFloat(await ask('    Lower tier rate             [1.95%] : ',  '1.95'))  || 1.95;
  const t2Rate = parseFloat(await ask('    Upper tier rate             [2.5%]  : ',  '2.5'))   || 2.5;
  const limit  = parseFloat(await ask('    Coverage limit              [$5000] : $', '5000'))  || 5000;

  rl.close();

  const rates = { tier1Max: t1Max, tier1Rate: t1Rate, tier2Rate: t2Rate, coverageLimit: limit };
  console.log(`\n  ✓  $0–$${t1Max} @ ${t1Rate}%  |  $${t1Max}–$${limit} @ ${t2Rate}%  |  hides above $${limit}`);
  console.log(`  ✓  Browser: ${HEADLESS ? 'headless' : 'visible'}`);
  console.log(`  ✓  Starting at ${new Date().toLocaleTimeString()}`);

  // Start live dashboard server, then emit start event once browser connects
  startLiveServer();
  await new Promise(r => setTimeout(r, 800)); // brief pause so browser can open
  sseEmit('start', { url: BASE_URL });
  console.log();
  return rates;
}

// ── Main QA Runner ─────────────────────────────────────────────────────────
async function runQA(RATES) {

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 200,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const consoleErrors = [];
  const routeNetworkCalls = [];

  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('request', req => {
    const url = req.url();
    if (/route\.com|route\.app|routeapp/i.test(url))
      routeNetworkCalls.push({ url, method: req.method(), status: null });
  });
  page.on('response', resp => {
    const url = resp.url();
    if (/route\.com|route\.app|routeapp/i.test(url)) {
      const entry = routeNetworkCalls.find(r => r.url === url);
      if (entry) entry.status = resp.status();
    }
  });

  // Navigate with fallback strategies
  async function safeGoto(url, label = '') {
    for (const waitUntil of ['domcontentloaded', 'commit']) {
      try {
        await page.goto(url, { waitUntil, timeout: 30000 });
        await page.waitForTimeout(1500);
        return true;
      } catch (e) {
        if (waitUntil === 'commit') {
          console.log(`  ⚠️  Could not load ${label || url}: ${e.message.split('\n')[0]}`);
          return false;
        }
      }
    }
    return false;
  }

  let productUrl = null;
  let addedToCart = false;
  const cartUrl = new URL('/cart', BASE_URL).href;

  try {
    // ════════════════════════════════════════════════════════
    sectionHeader('1 of 11 · Script & Network Loading');
    // ════════════════════════════════════════════════════════

    const loaded = await safeGoto(BASE_URL, 'homepage');
    if (!loaded) {
      log('Script Loading', 'Site is reachable', 'FAIL', 'Site blocked the automated browser. Run WITHOUT --headless (default) so a real Chrome window opens.');
      return;
    }
    await page.waitForTimeout(1000);

    const routeScripts = await findRouteScripts(page);
    if (routeScripts.length > 0) {
      log('Script Loading', 'Route script tag found', 'PASS', routeScripts[0]);
    } else {
      log('Script Loading', 'Route script tag found', 'FAIL', 'No <script src="...route..."> found on homepage');
    }

    const routeGlobals = await page.evaluate(() => Object.keys(window).filter(k => /route/i.test(k)));
    if (routeGlobals.length > 0) {
      log('Script Loading', 'Route JS global object present', 'PASS', `window.${routeGlobals[0]}`);
    } else {
      log('Script Loading', 'Route JS global object present', 'INFO', 'No Route global on homepage — may appear after cart load');
    }

    // ════════════════════════════════════════════════════════
    sectionHeader('2 of 11 · Finding a Product & Adding to Cart');
    // ════════════════════════════════════════════════════════

    // Find a product URL
    try {
      const links = await page.$$eval(
        'a[href*="/products/"]',
        els => [...new Set(els.map(e => e.href))].filter(h => !h.includes('/collections')).slice(0, 5)
      );
      if (links.length > 0) {
        productUrl = links[0];
        log('Add to Cart', 'Found product page link', 'PASS', productUrl);
      } else {
        log('Add to Cart', 'Found product page link', 'WARN', 'No /products/ links on homepage — trying /collections/all');
        await safeGoto(new URL('/collections/all', BASE_URL).href, 'collections');
        const collLinks = await page.$$eval('a[href*="/products/"]', els => [...new Set(els.map(e => e.href))].slice(0, 3));
        if (collLinks.length > 0) productUrl = collLinks[0];
      }
    } catch (e) {
      log('Add to Cart', 'Product discovery', 'WARN', e.message);
    }

    if (productUrl) {
      await safeGoto(productUrl, 'product page');
      addedToCart = await clickAddToCart(page);
      if (addedToCart) {
        log('Add to Cart', 'Clicked Add to Cart button', 'PASS');
      } else {
        log('Add to Cart', 'Add to Cart button found', 'WARN', 'Could not find a generic add-to-cart button — widget checks may be limited');
      }
    }

    // ════════════════════════════════════════════════════════
    sectionHeader('3 of 11 · Cart Page — Route Widget Checks');
    // ════════════════════════════════════════════════════════

    await safeGoto(cartUrl, 'cart');
    await waitForRouteWidget(page, 5000); // wait up to 5s for widget to render
    await page.waitForTimeout(500);       // small extra buffer for dynamic carts

    const desktopWidget = await findRouteWidget(page);
    if (desktopWidget.found) {
      log('Cart Widget', 'Route widget present in cart DOM', 'PASS', `Selector: "${desktopWidget.selector}"`);
      log('Cart Widget', 'Route widget is visible to user', desktopWidget.visible ? 'PASS' : 'FAIL',
        desktopWidget.visible ? 'Widget renders visibly' : 'Widget is hidden via CSS');
      if (desktopWidget.text) {
        log('Cart Widget', 'Widget text content', 'INFO', desktopWidget.text.replace(/\s+/g, ' ').trim());
      }
    } else {
      log('Cart Widget', 'Route widget present in cart DOM', addedToCart ? 'FAIL' : 'WARN',
        addedToCart ? 'Widget NOT found after adding product to cart' : 'Cart may be empty — add to cart failed, check manually');
    }

    const cartText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const hasRouteText = /route.*(protection|package|shipping)|package.*(protection)|shipping.*protection/i.test(cartText);
    log('Cart Widget', 'Route product text visible in cart', hasRouteText ? 'PASS' : 'INFO',
      hasRouteText ? 'Route-related text found in cart' : 'No Route product text detected in cart body');

    // ── Premium Rate Validation ───────────────────────────────────────────
    try {
      const cartData = await page.evaluate(async () => {
        const resp = await fetch('/cart.js');
        return resp.ok ? resp.json() : null;
      });

      if (cartData && cartData.total_price != null) {
        // total_price is in cents — exclude any Route line item itself
        const nonRouteItems = (cartData.items || []).filter(i => !/route/i.test(i.title + (i.handle || '')));

        // ── Digital item detection ───────────────────────────────────────
        const digitalItems  = nonRouteItems.filter(i => i.gift_card === true || i.requires_shipping === false);
        const physicalItems = nonRouteItems.filter(i => i.gift_card !== true && i.requires_shipping !== false);
        const isAllDigital  = nonRouteItems.length > 0 && digitalItems.length === nonRouteItems.length;
        const isMixed       = digitalItems.length > 0 && physicalItems.length > 0;

        if (isAllDigital) {
          log('Cart Widget', 'Cart is digital-only (gift cards / non-shippable items)',
            !desktopWidget.visible ? 'PASS' : 'FAIL',
            isAllDigital && !desktopWidget.visible
              ? `✓ All ${nonRouteItems.length} item(s) are digital — Route widget correctly absent`
              : `❌ Digital-only cart but Route widget is STILL showing — Route should not protect non-shippable products!`);
        } else if (isMixed) {
          log('Cart Widget', 'Cart has mixed physical + digital items', 'INFO',
            `${physicalItems.length} physical + ${digitalItems.length} digital — Route should show for physical items only`);
        }

        // ── Premium rate validation (physical items only) ────────────────
        if (isAllDigital) {
          log('Cart Widget', 'Premium check skipped — digital-only cart', 'INFO',
            'No physical items to insure — premium check not applicable');
        } else {
          const subtotal = physicalItems.reduce((sum, i) => sum + i.line_price, 0) / 100;

          const expectedRate = subtotal <= RATES.tier1Max ? RATES.tier1Rate : RATES.tier2Rate;
          const expectedPremium = subtotal * (expectedRate / 100);

          log('Cart Widget', 'Premium check: cart subtotal detected', 'INFO',
            `Physical subtotal: $${subtotal.toFixed(2)} → Expected premium: $${expectedPremium.toFixed(2)} @ ${expectedRate}%`);

          // Try to parse the premium from the widget text
          const widgetText = desktopWidget.found ? desktopWidget.text : '';
          const priceMatch = widgetText.match(/\$\s*(\d+\.\d{2})/);

          if (priceMatch) {
            const displayedPremium = parseFloat(priceMatch[1]);
            const diff = Math.abs(displayedPremium - expectedPremium);
            const isCorrect = diff <= 0.15; // allow $0.15 for rounding differences
            log('Cart Widget', 'Route premium matches expected rate',
              isCorrect ? 'PASS' : 'FAIL',
              `Expected: $${expectedPremium.toFixed(2)} (${expectedRate}% of $${subtotal.toFixed(2)})  |  Widget shows: $${displayedPremium.toFixed(2)}${!isCorrect ? `  ← ⚠️ MISMATCH — Δ$${diff.toFixed(2)}` : ' ✓'}`);
          } else if (desktopWidget.found) {
            log('Cart Widget', 'Route premium detectable in widget text', 'WARN',
              `Could not parse a price from widget text: "${widgetText.slice(0, 80).replace(/\s+/g, ' ')}"`);
          } else {
            log('Cart Widget', 'Route premium check', 'WARN', 'Widget not found — cannot validate premium');
          }
        }
      } else {
        log('Cart Widget', 'Premium rate check', 'WARN', 'Could not read /cart.js to determine subtotal');
      }
    } catch (e) {
      log('Cart Widget', 'Premium rate check', 'WARN', 'Error during premium check: ' + e.message.split('\n')[0]);
    }

    // ════════════════════════════════════════════════════════
    sectionHeader('4 of 11 · Mobile Viewport (375px)');
    // ════════════════════════════════════════════════════════

    await page.setViewportSize({ width: 375, height: 812 });
    await safeGoto(cartUrl, 'cart (mobile)');
    await waitForRouteWidget(page, 4000);
    await page.waitForTimeout(300);

    const mobileWidget = await findRouteWidget(page);
    if (mobileWidget.found) {
      log('Mobile', 'Route widget present at 375px width', 'PASS');
      log('Mobile', 'Widget visible on mobile', mobileWidget.visible ? 'PASS' : 'FAIL');
      log('Mobile', 'Widget not overflowing screen width', mobileWidget.right <= 390 ? 'PASS' : 'FAIL',
        mobileWidget.right > 390 ? `Widget extends to ${Math.round(mobileWidget.right)}px (wider than 375px viewport)` : 'Fits within viewport');
    } else {
      log('Mobile', 'Route widget present at 375px width', addedToCart ? 'FAIL' : 'WARN', 'Widget not detected at mobile width');
    }

    await page.setViewportSize({ width: 768, height: 1024 });
    await safeGoto(cartUrl, 'cart (tablet)');
    const tabletWidget = await findRouteWidget(page);
    log('Mobile', 'Route widget present at 768px (tablet)', tabletWidget.found ? 'PASS' : 'WARN');

    await page.setViewportSize({ width: 1280, height: 800 });

    // ════════════════════════════════════════════════════════
    sectionHeader('5 of 11 · Collections — Route Product Hidden');
    // ════════════════════════════════════════════════════════

    const collectionsUrl = new URL('/collections/all?sort_by=price-ascending', BASE_URL).href;
    try {
      await safeGoto(collectionsUrl, 'collections');
      await page.waitForTimeout(500);

      const routeInCollection = await page.evaluate(() => {
        const productCards = document.querySelectorAll(
          'a[href*="/products/"], [class*="product-card"], [class*="product-item"], [class*="grid-item"]'
        );
        const found = [];
        for (const card of productCards) {
          const text = card.textContent || '';
          const link = card.href || card.querySelector('a[href*="/products/"]')?.href || '';
          if (/route/i.test(text) && /(protection|package|shipping)/i.test(text)) {
            found.push({ title: text.trim().slice(0, 60), url: link });
          }
        }
        // Also check plain title elements as fallback
        if (found.length === 0) {
          const titleEls = document.querySelectorAll(
            '.product-item__title, .card__heading, .product-card__title, h3, [class*="product-title"]'
          );
          for (const el of titleEls) {
            const text = el.textContent.trim();
            if (/route/i.test(text) && /(protection|package|shipping)/i.test(text)) {
              const link = el.closest('a')?.href || el.querySelector('a')?.href || '';
              found.push({ title: text.slice(0, 60), url: link });
            }
          }
        }
        return found;
      });

      log('Collections', 'Route product NOT visible in /collections/all (price sorted)',
        routeInCollection.length === 0 ? 'PASS' : 'FAIL',
        routeInCollection.length > 0
          ? `⚠️  Route product visible in storefront collection!\n         → Product URL: ${routeInCollection[0].url || '(URL not found)'}\n         → Title: "${routeInCollection[0].title}"`
          : 'Route product not found in /collections/all — good');

      // Check product recommendation sections for Route
      const routeInRecs = await page.evaluate(() => {
        const recSections = document.querySelectorAll(
          '[class*="recommendation"], [class*="related"], [class*="suggested"], [class*="upsell"], [id*="recommendation"]'
        );
        const found = [];
        for (const sec of recSections) {
          const text = sec.textContent || '';
          if (/route/i.test(text) && /(protection|package|shipping)/i.test(text)) {
            const link = sec.querySelector('a[href*="/products/"]')?.href || '';
            found.push({ url: link });
          }
        }
        return found;
      });
      log('Collections', 'Route product NOT in recommendation sections',
        routeInRecs.length === 0 ? 'PASS' : 'FAIL',
        routeInRecs.length > 0
          ? `⚠️  Route found in a recommendation widget! URL: ${routeInRecs[0].url || '(check manually)'}`
          : 'Route not found in recommendation sections on /collections/all');
      // Also check a product page for Route in recommendations
      if (productUrl) {
        await safeGoto(productUrl, 'product page (rec check)');
        await page.waitForTimeout(1000);
        const routeInPdpRecs = await page.evaluate(() => {
          const recSections = document.querySelectorAll(
            '[class*="recommendation"], [class*="related"], [class*="suggested"], [class*="upsell"], [id*="recommendation"], [class*="recently"]'
          );
          const found = [];
          for (const sec of recSections) {
            const text = sec.textContent || '';
            if (/route/i.test(text) && /(protection|package|shipping)/i.test(text)) {
              const link = sec.querySelector('a[href*="/products/"]')?.href || '';
              found.push({ url: link });
            }
          }
          return found;
        });
        log('Collections', 'Route product NOT in PDP recommendation sections',
          routeInPdpRecs.length === 0 ? 'PASS' : 'FAIL',
          routeInPdpRecs.length > 0
            ? `⚠️  Route found in product page recommendations! URL: ${routeInPdpRecs[0].url || '(check manually)'}`
            : 'Route not appearing in product page recommendations');
      }

    } catch (e) {
      log('Collections', 'Collections page check', 'WARN', '/collections/all returned error: ' + e.message);
    }

    // ════════════════════════════════════════════════════════
    sectionHeader('6 of 11 · BFCache / Popstate Handler');
    // ════════════════════════════════════════════════════════
    // Validates the Route BFCache handler which:
    //   • Fires on: pageshow (e.persisted=true) AND popstate (+100ms delay)
    //   • Acts only when: #cart-drawer.is-open OR URL matches /cart
    //   • Detects Route item by: item.vendor === "Route"
    //   • Removes via: POST /cart/update.js  { updates: { [key]: 0 } }
    //   • Always reloads: whether or not a Route item was found

    await safeGoto(cartUrl, 'cart for BFCache handler checks');
    await page.waitForTimeout(1500);

    // ── A. Handler Script Installation ───────────────────────────────────────
    const handlerScriptCheck = await page.evaluate(() => {
      const inlineScripts = Array.from(document.querySelectorAll('script:not([src])')).map(s => s.textContent);
      return {
        hasPageshow:   inlineScripts.some(s => s.includes('pageshow') && s.includes('persisted')),
        hasPopstate:   inlineScripts.some(s => s.includes('popstate')),
        hasCartUpdate: inlineScripts.some(s => s.includes('/cart/update.js') || s.includes('cart/update')),
        hasVendorCheck:inlineScripts.some(s => s.includes('vendor') && s.includes('Route')),
      };
    });

    log('BFCache', 'Handler: pageshow + persisted listener installed',
      handlerScriptCheck.hasPageshow ? 'PASS' : 'FAIL',
      handlerScriptCheck.hasPageshow
        ? 'Inline script found with pageshow + e.persisted check ✓'
        : '❌ No pageshow/persisted handler found — BFCache restore will NOT clean up Route item!');

    log('BFCache', 'Handler: popstate fallback listener installed',
      handlerScriptCheck.hasPopstate ? 'PASS' : 'WARN',
      handlerScriptCheck.hasPopstate
        ? 'popstate listener present — covers browsers that don\'t fire persisted ✓'
        : 'No popstate handler — back navigation may not trigger cleanup on some browsers');

    log('BFCache', 'Handler: uses /cart/update.js to remove Route item',
      handlerScriptCheck.hasCartUpdate ? 'PASS' : 'WARN',
      handlerScriptCheck.hasCartUpdate
        ? '/cart/update.js call found in handler ✓'
        : 'Could not confirm /cart/update.js usage — handler may use a different removal method');

    log('BFCache', 'Handler: detects Route item by vendor === "Route"',
      handlerScriptCheck.hasVendorCheck ? 'PASS' : 'WARN',
      handlerScriptCheck.hasVendorCheck
        ? 'vendor:"Route" check found in handler ✓'
        : 'vendor check not detected — Route item may not be found/removed correctly');

    // ── B. Drawer Selector Validation ────────────────────────────────────────
    // Handler checks: document.querySelectorAll('#cart-drawer.is-open')
    // If the merchant's drawer uses a different ID, the drawer-open path never fires.
    const drawerCheck = await page.evaluate(() => {
      const byId   = !!document.querySelector('#cart-drawer');
      // Look for any drawer-like element so we can warn if it has a different ID
      const anyDrawer = document.querySelector('[id*="cart-drawer"], [class*="cart-drawer"], [id*="cart_drawer"]');
      return {
        hasCartDrawerId: byId,
        actualDrawerId:  anyDrawer ? (anyDrawer.id || anyDrawer.className.split(' ')[0]) : null,
      };
    });

    log('BFCache', 'Drawer selector: #cart-drawer exists in DOM',
      drawerCheck.hasCartDrawerId ? 'PASS' : 'WARN',
      drawerCheck.hasCartDrawerId
        ? '#cart-drawer found — handler will correctly detect open drawer state ✓'
        : drawerCheck.actualDrawerId
          ? `#cart-drawer NOT found but found "${drawerCheck.actualDrawerId}" — handler\'s drawer trigger won\'t fire on this merchant\'s drawer!`
          : 'No cart drawer element found — handler drawer-open path will never trigger (cart page path still works)');

    // ── C. Route Vendor Field Verification ───────────────────────────────────
    // The handler uses item.vendor === "Route" — verify this matches live cart data
    const routeItemsForVendor = await getRouteLineItems(page);
    if (routeItemsForVendor.length > 0) {
      const allVendorMatch = routeItemsForVendor.every(i => i.vendor === 'Route');
      log('BFCache', 'Route line item vendor field is "Route"',
        allVendorMatch ? 'PASS' : 'FAIL',
        allVendorMatch
          ? `vendor === "Route" confirmed on all ${routeItemsForVendor.length} Route item(s) ✓`
          : `⚠️ Route item vendor is "${routeItemsForVendor[0].vendor}" — handler will NOT find this item and Route will persist in cart after back navigation!`);

      const keyPresent = routeItemsForVendor.every(i => !!i.key);
      log('BFCache', 'Route item has a cart key (needed for update.js removal)',
        keyPresent ? 'PASS' : 'FAIL',
        keyPresent
          ? `item.key present: "${routeItemsForVendor[0].key}" — /cart/update.js removal will work ✓`
          : '❌ Route item missing a cart key — handler cannot construct the updates payload');
    } else {
      log('BFCache', 'Route vendor field check', 'WARN',
        'No Route item in cart right now — vendor field will be verified during the flow test below');
    }

    // ── D. BFCache Flow: checkout → back → verify cleanup ────────────────────
    if (addedToCart) {
      await safeGoto(cartUrl, 'cart (BFCache flow)');
      await page.waitForTimeout(1000);

      const routeCountBefore = await getRouteLineItemCount(page);
      log('BFCache', 'Route line item present in cart before checkout',
        routeCountBefore > 0 ? 'PASS' : 'WARN',
        routeCountBefore > 0
          ? `${routeCountBefore} Route item(s) confirmed via /cart.js (vendor check + title fallback)`
          : 'No Route line item — BFCache flow result may be inconclusive');

      const checkoutSelectors = [
        '[data-route-checkout]', '[id*="route-checkout"]', '[class*="route-checkout"]',
        'button[name="checkout"]', 'input[name="checkout"]', '[name="checkout"]',
        'a[href*="/checkout"]', '.checkout-button', 'button[class*="checkout"]',
      ];
      let checkoutBtn = null, usedSel = '';
      for (const sel of checkoutSelectors) {
        checkoutBtn = await page.$(sel);
        if (checkoutBtn) { usedSel = sel; break; }
      }

      if (checkoutBtn) {
        log('BFCache', 'Checkout button found', 'INFO', `Selector: "${usedSel}"`);
        try {
          await checkoutBtn.scrollIntoViewIfNeeded();
          await checkoutBtn.click();
          await page.waitForTimeout(3000);

          const onCheckout = /checkout|checkouts/.test(page.url());
          if (onCheckout) {
            log('BFCache', 'Navigated to checkout page', 'PASS', page.url().slice(0, 80));

            // Go back — handler should fire via pageshow (persisted=true) or popstate
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            // Wait for handler's reload cycle to complete (handler fires immediately on pageshow)
            await page.waitForTimeout(5000);

            const routeAfterBack = await getRouteLineItemCount(page);
            log('BFCache', 'Handler removed Route item after back navigation (pageshow/popstate path)',
              routeAfterBack === 0 ? 'PASS' : 'FAIL',
              routeAfterBack === 0
                ? '✓ Route item correctly removed — handler fired and cleaned up the cart'
                : `❌ Route item still in cart (${routeAfterBack}) after 5s — handler did not fire or failed to remove item`);

            // ── E. Page Reload Behavior ────────────────────────────────────
            // Handler always calls window.location.reload() — even if no Route item.
            // Check: after reload, Route should NOT reappear from BFCache state.
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

            const routeAtReload = await getRouteLineItemCount(page);
            await page.waitForTimeout(3000);
            const routeAfterWait = await getRouteLineItemCount(page);

            const bfcacheFlicker = routeAtReload > 0 && routeAfterWait === 0;
            const allClear       = routeAtReload === 0 && routeAfterWait === 0;

            log('BFCache', 'No BFCache state restore after page reload',
              allClear ? 'PASS' : bfcacheFlicker ? 'FAIL' : 'WARN',
              bfcacheFlicker
                ? `❌ Route appeared on reload (${routeAtReload} item) then was removed — BFCache state restored stale cart!`
                : allClear
                  ? '✓ Cart clean on reload — no stale BFCache state'
                  : `Reload count: ${routeAtReload} → after 3s: ${routeAfterWait} — verify manually`);

          } else {
            log('BFCache', 'Checkout navigation', 'WARN', 'Could not confirm checkout redirect — URL: ' + page.url());
          }
        } catch (e) {
          log('BFCache', 'BFCache flow test', 'WARN', 'Could not complete flow: ' + e.message.split('\n')[0]);
        }
      } else {
        log('BFCache', 'Checkout button found', 'WARN', 'No checkout button — skipping flow test');
      }

      // ── F. Popstate Path: product page → back → cart (not checkout) ──────
      // Handler also fires on popstate (not just pageshow), with a 100ms delay.
      // Test: navigate away from cart, go back, check cleanup fires.
      try {
        await safeGoto(cartUrl, 'cart (popstate test setup)');
        await page.waitForTimeout(1000);
        // Add Route item back if it was cleaned up
        if (productUrl) {
          const countBeforePopstate = await getRouteLineItemCount(page);
          if (countBeforePopstate === 0) {
            await safeGoto(productUrl, 'product (popstate re-add)');
            await clickAddToCart(page);
            await safeGoto(cartUrl, 'cart (after re-add)');
            await page.waitForTimeout(1000);
          }
        }

        // Navigate forward to homepage, then go back — triggers popstate on cart page
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(500);
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        // Handler has a 100ms delay for popstate — give it time to fire + reload
        await page.waitForTimeout(4000);

        const onCartAfterPopstate = /\/cart/.test(page.url());
        if (onCartAfterPopstate) {
          const routeAfterPopstate = await getRouteLineItemCount(page);
          log('BFCache', 'Handler fired on popstate (back from non-checkout page)',
            routeAfterPopstate === 0 ? 'PASS' : 'WARN',
            routeAfterPopstate === 0
              ? '✓ popstate path also cleaned up Route item correctly'
              : `Route still present (${routeAfterPopstate}) after popstate — handler may only trigger on checkout→back path. Verify manually.`);
        } else {
          log('BFCache', 'Popstate path test', 'WARN', 'Could not return to cart page via back navigation for popstate test');
        }
      } catch (e) {
        log('BFCache', 'Popstate path test', 'WARN', 'Could not complete: ' + e.message.split('\n')[0]);
      }

    } else {
      log('BFCache', 'BFCache flow test (D–F)', 'WARN', 'Skipped — could not add a product to cart automatically');
    }

    // ════════════════════════════════════════════════════════
    sectionHeader('7 of 11 · Updates[] — Duplicate Route Products');
    // ════════════════════════════════════════════════════════
    // Add qty=3 of a single product → check that only 1 Route item exists in cart & checkout

    if (productUrl) {
      await safeGoto(productUrl, 'product page (qty test)');
      await page.waitForTimeout(1000);

      // Try to set quantity to 3 via input field
      let qtySet = false;
      const qtyInputSelectors = [
        'input[name="quantity"]',
        'input[id*="quantity"]',
        'input[class*="quantity"]',
        '.quantity__input',
        '[data-quantity-input]',
        '[aria-label*="quantity" i]',
      ];

      for (const sel of qtyInputSelectors) {
        const qtyInput = await page.$(sel);
        if (qtyInput) {
          try {
            await qtyInput.scrollIntoViewIfNeeded();
            await qtyInput.click({ clickCount: 3 });
            await qtyInput.fill('3');
            await qtyInput.press('Tab');
            await page.waitForTimeout(500);
            qtySet = true;
            log('Updates[] Check', 'Set product quantity to 3 via input', 'PASS');
            break;
          } catch (_) {}
        }
      }

      // If no input, try clicking the + increment button twice
      if (!qtySet) {
        const plusSelectors = [
          '[data-quantity-plus]',
          'button[aria-label*="ncrease" i]',
          'button[aria-label*="plus" i]',
          '.quantity__button + .quantity__button',
          '[class*="quantity"] button:last-child',
          '[class*="qty"] button:last-child',
        ];
        for (const sel of plusSelectors) {
          const plusBtn = await page.$(sel);
          if (plusBtn) {
            try {
              await plusBtn.click(); await page.waitForTimeout(300);
              await plusBtn.click(); await page.waitForTimeout(300);
              qtySet = true;
              log('Updates[] Check', 'Increased quantity to 3 via + button', 'PASS');
              break;
            } catch (_) {}
          }
        }
      }

      if (!qtySet) {
        log('Updates[] Check', 'Set quantity to 3', 'WARN', 'Could not find a quantity control — adding at qty 1 and checking for duplicates');
      }

      // Add to cart with qty=3
      const addedQty = await clickAddToCart(page);
      if (addedQty) {
        log('Updates[] Check', 'Added product (qty 3) to cart', 'PASS');
      } else {
        log('Updates[] Check', 'Add to cart for qty test', 'WARN', 'Could not add product');
      }

      // Check cart via /cart.js for duplicate Route items
      await safeGoto(cartUrl, 'cart (qty check)');
      await page.waitForTimeout(1500);

      const routeCountInCart = await getRouteLineItemCount(page);
      if (routeCountInCart >= 0) {
        log('Updates[] Check', 'Only 1 Route line item in cart with qty=3 product (no duplicates)',
          routeCountInCart === 1 ? 'PASS' : routeCountInCart === 0 ? 'WARN' : 'FAIL',
          routeCountInCart > 1
            ? `❌ ${routeCountInCart} Route items found in cart — duplicate Route products (Updates[] issue)!`
            : routeCountInCart === 1
              ? '1 Route line item — correct, no duplicates'
              : 'No Route line items found in cart — check manually');
      } else {
        log('Updates[] Check', 'Route line item count check', 'WARN', 'Could not read /cart.js');
      }

      // Now go to checkout and verify no duplicates there either
      const checkoutSelectors = [
        'button[name="checkout"]', 'input[name="checkout"]', '[name="checkout"]',
        'a[href*="/checkout"]', '.checkout-button', 'button[class*="checkout"]',
      ];
      let checkoutBtn2 = null;
      for (const sel of checkoutSelectors) {
        checkoutBtn2 = await page.$(sel);
        if (checkoutBtn2) break;
      }

      if (checkoutBtn2) {
        try {
          await checkoutBtn2.scrollIntoViewIfNeeded();
          await checkoutBtn2.click();
          await page.waitForTimeout(3000);

          const onCheckout = /checkout|checkouts/.test(page.url());
          if (onCheckout) {
            // Count Route line items visible in the checkout page DOM
            const routeOnCheckout = await page.evaluate(() => {
              const allText = Array.from(document.querySelectorAll('[class*="product"], [class*="line-item"], [class*="order-summary"] *'))
                .map(el => el.textContent.trim())
                .filter(t => /route/i.test(t) && /(protection|package)/i.test(t));
              // Deduplicate and count distinct Route product rows
              return [...new Set(allText)].length;
            });

            log('Updates[] Check', 'No duplicate Route items on Checkout page',
              routeOnCheckout <= 1 ? 'PASS' : 'FAIL',
              routeOnCheckout > 1
                ? `❌ ${routeOnCheckout} Route-related entries on checkout page — possible duplicate!`
                : 'Checkout page shows at most 1 Route item ✓');

            // Go back to cart for next tests
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(1000);
          } else {
            log('Updates[] Check', 'Checkout page check', 'WARN', 'Could not navigate to checkout for final duplicate check');
          }
        } catch (e) {
          log('Updates[] Check', 'Checkout duplicate check', 'WARN', e.message.split('\n')[0]);
        }
      } else {
        log('Updates[] Check', 'Checkout duplicate check', 'WARN', 'No checkout button found — skipping checkout duplicate check');
      }
    } else {
      log('Updates[] Check', 'Updates[] / Duplicate Route products test', 'WARN', 'Skipped — no product URL found');
    }

    // ════════════════════════════════════════════════════════
    sectionHeader('8 of 11 · Console Errors');
    // ════════════════════════════════════════════════════════

    const routeConsoleErrors = consoleErrors.filter(m => /route/i.test(m));
    const allErrors = consoleErrors.length;

    log('Console', 'No Route-related JS errors', routeConsoleErrors.length === 0 ? 'PASS' : 'FAIL',
      routeConsoleErrors.length > 0 ? routeConsoleErrors.slice(0, 3).join(' | ') : 'Clean');
    log('Console', `Total JS errors on page (${allErrors})`, allErrors === 0 ? 'PASS' : allErrors < 5 ? 'WARN' : 'FAIL',
      allErrors > 0 ? `${allErrors} error(s) — may or may not be Route-related` : 'No errors');

    // ════════════════════════════════════════════════════════
    sectionHeader('9 of 11 · Network Requests to Route');
    // ════════════════════════════════════════════════════════

    if (routeNetworkCalls.length > 0) {
      const failed = routeNetworkCalls.filter(r => r.status && r.status >= 400);
      log('Network', `Route API calls detected (${routeNetworkCalls.length} total)`, 'PASS',
        routeNetworkCalls.slice(0, 2).map(r => `[${r.status || '?'}] ${r.url.slice(0, 80)}`).join('\n         → '));
      log('Network', 'All Route API calls successful', failed.length === 0 ? 'PASS' : 'FAIL',
        failed.length > 0 ? failed.map(r => `[${r.status}] ${r.url.slice(0, 80)}`).join(' | ') : `${routeNetworkCalls.length} calls, all OK`);
    } else {
      log('Network', 'Route API calls detected', 'WARN', 'No calls to route.com observed — script may not have loaded or triggered');
    }

    // ════════════════════════════════════════════════════════
    sectionHeader('10 of 11 · Coverage Limit — Widget Hides Above $' + RATES.coverageLimit);
    // ════════════════════════════════════════════════════════
    // Goal: push cart total above the coverage limit and verify the Route widget disappears

    if (productUrl) {
      // First read the product price from /cart.js to calculate required qty
      await safeGoto(cartUrl, 'cart (coverage-limit setup)');
      await page.waitForTimeout(1000);

      const cartForLimit = await page.evaluate(async () => {
        const resp = await fetch('/cart.js');
        return resp.ok ? resp.json() : null;
      });

      if (cartForLimit) {
        const nonRouteItems = (cartForLimit.items || []).filter(i => !/route/i.test(i.title + (i.handle || '')));
        const currentSubtotal = nonRouteItems.reduce((sum, i) => sum + i.line_price, 0) / 100;
        const unitPrice = nonRouteItems[0] ? nonRouteItems[0].price / 100 : 0;
        const currentQty = nonRouteItems[0] ? nonRouteItems[0].quantity : 0;

        if (currentSubtotal >= RATES.coverageLimit) {
          // Already over the limit — just check if widget is hidden
          const widgetAtLimit = await findRouteWidget(page);
          log('Coverage Limit', `Widget hidden when cart > $${RATES.coverageLimit}`,
            !widgetAtLimit.visible ? 'PASS' : 'FAIL',
            `Cart subtotal: $${currentSubtotal.toFixed(2)} — widget is ${widgetAtLimit.visible ? 'STILL VISIBLE ← bug!' : 'correctly hidden ✓'}`);

        } else if (unitPrice > 0) {
          const qtyNeeded = Math.ceil(RATES.coverageLimit / unitPrice) + 1;
          const qtyToAdd = qtyNeeded - currentQty;

          log('Coverage Limit', 'Calculating qty needed to exceed coverage limit', 'INFO',
            `Unit price: $${unitPrice.toFixed(2)} | Current qty: ${currentQty} | Need qty: ${qtyNeeded} (+${qtyToAdd} more)`);

          if (qtyToAdd > 0 && qtyToAdd <= 300) {
            // Navigate to product and set qty to the needed total
            await safeGoto(productUrl, 'product page (coverage limit)');
            await page.waitForTimeout(1000);

            let qtySet = false;
            for (const sel of ['input[name="quantity"]', 'input[id*="quantity"]', 'input[class*="quantity"]', '.quantity__input']) {
              const inp = await page.$(sel);
              if (inp) {
                try {
                  await inp.scrollIntoViewIfNeeded();
                  await inp.click({ clickCount: 3 });
                  await inp.fill(String(qtyToAdd));
                  await inp.press('Tab');
                  await page.waitForTimeout(400);
                  qtySet = true;
                  break;
                } catch (_) {}
              }
            }

            const addedForLimit = await clickAddToCart(page);
            if (addedForLimit) {
              await safeGoto(cartUrl, 'cart (after coverage limit add)');
              await waitForRouteWidget(page, 4000);
              await page.waitForTimeout(500);

              const cartAfterLimit = await page.evaluate(async () => {
                const resp = await fetch('/cart.js');
                return resp.ok ? resp.json() : null;
              });
              const newNonRoute = (cartAfterLimit?.items || []).filter(i => !/route/i.test(i.title + (i.handle || '')));
              const newSubtotal = newNonRoute.reduce((sum, i) => sum + i.line_price, 0) / 100;

              if (newSubtotal >= RATES.coverageLimit) {
                const widgetAtLimit = await findRouteWidget(page);
                log('Coverage Limit', `Widget hidden when cart subtotal > $${RATES.coverageLimit}`,
                  !widgetAtLimit.visible ? 'PASS' : 'FAIL',
                  `Cart subtotal: $${newSubtotal.toFixed(2)} (above $${RATES.coverageLimit}) — widget ${widgetAtLimit.visible ? 'is STILL VISIBLE ← bug!' : 'correctly hidden ✓'}`);
              } else {
                log('Coverage Limit', 'Coverage limit test', 'WARN',
                  `Couldn't push cart above $${RATES.coverageLimit} (reached $${newSubtotal.toFixed(2)}). Test manually by adding more items.`);
              }
            } else {
              log('Coverage Limit', 'Coverage limit test', 'WARN',
                `Could not add extra qty to cart. Verify manually that widget hides above $${RATES.coverageLimit}.`);
            }
          } else {
            log('Coverage Limit', 'Coverage limit test', 'WARN',
              `Product price $${unitPrice.toFixed(2)} would need qty ${qtyNeeded} to exceed $${RATES.coverageLimit} — too many to add automatically. Test manually.`);
          }
        } else {
          log('Coverage Limit', 'Coverage limit test', 'WARN', 'No non-Route items in cart to calculate unit price. Test manually.');
        }
      } else {
        log('Coverage Limit', 'Coverage limit test', 'WARN', 'Could not read cart data for coverage limit check.');
      }
    } else {
      log('Coverage Limit', 'Coverage limit test', 'WARN', 'Skipped — no product URL found.');
    }

    // ════════════════════════════════════════════════════════
    sectionHeader('11 of 11 · Digital Items — Gift Cards & Non-Shippable Products');
    // ════════════════════════════════════════════════════════
    // Route should NOT show a widget when cart contains only digital / non-shippable items.

    let giftCardVariantId = null;
    let giftCardTitle     = '';

    // 1. Try /products.json to find any gift_card type product
    try {
      const gcSearchUrls = [
        '/products.json?product_type=gift+card&limit=5',
        '/products.json?product_type=Gift+Card&limit=5',
        '/products.json?q=gift+card&limit=10',
      ];
      for (const path of gcSearchUrls) {
        const gcData = await page.evaluate(async (p) => {
          const resp = await fetch(p);
          return resp.ok ? resp.json() : null;
        }, path);
        const gcProduct = (gcData?.products || []).find(p => p.variants?.some(v => v.requires_shipping === false) || /gift.?card/i.test(p.product_type + ' ' + p.title));
        if (gcProduct) {
          giftCardVariantId = gcProduct.variants[0]?.id;
          giftCardTitle     = gcProduct.title;
          break;
        }
      }
    } catch (_) {}

    // 2. Fallback: try known Shopify gift-card slug directly
    if (!giftCardVariantId) {
      const gcSlugs = ['/products/gift-card', '/products/gift_card', '/products/e-gift-card', '/products/digital-gift-card', '/products/egift-card'];
      for (const slug of gcSlugs) {
        const loaded = await safeGoto(new URL(slug, BASE_URL).href, 'gift card page');
        if (loaded && !page.url().includes('/404') && !page.url().includes('collections')) {
          const vid = await page.evaluate(() => {
            const el = document.querySelector('[name="id"], [data-variant-id], input[type="hidden"][name="id"]');
            return el ? el.value || el.dataset.variantId : null;
          });
          if (vid) {
            giftCardVariantId = vid;
            giftCardTitle = await page.evaluate(() => document.querySelector('h1')?.innerText || 'Gift Card');
            break;
          }
        }
      }
    }

    if (giftCardVariantId) {
      log('Digital Items', 'Gift card / digital product found on site', 'INFO', `"${giftCardTitle}" (variant ${giftCardVariantId})`);

      // Clear cart and add ONLY the gift card
      await page.evaluate(async () => {
        await fetch('/cart/clear.js', { method: 'POST' });
      });
      await page.waitForTimeout(500);
      await page.evaluate(async (vid) => {
        await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(vid), quantity: 1 }),
        });
      }, String(giftCardVariantId));
      await page.waitForTimeout(500);

      await safeGoto(cartUrl, 'cart (gift card only)');
      await waitForRouteWidget(page, 4000); // wait to see if widget appears (it shouldn't)
      await page.waitForTimeout(500);

      // Verify what's in the cart
      const gcCartData = await page.evaluate(async () => {
        const resp = await fetch('/cart.js');
        return resp.ok ? resp.json() : null;
      });

      const gcItems       = (gcCartData?.items || []).filter(i => !/route/i.test(i.title + (i.handle || '')));
      const isDigitalCart = gcItems.length > 0 && gcItems.every(i => i.gift_card === true || i.requires_shipping === false);

      if (isDigitalCart) {
        log('Digital Items', 'Cart contains only digital/gift-card items', 'INFO',
          gcItems.map(i => `"${i.title}" — gift_card:${i.gift_card}, requires_shipping:${i.requires_shipping}`).join('; '));

        const gcWidget = await findRouteWidget(page);
        log('Digital Items', 'Route widget correctly absent for digital-only cart',
          !gcWidget.visible ? 'PASS' : 'FAIL',
          !gcWidget.visible
            ? '✓ Widget hidden — Route correctly does not protect digital/non-shippable items'
            : '❌ Route widget is VISIBLE on a digital-only cart — Route should not show for non-shippable products!');
      } else {
        log('Digital Items', 'Gift card item classification check', 'WARN',
          gcItems.length > 0
            ? `Item "${gcItems[0]?.title}" has requires_shipping:${gcItems[0]?.requires_shipping}, gift_card:${gcItems[0]?.gift_card} — may be treated as physical`
            : 'Cart appears empty after adding gift card — Shopify may require special gift card handling');
        log('Digital Items', 'Verify manually', 'WARN', 'Add a gift card to the cart and confirm Route widget does not appear');
      }

      // Restore cart with a physical product so later sections still work
      await page.evaluate(async () => { await fetch('/cart/clear.js', { method: 'POST' }); });
      if (productUrl) {
        await safeGoto(productUrl, 'product (restore after digital test)');
        await page.waitForTimeout(500);
        await clickAddToCart(page);
        log('Digital Items', 'Cart restored with physical product for any remaining checks', 'INFO');
      }

    } else {
      log('Digital Items', 'Gift card / digital product found on site', 'WARN',
        'No gift card or digital product found automatically on this store.');
      log('Digital Items', 'Manual verification needed', 'WARN',
        'Add a gift card or non-shippable product to the cart and confirm: (1) Route widget does NOT appear, (2) Route is not added as a line item.');
    }

  } catch (err) {
    console.error('\n❌  Fatal error during QA run:', err.message);
    log('Fatal', 'QA run completed without errors', 'FAIL', err.message);
  } finally {
    await browser.close();
    await generateReport(results, BASE_URL);
  }
}

// ── Report Generator ───────────────────────────────────────────────────────
async function generateReport(results, siteUrl) {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const info = results.filter(r => r.status === 'INFO').length;
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  const sections = {};
  results.forEach(r => {
    if (!sections[r.section]) sections[r.section] = [];
    sections[r.section].push(r);
  });

  const statusIcon  = { PASS: '✅', FAIL: '❌', WARN: '⚠️', INFO: 'ℹ️' };
  const statusColor = { PASS: '#00c851', FAIL: '#ff3b30', WARN: '#ff9500', INFO: '#636366' };

  const sectionHTML = Object.entries(sections).map(([sec, items]) => {
    const sFail = items.filter(i => i.status === 'FAIL').length;
    const sWarn = items.filter(i => i.status === 'WARN').length;
    const sPass = items.filter(i => i.status === 'PASS').length;
    const badgeColor = sFail > 0 ? '#ff3b30' : sWarn > 0 ? '#ff9500' : '#00c851';

    const rowsHTML = items.map(item => `
      <tr>
        <td style="padding:10px 14px;font-size:13px;color:${statusColor[item.status]};font-weight:600;white-space:nowrap">${statusIcon[item.status]} ${item.status}</td>
        <td style="padding:10px 14px;font-size:13px;font-weight:500">${item.name}</td>
        <td style="padding:10px 14px;font-size:12px;color:#636366">${item.detail || '—'}</td>
      </tr>
    `).join('');

    return `
      <div style="background:#fff;border-radius:12px;border:1px solid #e2e2ea;margin-bottom:16px;overflow:hidden">
        <div style="padding:14px 18px;background:#fafafe;border-bottom:1px solid #e2e2ea;display:flex;align-items:center;justify-content:space-between">
          <strong style="font-size:14px">${sec}</strong>
          <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;background:${badgeColor}20;color:${badgeColor}">
            ${sPass}✓ ${sFail > 0 ? sFail + '✗ ' : ''}${sWarn > 0 ? sWarn + '⚠️' : ''}
          </span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <colgroup><col style="width:90px"><col style="width:45%"><col></colgroup>
          ${rowsHTML}
        </table>
      </div>
    `;
  }).join('');

  const overallStatus = fail > 0 ? 'ISSUES FOUND' : warn > 0 ? 'WARNINGS' : 'ALL CLEAR';
  const overallColor  = fail > 0 ? '#ff3b30' : warn > 0 ? '#ff9500' : '#00c851';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Route Automated QA Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f2f2f7; margin: 0; color: #1c1c1e; }
    table tr:nth-child(even) { background: #fafafe; }
    @media print { body { background: white; } }
  </style>
</head>
<body>
  <div style="background:#0f1117;color:#fff;padding:0">
    <div style="max-width:900px;margin:0 auto;padding:28px 24px 22px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
        <div style="width:40px;height:40px;background:#00c851;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:20px">R</div>
        <div>
          <div style="font-size:20px;font-weight:800">Route Automated QA Report</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.45);margin-top:2px">${new Date().toLocaleString()} · ${duration}s · ${siteUrl}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px">
        ${[['Overall', overallStatus, overallColor], ['✅ Passed', pass, '#00c851'], ['❌ Failed', fail, '#ff3b30'], ['⚠️ Warnings', warn, '#ff9500'], ['ℹ️ Info', info, '#636366']]
          .map(([l, v, c]) => `<div style="background:rgba(255,255,255,0.07);border-radius:10px;padding:12px;text-align:center"><div style="font-size:22px;font-weight:800;color:${c}">${v}</div><div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:2px">${l}</div></div>`).join('')}
      </div>
    </div>
  </div>

  ${fail > 0 ? `
  <div style="max-width:900px;margin:20px auto 0;padding:0 24px">
    <div style="background:#ffeaea;border:1px solid #ffcccc;border-radius:12px;padding:16px 18px">
      <div style="font-weight:700;color:#c0392b;margin-bottom:8px;font-size:14px">❌ Failed Checks (${fail})</div>
      ${results.filter(r => r.status === 'FAIL').map(r => {
        const fix = getFix(r.section, r.name);
        return `<div style="font-size:13px;color:#c0392b;margin-bottom:8px">
          • <strong>${r.section}:</strong> ${r.name}${r.detail ? ' — ' + r.detail : ''}
          ${fix ? `<div style="margin-top:4px;margin-left:10px;padding:8px 10px;background:#fff0f0;border-left:3px solid #c0392b;border-radius:0 4px 4px 0;font-size:12px;color:#333">💡 <strong>Fix:</strong> ${fix}</div>` : ''}
        </div>`;
      }).join('')}
    </div>
  </div>` : ''}

  <div style="max-width:900px;margin:20px auto;padding:0 24px 48px">
    <h2 style="font-size:15px;font-weight:700;margin-bottom:14px">Detailed Results</h2>
    ${sectionHTML}
    <div style="background:#fff;border:1px solid #e2e2ea;border-radius:10px;padding:14px 18px;margin-top:8px;font-size:12px;color:#636366">
      <strong>Legend: </strong>
      ✅ Pass — working correctly &nbsp;|&nbsp;
      ❌ Fail — issue found, needs fixing &nbsp;|&nbsp;
      ⚠️ Warn — could not auto-verify, check manually &nbsp;|&nbsp;
      ℹ️ Info — informational only
    </div>
    <div style="background:#fffbeb;border:1px solid #ffe58f;border-radius:10px;padding:14px 18px;margin-top:12px;font-size:13px">
      <strong>⚠️ Still requires manual checking:</strong> Hover styling, visual alignment/text wrapping, opt-in/out toggle flow, T&amp;C checkbox scenarios, Shopify Plus checkout widget, and drawer cart modal depth.
      Use the <strong>Route QA Checklist</strong> for those items.
    </div>
  </div>
</body>
</html>`;

  const reportPath = path.join(__dirname, 'route-qa-report.html');
  fs.writeFileSync(reportPath, html);

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  Done in ${duration}s  ·  ✅ ${pass} passed  ❌ ${fail} failed  ⚠️  ${warn} warnings   ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n  📋 Report → ${reportPath}\n`);

  // Send done event to live dashboard, then shut down server after clients receive it
  sseEmit('done', { pass, fail, warn, duration });
  await new Promise(r => setTimeout(r, 2000));
  if (_liveServer) _liveServer.close();
}

promptConfig()
  .then(rates => runQA(rates))
  .catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
