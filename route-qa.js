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
let _sseBuffer  = []; // replay buffer for late-connecting clients

function sseEmit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  _sseBuffer.push(payload); // buffer every event
  _sseClients.forEach(res => { try { res.write(payload); } catch (_) {} });
}

// Position windows side by side:
// - Chrome window showing localhost:3000  → RIGHT half  {960, 0, 1920, 1080}
// - Any other Chrome window (Playwright)  → LEFT half   {0, 0, 960, 1080}
// Uses URL-based detection so it works regardless of which window is "front".
// Window positioning removed — Playwright opens naturally without disrupting your workspace

function startLiveServer() {
  let _uiStartResolve = null;
  const uiStartPromise = new Promise(resolve => { _uiStartResolve = resolve; });

  _liveServer = http.createServer((req, res) => {
    // CORS for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // SSE stream
    if (req.url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('retry: 1000\n\n');
      // Replay all buffered events so late-connecting clients catch up
      _sseBuffer.forEach(payload => { try { res.write(payload); } catch(_) {} });
      _sseClients.push(res);
      req.on('close', () => { _sseClients = _sseClients.filter(c => c !== res); });
      return;
    }

    // Config submission from UI
    if (req.url === '/start' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const config = JSON.parse(body);
          BASE_URL   = config.url || BASE_URL;
          HEADLESS   = config.headless || false;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          if (_uiStartResolve) { _uiStartResolve(config); _uiStartResolve = null; }
        } catch (e) {
          res.writeHead(400); res.end('Bad JSON');
        }
      });
      return;
    }

    // Status endpoint
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true }));
      return;
    }

    // Serve checklist UI (main page)
    const checklistPath = path.join(__dirname, 'route-qa-checklist-v2.html');
    if (fs.existsSync(checklistPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(checklistPath));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>route-qa-checklist-v2.html not found</h2>');
    }
  });

  _liveServer.listen(3000, '127.0.0.1', () => {
    console.log('  📡  QA Checklist UI → http://localhost:3000');
    console.log('  ℹ️   Fill in the config form and click "Start QA Checklist" to begin\n');
    try {
      const { execSync } = require('child_process');
      // Open dashboard — use 'open' which opens in the current default browser
      // without forcing a new window or moving existing windows around
      if (process.platform === 'darwin') {
        execSync(`open http://localhost:3000`);
        // Only position windows when QA actually starts (after user fills the form)
        // so we don't disrupt their current workspace on startup
      } else {
        const openCmd = process.platform === 'win32' ? 'start' : 'xdg-open';
        execSync(`${openCmd} http://localhost:3000`);
      }
    } catch (_) {}
  });

  return uiStartPromise;
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

// Module-level screenshot slot — set by snap() inside runQA(), consumed by log()
let _nextScreenshot = null;

function log(section, name, status, detail = '', tcId = null) {
  // Consume any pending screenshot (set by snap() before this call)
  // Screenshots are attached to PASS / FAIL / WARN results only
  let screenshot = null;
  if (typeof _nextScreenshot !== 'undefined' && (status === 'PASS' || status === 'FAIL' || status === 'WARN')) {
    screenshot = _nextScreenshot || null;
    _nextScreenshot = null; // consume it so the next log() starts fresh
  }
  const icons = { PASS: '✅', FAIL: '❌', WARN: '⚠️ ', INFO: 'ℹ️ ' };
  results.push({ section, name, status, detail, tcId });
  const icon = icons[status] || '   ';
  const suffix = (status === 'FAIL' || status === 'WARN') && detail
    ? `\n       → ${detail.replace(/\s+/g, ' ').trim().slice(0, 120)}`
    : '';
  console.log(`    ${icon} ${name}${suffix}`);
  const fix = status === 'FAIL' ? getFix(section, name) : null;
  sseEmit('result', { sectionIndex: _sectionCounter, name, status, detail: detail.slice(0, 200), fix, tcId, screenshot });
}

let _sectionCounter = 0;
let _totalSections  = 14;
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
// Returns true if the page has a real, clickable Add to Cart button (not sold out / disabled)
async function isProductAddable(page) {
  return page.evaluate(() => {
    const SOLD_OUT_RE = /sold[\s-]*out|out[\s-]*of[\s-]*stock|unavailable|special[\s-]*order/i;
    const ATC_RE      = /add[\s-]*to[\s-]*cart|add[\s-]*to[\s-]*bag|add[\s-]*to[\s-]*basket|buy[\s-]*now|add[\s-]*to[\s-]*trolley/i;
    const candidates = [
      ...document.querySelectorAll(
        'button[name="add"], [data-add-to-cart], button[id*="add-to-cart"], ' +
        'button[class*="add-to-cart"], button[class*="add-to-bag"], ' +
        'input[name="add"], .btn-addtocart, .add-to-cart-btn, ' +
        'form[action*="/cart/add"] button[type="submit"]'
      )
    ];
    for (const btn of candidates) {
      const txt  = (btn.innerText || btn.value || '').trim();
      const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
      if (disabled) continue;
      if (SOLD_OUT_RE.test(txt)) continue;
      // Accept if text clearly says ATC or if it's an Add form submit with no "sold out" text
      if (ATC_RE.test(txt) || txt === '') return true;
    }
    return false;
  });
}

async function clickAddToCart(page) {
  const selectors = [
    'button[name="add"]',
    '[data-add-to-cart]',
    'button[id*="add-to-cart"]',
    'button[class*="add-to-cart"]',
    'button[class*="add-to-bag"]',
    'input[name="add"]',
    '.btn-addtocart',
    '.add-to-cart-btn',
    'form[action*="/cart/add"] button[type="submit"]',
    // Quick-add buttons on collection/product tiles
    'button[class*="quick-add"]',
    'button[data-quick-add]',
    'button[class*="quickadd"]',
    'button[class*="quick_add"]',
    '[class*="product-card__cart-btn"]',
  ];
  const SOLD_OUT_RE = /sold[\s-]*out|out[\s-]*of[\s-]*stock|unavailable|special[\s-]*order/i;
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) {
      try {
        const txt      = await btn.evaluate(el => (el.innerText || el.value || '').trim());
        const disabled = await btn.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');
        if (disabled || SOLD_OUT_RE.test(txt)) continue;
        await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(3500); // wait for cart drawer / redirect to settle

        // If a quick-add modal opened, try to confirm/add inside it
        const modalBtn = await page.$([
          '[class*="quick-add"] button[name="add"]',
          '[class*="quick-add"] button[type="submit"]',
          '[class*="quickadd"] button[type="submit"]',
          '.modal button[name="add"]',
          '.modal form[action*="/cart/add"] button',
          '[role="dialog"] button[name="add"]',
          '[role="dialog"] form[action*="/cart/add"] button[type="submit"]',
        ].join(', ')).catch(() => null);
        if (modalBtn) {
          const mTxt = await modalBtn.evaluate(el => (el.innerText || '').trim());
          if (!SOLD_OUT_RE.test(mTxt)) {
            await modalBtn.click({ timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(2000);
          }
        }
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
  const SITE_PASSWORD = RATES.sitePassword || '';

  // Use real Chrome if installed — much less likely to trigger Cloudflare
  let browser;
  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
  ];
  // Open Playwright on left half of screen, dashboard on right half
  const windowArgs = [...launchArgs, '--start-maximized']; // open maximized in a new window, no repositioning
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: HEADLESS, slowMo: HEADLESS ? 0 : 100, args: windowArgs });
    console.log('  🌐  Using real Chrome browser');
  } catch (_) {
    browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 100, args: windowArgs });
    console.log('  🌐  Using bundled Chromium');
  }
  // Playwright opens in its own window naturally — no repositioning

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }, // standard full viewport
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  // Hide automation indicators
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    window.chrome = { runtime: {} };
  });

  const consoleErrors = [];
  const routeNetworkCalls = [];

  const page = await context.newPage();

  // ── Screenshot helper ─────────────────────────────────────────────────────
  // Scrolls the Route widget into view before screenshotting so it's always visible.
  async function snap() {
    try {
      // Scroll Route widget into center of viewport
      await page.evaluate(() => {
        const sel = [
          '[data-route-widget]', '[class*="route-widget"]', '[data-route-modal]',
          '[class*="route-modal"]', '[id*="route-widget"]',
          // Preferred Checkout value prop text
          '[data-route-cloned-button]',
        ].join(', ');
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
      }).catch(() => {});
      await page.waitForTimeout(400); // let scroll settle
      const buf = await page.screenshot({ type: 'jpeg', quality: 35, fullPage: false });
      _nextScreenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch(_) { _nextScreenshot = null; }
  }

  // Legacy snapLog — now just calls snap() then log()
  async function snapLog(section, name, status, detail = '', tcId = null) {
    await snap();
    log(section, name, status, detail, tcId);
  }

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

  // ── Cloudflare challenge — pause and wait for human ──────────────────────
  async function isChallengePresent() {
    return page.evaluate(() => {
      const t = (document.title + ' ' + (document.body?.innerText||'')).toLowerCase();
      return t.includes('verify you are human') || t.includes('just a moment') || t.includes('checking your browser');
    }).catch(() => false);
  }

  async function handleCloudflare() {
    if (!(await isChallengePresent())) return false;

    console.log('\n  🔒  Cloudflare challenge detected!');
    console.log('  👉  Please solve it in the browser window, then the script will continue automatically');
    console.log('  ⏳  Waiting up to 60 seconds...\n');
    sseEmit('cloudflare', { message: '🔒 Cloudflare challenge — please solve it in the browser window to continue' });

    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1000);
      if (!(await isChallengePresent())) {
        console.log('  ✅ Cloudflare solved — continuing...\n');
        await page.waitForTimeout(2000);
        return true;
      }
      if (i === 15) console.log('  ⏳ Still waiting... (45s left)');
      if (i === 30) console.log('  ⏳ Still waiting... (30s left)');
      if (i === 45) console.log('  ⏳ Still waiting... (15s left)');
    }
    console.log('  ⚠️  Cloudflare not solved in time — continuing anyway\n');
    return false;
  }

  // ── Gap between tests ─────────────────────────────────────────────────────
  // Gives the page time to settle and widget to appear between test sections
  async function testGap(ms = 3000) {
    await page.waitForTimeout(ms);
  }

  // Navigate with fallback strategies
  // ── Password page handler ─────────────────────────────────────────────────
  // Detects Shopify store password pages and auto-fills the password if provided.
  async function handlePasswordPage() {
    if (!SITE_PASSWORD) return false;
    try {
      const isPasswordPage = await page.evaluate(() => {
        const path = window.location.pathname;
        const hasPasswordForm = !!document.querySelector(
          'form[action="/password"], form[action*="password"], input[name="password"][type="password"]'
        );
        return path === '/password' || hasPasswordForm;
      });
      if (!isPasswordPage) return false;

      // Find and fill the password input
      const pwInput = await page.$('input[name="password"][type="password"], input[id*="password"][type="password"]');
      if (!pwInput) return false;

      await pwInput.fill(SITE_PASSWORD);
      await page.waitForTimeout(300);

      // Submit — try Enter first, then submit button
      await pwInput.press('Enter');
      await page.waitForTimeout(500);
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button[name="commit"]');
      if (submitBtn) await submitBtn.click({ force: true, timeout: 3000 }).catch(() => {});

      await page.waitForTimeout(2000);
      console.log('  🔓  Store password entered automatically');
      sseEmit('result', {
        section: 'Setup', name: 'Store password entered automatically',
        status: 'INFO', detail: 'Password page detected and bypassed'
      });
      return true;
    } catch (_) { return false; }
  }

  async function safeGoto(url, label = '') {
    for (const waitUntil of ['domcontentloaded', 'commit']) {
      try {
        await page.goto(url, { waitUntil, timeout: 30000 });
        await page.waitForTimeout(1500);
        await handlePasswordPage(); // auto-enter password if password page appears
        await handleCloudflare();   // pause if Cloudflare appears
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

  // ── Shared state ────────────────────────────────────────────────────────
  let productUrl  = null;
  let productUrl2 = null; // second product for multi-product tests
  let addedToCart = false;
  const cartUrl   = new URL('/cart', BASE_URL).href;

  // ── Helper: close common popups ───────────────────────────────────────────
  async function closePopups() {
    const popupSelectors = [
      // Cookie / consent banners
      'button[id*="accept"], button[class*="accept-cookie"], button[class*="cookie-accept"]',
      '[id*="cookie"] button, [class*="cookie-banner"] button',
      // Newsletter / email capture popups
      'button[class*="close"], button[aria-label*="close" i], button[aria-label*="dismiss" i]',
      '[class*="modal"] button[class*="close"], [class*="popup"] button[class*="close"]',
      // Chat widgets
      'button[id*="chat-close"], [class*="chat"] button[class*="close"]',
      // Generic close buttons
      'button[data-dismiss="modal"]',
    ];
    for (const sel of popupSelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) { await el.click({ timeout: 2000 }).catch(() => {}); }
        }
      } catch(_) {}
    }
    // Press Escape to dismiss any remaining modal
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }

  // ── Helper: clear cart ────────────────────────────────────────────────────
  async function clearCart() {
    await page.evaluate(async () => { await fetch('/cart/clear.js', { method: 'POST' }); });
    await page.waitForTimeout(300);
  }

  // ── Helper: add product via API ───────────────────────────────────────────
  async function addProductToCartApi(variantId) {
    return page.evaluate(async (vid) => {
      const r = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: vid, quantity: 1 }),
      });
      return r.ok;
    }, String(variantId));
  }

  // ── Helper: find checkout button and click ────────────────────────────────
  // Priority order: Route's cloned button first, then standard Shopify, then text fallback
  async function clickCheckout(container) {
    const root = container || page;
    const selectors = [
      // Route clones the checkout button — this is the REAL clickable one
      'button[data-route-cloned-button="true"]',
      'button[data-route-cloned-button]',
      // Standard Shopify
      'button[name="checkout"]', 'input[name="checkout"]',
      '[data-testid="checkout-button"]', '.checkout-button',
      'button[id*="checkout"]', '[class*="checkout-btn"]', '[class*="checkout_btn"]',
      'form[action*="/checkout"] button[type="submit"]',
      // Href-based (anchor tags)
      'a[href*="/checkout"]', '#checkout',
    ];
    for (const sel of selectors) {
      const btn = await root.$(sel);
      if (!btn) continue;
      try {
        const isVisible = await btn.isVisible().catch(() => false);
        const isDisabled = await btn.evaluate(el =>
          el.disabled || el.getAttribute('aria-disabled') === 'true' || getComputedStyle(el).pointerEvents === 'none'
        ).catch(() => false);
        if (isDisabled) continue;
        // Scroll into view then click — use force to bypass minor visibility issues
        await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await btn.click({ timeout: 8000, force: true });
        return true;
      } catch(_) {
        try { await page.evaluate(el => el.click(), btn); return true; } catch(_) {}
      }
    }
    // Text-based fallback — try 'Check out', 'Checkout', 'Proceed to checkout'
    for (const txt of ['Check out', 'Checkout', 'Proceed to checkout', 'Continue to checkout']) {
      try { await page.click(`text="${txt}"`, { timeout: 3000, force: true }); return true; } catch(_) {}
    }
    return false;
  }

  // ── Helper: detect if a cart drawer/modal is currently open ───────────────
  async function isDrawerOpen() {
    return page.evaluate(() => {
      // Both hyphen, underscore, and BEM modifier variants (themes differ greatly)
      const drawerSelectors = [
        // Cart notification popup (e.g. MTS Dawn theme: id="cart-notification")
        '#cart-notification', '[id*="cart-notification"]', '[class*="cart-notification"]',
        '[aria-label*="added to your cart" i]', '[aria-label*="item added" i]',
        // Hyphen variants
        '.cart-drawer', '[class*="cart-drawer"]', '[id*="cart-drawer"]', '[id*="CartDrawer"]',
        '.cart_drawer', '[class*="cart_drawer"]', '[id*="cart_drawer"]',
        // Modal-based cart (e.g. Verillas uses class="modal--cart modal modal--right modal--dark")
        '[class*="modal--cart"]', '[class*="modal-cart"]',
        'div[role="dialog"][class*="cart"]',
        'div[role="dialog"][aria-labelledby*="cart"]',
        // Other patterns
        '.cart-modal',  '[class*="cart-modal"]',  '[class*="cart_modal"]',
        '.cart-aside',  '[class*="cart-aside"]',  '[class*="cart_aside"]',
        '.cart-slide',  '[class*="cart-slide"]',  '[class*="cart_slide"]',
        '.cart-sidebar','[class*="cart-sidebar"]','[class*="cart_sidebar"]',
        '.drawer',      '[class*="side-cart"]',   '[class*="mini-cart"]',
        '[class*="fly-cart"]', '[class*="slidecart"]',
      ];
      for (const sel of drawerSelectors) {
        try {
          const el = document.querySelector(sel);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          if (r.width > 0 && r.height > 50) return true;
        } catch(_) {}
      }
      // Body/html class patterns — themes add a class when cart opens
      const bodyClass = (document.body.className || '') + ' ' + (document.documentElement.className || '');
      if (/cart.*open|open.*cart|is-not-scrollable|u-scroll-disabled|drawer.*active|active.*drawer|cart.*visible|overlay.*active|modal.*open|open.*modal/i.test(bodyClass)) return true;
      // Route widget visible somewhere on page = cart must be open
      const routeWidget = document.querySelector('[data-route-widget], [class*="route-widget"], [id*="route-widget"], [data-route-modal]');
      if (routeWidget) {
        const r = routeWidget.getBoundingClientRect();
        const style = window.getComputedStyle(routeWidget);
        if (style.display !== 'none' && r.width > 0 && r.height > 0) return true;
      }
      return false;
    });
  }

  // ── Helper: try to open drawer by clicking cart icon ─────────────────────
  async function tryOpenCartDrawer() {
    const iconSels = [
      '[data-cart-icon]', '[class*="cart-icon"]', '[class*="cart__icon"]',
      '[class*="cart_icon"]', 'a[href="/cart"]', 'button[aria-label*="cart" i]',
      '.site-header__cart', '.header__cart', '[class*="header"] a[href*="/cart"]',
      '[class*="nav"] a[href*="/cart"]', '.cart-toggle', '[class*="cart-toggle"]',
      '[id*="cart-toggle"]', '[data-cart-toggle]',
    ];
    for (const sel of iconSels) {
      const el = await page.$(sel);
      if (!el) continue;
      const vis = await el.isVisible().catch(() => false);
      if (!vis) continue;
      try {
        await el.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(2500);
        return true;
      } catch(_) {}
    }
    return false;
  }

  // ── Helper: find checkout button inside visible drawer ────────────────────
  async function findDrawerCheckoutBtn() {
    // Route's cloned button is the most reliable indicator
    const allRouteBtns = await page.$$('button[data-route-cloned-button="true"], button[data-route-cloned-button]');
    for (const btn of allRouteBtns) {
      if (await btn.isVisible().catch(() => false)) return btn;
    }
    // Try within known drawer containers (both hyphen and underscore)
    const drawerContainerSels = [
      // Cart notification popup (MTS Dawn theme style)
      '#cart-notification', '[id*="cart-notification"]', '[class*="cart-notification"]',
      '[aria-label*="added to your cart" i]',
      // Modal-based (e.g. Verillas: modal--cart modal--right modal--dark)
      '[class*="modal--cart"]', '[class*="modal-cart"]',
      'div[role="dialog"][class*="cart"]',
      'div[role="dialog"][aria-labelledby*="cart"]',
      // Standard patterns
      '[class*="cart-drawer"]', '[class*="cart_drawer"]', '[id*="cart-drawer"]', '[id*="CartDrawer"]',
      '[class*="cart-aside"]',  '[class*="cart_aside"]',
      '[class*="cart-modal"]',  '[class*="cart_modal"]',
      '[class*="cart-slide"]',  '[class*="cart_slide"]',
      '[class*="side-cart"]',   '[class*="mini-cart"]', '.drawer',
    ];
    for (const containerSel of drawerContainerSels) {
      const container = await page.$(containerSel);
      if (!container || !await container.isVisible().catch(() => false)) continue;
      for (const btnSel of [
        'button[data-route-cloned-button]', 'button[name="checkout"]',
        'input[name="checkout"]', 'a[href*="/checkout"]',
      ]) {
        const btn = await container.$(btnSel);
        if (btn && await btn.isVisible().catch(() => false)) return btn;
      }
    }
    return null;
  }

  // ── Helper: checkout from drawer and verify Route at checkout ─────────────
  async function checkoutFromDrawerAndVerify() {
    // Give drawer 3s to open / animate
    await page.waitForTimeout(3000);
    // (no closePopups here - Escape would close the drawer)

    let drawerOpen = await isDrawerOpen();

    // If drawer not detected yet, try clicking the cart icon
    if (!drawerOpen) {
      const opened = await tryOpenCartDrawer();
      if (opened) {
        await page.waitForTimeout(2500);
        // (no closePopups here)
        drawerOpen = await isDrawerOpen();
      }
    }

    if (!drawerOpen) return { tested: false, reason: 'No drawer/modal detected — cart may go directly to cart page' };

    // Wait for Route widget inside drawer
    await page.waitForTimeout(2000); // let widget render
    const btn = await findDrawerCheckoutBtn();
    if (!btn) return { tested: false, reason: 'Drawer open but checkout button not found inside it' };

    await btn.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await btn.click({ force: true, timeout: 8000 });
    await page.waitForTimeout(5000);
    await handleCloudflare();

    const onCheckout = /checkout|checkouts/i.test(page.url());
    if (!onCheckout) return { tested: true, pass: false, reason: `Did not reach checkout — URL: ${page.url().slice(0, 80)}` };

    await page.waitForTimeout(2000);
    const count = await getRouteCountAtCheckout();
    return { tested: true, count, pass: count > 0 };
  }

  // ── Helper: find CWC link and click ──────────────────────────────────────
  async function clickCWC() {
    // First scroll to bottom of page so CWC link (usually below Checkout btn) is visible
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);

    const selectors = [
      'a[class*="without-coverage"]', 'a[class*="cwc"]',
      'a[id*="without-coverage"]', 'button[class*="without"]',
      '[data-cwc]', '[data-without-coverage]',
      'a[href*="checkout"][class*="without"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        try { await el.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch(_) {}
        try { await el.click({ force: true, timeout: 5000 }); return true; } catch(_) {}
        try { await page.evaluate(e => e.click(), el); return true; } catch(_) {}
      }
    }

    // Text-based search — most reliable for CWC
    const clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a, button, span, div'));
      const cwc = all.find(el =>
        /checkout without coverage|without coverage|no coverage|cwc/i.test(el.innerText || el.textContent || '')
        && (el.tagName === 'A' || el.tagName === 'BUTTON' || el.onclick || el.getAttribute('href'))
      );
      if (cwc) { cwc.click(); return true; }
      // Also try just text matching any clickable element
      const any = all.find(el => /checkout without coverage|without coverage/i.test(el.innerText || ''));
      if (any) { any.click(); return true; }
      return false;
    });
    return clicked;
  }

  // ── Helper: count Route items on checkout page ────────────────────────────
  // Specifically looks for 'Shipping Protection by Route' as shown in checkout order summary
  // Shared scanner: finds "Shipping Protection by Route" anywhere on page
  // Count Route as PRODUCT ENTRIES (rows/line items), not raw text occurrences.
  // A single Route item in checkout may appear many times in the DOM (title, aria-label,
  // hidden copies, image alt) — counting those gives false "3 duplicates" results.
  const scanPageForRoute = () => page.evaluate(() => {
    const fullText = document.body.innerText || '';
    if (!/shipping protection by route/i.test(fullText)
        && !/route.*protection|route.*shipping/i.test(fullText)) return 0;

    // Try to count by distinct PRODUCT ROW containers in checkout order summary
    const rowSelectors = [
      // Shopify native checkout line item containers
      '[class*="product--cart"]',
      '[class*="line-item"]',
      '[class*="order-summary__line-item"]',
      '[class*="cart-item"]',
      '[class*="checkout-product"]',
      // Generic product row selectors
      'tr[class*="product"]',
      'li[class*="product"]',
      'li[class*="item"]',
      '.product',
    ];

    for (const sel of rowSelectors) {
      const rows = document.querySelectorAll(sel);
      if (rows.length === 0) continue;
      let count = 0;
      for (const row of rows) {
        if (/shipping protection by route/i.test(row.innerText || row.textContent || '')) count++;
      }
      if (count > 0) return count; // found via product rows — most accurate
    }

    // Fallback: Route text is present but no product row containers matched.
    // Return 1 — presence is confirmed, exact count can't be determined.
    return 1;
  });

  async function getRouteCountAtCheckout() {
    // Step 1: Scan immediately — Route may already be visible (no expansion needed)
    // Wait a bit for checkout JS to finish rendering
    await page.waitForTimeout(2500);
    const quickCount = await scanPageForRoute();
    if (quickCount > 0) return quickCount;

    // Step 2: Not found yet — try to expand any COLLAPSED order summary sections
    // Use very targeted selectors only; avoid broad [aria-expanded="false"] which
    // would catch unrelated UI elements like "Show more options" and flip page state
    await page.evaluate(async () => {
      const ORDER_RE = /order\s*(summary|review|details)|show\s*order|cart\s*summary|your\s*order/i;

      // Targeted: known Shopify / common theme selectors for order summary toggles
      const specific = document.querySelectorAll(
        '[data-order-summary-toggle], ' +
        '[class*="order-summary__toggle"], ' +
        '[class*="order-summary-toggle"], ' +
        '[class*="order__summary-toggle"]'
      );
      for (const el of specific) {
        try { el.click(); } catch(_) {}
        await new Promise(r => setTimeout(r, 600));
      }

      // <summary> tags inside <details> that look like order sections
      const summaries = document.querySelectorAll('details summary');
      for (const s of summaries) {
        const txt = (s.innerText || s.getAttribute('aria-label') || '').trim();
        if (ORDER_RE.test(txt)) {
          const details = s.closest('details');
          if (details && !details.open) {
            details.open = true;
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }

      // Any button whose visible text is exactly about showing the order summary
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const txt = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
        if (ORDER_RE.test(txt) && btn.getAttribute('aria-expanded') === 'false') {
          try { btn.click(); } catch(_) {}
          await new Promise(r => setTimeout(r, 600));
        }
      }
    });

    // Step 3: Wait for expanded content to render, then scan again
    await page.waitForTimeout(2000);
    return scanPageForRoute();
  }

  // ── Helper: collect candidate product URLs (up to 15) ────────────────────
  // These handles indicate non-physical / Route-internal products — never use as test products
  const SKIP_HANDLES = /route|gift.?card|giftcard|shipping.?protect|protection|digital|e.?gift|voucher|certificate/i;

  async function collectProductLinks() {
    await safeGoto(BASE_URL, 'homepage');
    await closePopups();
    let links = await page.$$eval('a[href*="/products/"]',
      els => [...new Set(els.map(e => e.href))].filter(h => !h.includes('/collections'))
    );
    // Always also try /collections/all for more candidates
    await safeGoto(new URL('/collections/all', BASE_URL).href, 'collections/all');
    await closePopups();
    const collLinks = await page.$$eval('a[href*="/products/"]',
      els => [...new Set(els.map(e => e.href))]
    );
    // Merge + dedupe, strip digital/Route products, limit to 20
    const all = [...new Set([...links, ...collLinks])]
      .filter(h => !SKIP_HANDLES.test(h))
      .slice(0, 20);
    return all;
  }

  // ── Helper: find addable products by visiting each candidate ──────────────
  async function discoverProducts() {
    sseEmit('section', { name: '🔍 Finding addable products…' });
    const candidates = await collectProductLinks();
    sseEmit('result', {
      section: 'Setup', name: 'Product discovery',
      status: candidates.length ? 'INFO' : 'WARN',
      detail: candidates.length
        ? `Found ${candidates.length} product candidate(s) to check`
        : 'No product links found on homepage or /collections/all'
    });

    let found = 0;
    for (const url of candidates) {
      if (found >= 2) break;
      try {
        // Quick API check: confirm product is physical (requires_shipping) before visiting page
        const handle = url.split('/products/')[1]?.split('?')[0]?.split('#')[0];
        if (handle) {
          const isPhysical = await page.evaluate(async (h) => {
            try {
              const r = await fetch(`/products/${h}.js`);
              if (!r.ok) return true; // assume physical if can't check
              const p = await r.json();
              if (p.gift_card) return false; // definitely digital
              // If all variants have requires_shipping === false, it's digital
              const variants = p.variants || [];
              if (variants.length > 0 && variants.every(v => v.requires_shipping === false)) return false;
              return true;
            } catch(_) { return true; }
          }, handle);
          if (!isPhysical) {
            sseEmit('result', {
              section: 'Setup', name: 'Product skipped (digital/gift card — not eligible for Route)',
              status: 'INFO', detail: url
            });
            continue;
          }
        }

        await safeGoto(url, 'checking product');
        await closePopups();
        await page.waitForTimeout(1500); // let page settle
        const addable = await isProductAddable(page);
        if (!addable) {
          sseEmit('result', {
            section: 'Setup', name: 'Product skipped (sold out / no ATC)',
            status: 'INFO', detail: url
          });
          continue;
        }
        // Try actually adding it to cart to confirm
        const added = await clickAddToCart(page);
        if (!added) {
          sseEmit('result', {
            section: 'Setup', name: 'Product skipped (ATC click failed)',
            status: 'INFO', detail: url
          });
          continue;
        }
        // Confirm cart has items
        const cartCount = await page.evaluate(() => {
          return fetch('/cart.js').then(r => r.json()).then(c => c.item_count).catch(() => 0);
        });
        if (cartCount === 0) {
          sseEmit('result', {
            section: 'Setup', name: 'Product skipped (cart still empty after ATC)',
            status: 'INFO', detail: url
          });
          continue;
        }
        // This product works!
        found++;
        if (found === 1) {
          productUrl = url;
          sseEmit('result', {
            section: 'Setup', name: '✅ Product 1 confirmed (addable)',
            status: 'PASS', detail: url
          });
        } else {
          productUrl2 = url;
          sseEmit('result', {
            section: 'Setup', name: '✅ Product 2 confirmed (addable)',
            status: 'PASS', detail: url
          });
        }
        // Clear cart before tests start
        await page.evaluate(() => fetch('/cart/clear.js', { method: 'POST' }).catch(() => {}));
        await page.waitForTimeout(1000);
      } catch (e) {
        // skip this product and move on
      }
    }

    if (!productUrl) {
      sseEmit('result', {
        section: 'Setup', name: '❌ No addable product found',
        status: 'FAIL',
        detail: `Checked ${candidates.length} product(s) — all appear to be sold out, disabled, or use a non-standard cart form. Most tests will be skipped.`
      });
    }
  }

  try {
    // Discover products first — validates each can actually be added to cart
    await discoverProducts();
    await closePopups();

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('1 · Widget Version Confirmation');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {
      await safeGoto(productUrl, 'product page');
      addedToCart = await clickAddToCart(page);
      await safeGoto(cartUrl, 'cart');
      await closePopups();
      await waitForRouteWidget(page, 6000);
      await page.waitForTimeout(2000);

      // For Preferred Checkout: confirm by checking for value prop text + CWC link
      // rather than CSS visibility (the widget renders as page content, not a hidden element)
      const pcCheck = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const hasValueProp = /order (is )?protected for \$|order protected for/i.test(text);
        const hasCWC = /checkout without coverage|without coverage/i.test(text);
        const hasCheckoutBtn = !!document.querySelector(
          'button[name="checkout"], input[name="checkout"], a[href*="/checkout"], .checkout-button'
        );
        return { hasValueProp, hasCWC, hasCheckoutBtn, snippet: text.slice(0, 200).replace(/\s+/g,' ') };
      });

      await snap();
      log('Widget Confirmation', 'Preferred Checkout widget loads on cart page',
        (pcCheck.hasValueProp || pcCheck.hasCWC) ? 'PASS' : 'FAIL',
        pcCheck.hasValueProp
          ? 'Value prop "Order protected for $X" visible on cart page'
          : pcCheck.hasCWC
            ? '"Checkout Without Coverage" link visible on cart page'
            : 'Neither value prop text nor CWC link found on cart page',
        'TC-W');

      await snap();
      log('Widget Confirmation', '"Checkout Without Coverage" link present',
        pcCheck.hasCWC ? 'PASS' : 'FAIL',
        pcCheck.hasCWC ? 'CWC link found' : 'CWC link not found — Preferred Checkout widget may not be loading',
        'TC-W');

      await snap();
      log('Widget Confirmation', 'Checkout button present',
        pcCheck.hasCheckoutBtn ? 'PASS' : 'WARN',
        pcCheck.hasCheckoutBtn ? 'Checkout button found' : 'Checkout button not detected');

    } else {
      log('Widget Confirmation', 'Preferred Checkout widget loads on cart page', 'WARN', 'No product URL found to add to cart');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('2 · TC-01: Route Added via Checkout ⭐');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    // TC-01 tests checkout from TWO places: drawer cart (if it opens) AND main cart page
    if (productUrl) {
      await clearCart();
      await safeGoto(productUrl, 'product page (TC-01)');
      const added = await clickAddToCart(page);
      if (!added) {
        log('TC-01 Route Added via Checkout', 'Add to Cart succeeded', 'WARN', 'Could not click Add to Cart — test skipped');
      } else {
        await page.waitForTimeout(2000); // let drawer animate open
        await closePopups();

        // ── TC-01a: Drawer cart checkout ─────────────────────────────────
        try {
          const drawerResult = await checkoutFromDrawerAndVerify('TC-01a');
          if (!drawerResult.tested) {
            log('TC-01 Route Added via Checkout', 'Drawer cart checkout', 'INFO',
              drawerResult.reason || 'No drawer detected — skipping drawer test');
          } else if (!drawerResult.pass && drawerResult.reason) {
            log('TC-01 Route Added via Checkout', 'Drawer cart → reached checkout', 'WARN', drawerResult.reason);
          } else {
            await snapLog('TC-01 Route Added via Checkout', 'Drawer cart → Route present at checkout',
              drawerResult.pass ? 'PASS' : 'FAIL',
              drawerResult.pass
                ? `${drawerResult.count} Route item(s) found in order summary`
                : 'Route NOT found in checkout order summary after drawer checkout',
              'TC-01a');
            await snap();
            log('TC-01 Route Added via Checkout', 'Drawer cart → Only 1 Route (no duplicates)',
              drawerResult.count === 1 ? 'PASS' : 'FAIL',
              drawerResult.count === 1 ? 'Exactly 1 Route item ✓' : `${drawerResult.count} Route item(s) — check for duplicates`,
              'TC-01a');
          }
        } catch(e) {
          log('TC-01 Route Added via Checkout', 'Drawer cart checkout error', 'WARN', e.message.slice(0,120));
        }

        // ── TC-01b: Main cart page checkout — retry up to 3 times ───────
        let checkoutReached = false;
        for (let attempt = 1; attempt <= 3 && !checkoutReached; attempt++) {
          await safeGoto(cartUrl, `main cart (TC-01b attempt ${attempt})`);
          await closePopups();
          await waitForRouteWidget(page, 6000);
          await page.waitForTimeout(2000);
          try {
            const checkoutClicked = await clickCheckout();
            if (!checkoutClicked) {
              if (attempt === 3) log('TC-01 Route Added via Checkout', 'Main cart → checkout button clicked', 'WARN',
                'Checkout button not found after 3 attempts — check if cart uses a custom button');
              continue;
            }
            await page.waitForTimeout(5000);
            await handleCloudflare();
            const onCheckout = /checkout|checkouts/i.test(page.url());
            if (onCheckout) {
              checkoutReached = true;
              await snap();
              log('TC-01 Route Added via Checkout', 'Main cart → reached checkout page',
                'PASS', `${page.url().slice(0,80)}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
              await closePopups();
              const routeAtCheckout = await getRouteCountAtCheckout();
              await snapLog('TC-01 Route Added via Checkout', 'Main cart → Route present at checkout',
                routeAtCheckout > 0 ? 'PASS' : 'FAIL',
                routeAtCheckout > 0 ? `${routeAtCheckout} Route item(s) in order summary` : 'Route NOT found in checkout order summary',
                'TC-01b');
              await snapLog('TC-01 Route Added via Checkout', 'Main cart → Only 1 Route (no duplicates)',
                routeAtCheckout === 1 ? 'PASS' : 'FAIL',
                routeAtCheckout === 1 ? 'Exactly 1 Route item ✓' :
                routeAtCheckout > 1 ? `${routeAtCheckout} Route items — duplicates!` : 'Route not found',
                'TC-01b');
            } else if (attempt === 3) {
              log('TC-01 Route Added via Checkout', 'Main cart → checkout navigation', 'WARN',
                `Did not reach checkout after 3 attempts — URL: ${page.url().slice(0,80)}`);
            }
          } catch(e) {
            if (attempt === 3) {
              await snap();
              log('TC-01 Route Added via Checkout', 'Main cart checkout error', 'FAIL',
                e.message.split('\n')[0].slice(0,150), 'TC-01b');
            }
          }
        }
      }
    } else {
      log('TC-01 Route Added via Checkout', 'Route added at checkout', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('3 · TC-02: Route Removed via CWC');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {
      await clearCart();
      await safeGoto(productUrl, 'product page (TC-02)');
      await clickAddToCart(page);
      await safeGoto(cartUrl, 'cart (TC-02)');
      await waitForRouteWidget(page, 6000);
      await page.waitForTimeout(1500);

      const cwcClicked = await clickCWC();
      if (!cwcClicked) {
        log('TC-02 Route Removed via CWC', 'CWC link found and clicked', 'WARN', '"Checkout Without Coverage" link not found — verify manually');
      } else {
        await page.waitForTimeout(4000);
        const onCheckout = /checkout|checkouts/i.test(page.url());
        if (onCheckout) {
          await page.waitForTimeout(2000);
          const routeAtCheckout = await getRouteCountAtCheckout();
          await snap();
          log('TC-02 Route Removed via CWC', 'Route product NOT present at checkout after CWC',
            routeAtCheckout === 0 ? 'PASS' : 'FAIL',
            routeAtCheckout === 0 ? 'Route correctly absent at checkout after CWC click' :
            `Route still present (${routeAtCheckout} item(s)) after clicking CWC`,
            'TC-02');
        } else {
          // CWC may clear cart and redirect — check cart.js
          await safeGoto(cartUrl, 'cart after CWC');
          const routeCount = await getRouteLineItemCount(page);
          await snap();
          log('TC-02 Route Removed via CWC', 'Route product removed from cart after CWC',
            routeCount === 0 ? 'PASS' : 'FAIL',
            routeCount === 0 ? 'Route correctly removed after CWC' : `Route still in cart (${routeCount} items)`,
            'TC-02');
        }
      }
    } else {
      log('TC-02 Route Removed via CWC', 'Route removed via CWC', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('4 · TC-03: Premium Calculation');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    // Route's known variant price table — used to round raw premium UP to nearest available variant
    // Mirrors the Route Insurance product variants visible in Shopify admin
    const ROUTE_VARIANTS = [
      0.98, 1.15, 1.35, 1.55, 1.75, 1.95, 2.15, 2.35, 2.55, 2.75,
      2.95, 3.15, 3.35, 3.55, 3.75, 3.95, 4.15, 4.35, 4.55, 4.75,
      4.95, 5.15, 5.35, 5.55, 5.75, 5.95, 6.15, 6.35, 6.55, 6.75,
      6.95, 7.15, 7.35, 7.55, 7.75, 7.95, 8.15, 8.35, 8.55, 8.75,
      8.95, 9.38, 10.03, 10.68, 11.33, 11.98, 12.63, 13.28, 13.93, 14.58,
      15.23, 15.88, 16.53, 17.18, 17.83, 18.48, 19.13, 19.78, 20.43, 21.08,
      21.73, 22.38, 23.03, 23.68, 24.33, 24.98, 25.63, 26.28, 26.93, 27.58,
      28.23, 28.88, 29.53, 30.18, 30.83, 31.48, 32.13, 32.78, 33.43, 34.08,
      34.73, 35.38, 36.03, 36.68, 37.33, 37.98, 38.63, 39.28, 39.93, 40.58,
      41.23, 41.88, 42.53, 43.18, 43.83, 44.48, 45.13, 45.78, 46.43, 47.08,
      47.73, 48.38, 49.03, 49.68, 50.33, 52.28, 54.23, 56.18, 58.13, 60.08,
      62.03, 63.98, 65.93, 67.88, 69.83, 71.78, 73.73, 75.68, 77.63, 79.58,
      82.48, 85.38, 88.28, 91.18, 94.08, 96.98, 99.88,
    ];
    const roundUpToVariant = (rawPremium) => {
      for (const v of ROUTE_VARIANTS) { if (v >= rawPremium - 0.001) return v; }
      return null; // above known range — extremely high subtotal
    };

    // ── Helper: verify premium for current cart state ──────────────────────
    const verifyPremiumForCart = async (tierLabel, tcId) => {
      const cartData = await page.evaluate(async () => {
        const r = await fetch('/cart.js'); return r.ok ? r.json() : null;
      });
      if (!cartData) {
        log('TC-03 Premium Calculation', `${tierLabel} — cart data`, 'WARN', 'Could not read /cart.js'); return;
      }
      const allItems  = cartData.items || [];
      const routeItem = allItems.find(i => /route/i.test((i.handle||'') + (i.title||'')));
      const physical  = allItems.filter(i =>
        !/route/i.test((i.handle||'') + (i.title||'')) &&
        i.gift_card !== true && i.requires_shipping !== false);
      const subtotal  = physical.reduce((s, i) => s + i.line_price, 0) / 100;
      const actualPremium = routeItem ? routeItem.price / 100 : null;

      const tier1Max  = RATES.tier1Max  || 100;
      const tier1Rate = RATES.tier1Rate || 1.95;
      const tier2Rate = RATES.tier2Rate || 2.5;
      const tier1Fmt  = RATES.tier1Format || 'pct';
      const inLower   = subtotal <= tier1Max;
      const rate      = inLower ? tier1Rate : tier2Rate;
      const fmt       = inLower ? tier1Fmt : (RATES.tier2Format || 'pct');
      const rawPremium = fmt === 'flat' ? rate : subtotal * (rate / 100);
      const expectedVariant = roundUpToVariant(rawPremium);

      log('TC-03 Premium Calculation',
        `${tierLabel} — subtotal $${subtotal.toFixed(2)} (${inLower ? 'lower' : 'upper'} tier @ ${fmt === 'flat' ? '$'+rate+' flat' : rate+'%'})`,
        'INFO',
        `Raw: $${rawPremium.toFixed(4)} → Expected variant: $${expectedVariant?.toFixed(2) ?? '(above table)'}${actualPremium !== null ? ' | Route in cart: $'+actualPremium.toFixed(2) : ''}`);

      // Check 1: Route line item in /cart.js (most reliable)
      if (actualPremium !== null) {
        const diff = Math.abs(actualPremium - (expectedVariant ?? rawPremium));
        const ok   = diff <= 0.20;
        await snap();
        log('TC-03 Premium Calculation', `${tierLabel} — Route variant matches expected`,
          ok ? 'PASS' : 'FAIL',
          `Expected: $${expectedVariant?.toFixed(2) ?? '?'} | Route charged: $${actualPremium.toFixed(2)}${!ok ? ' ← MISMATCH' : ''}`,
          tcId);
      }

      // Check 2: widget text ("Your order is protected for $X")
      const pageText = await page.evaluate(() => document.body.innerText || '');
      const textMatch = pageText.match(/order.*?protected.*?\$([\d.]+)/i)
                     || pageText.match(/protected.*?for.*?\$([\d.]+)/i);
      if (textMatch) {
        const shownAmt = parseFloat(textMatch[1]);
        const target   = expectedVariant ?? rawPremium;
        const ok       = Math.abs(shownAmt - target) <= 0.20;
        await snap();
        log('TC-03 Premium Calculation', `${tierLabel} — widget shows correct premium`,
          ok ? 'PASS' : 'FAIL',
          `Widget: $${shownAmt.toFixed(2)} | Expected: $${target.toFixed(2)}`,
          tcId);
      } else if (actualPremium === null) {
        log('TC-03 Premium Calculation', `${tierLabel} — premium readable`, 'WARN',
          'Neither /cart.js Route item nor widget text found — verify manually');
      }
    };

    if (productUrl) {
      const tier1Max = RATES.tier1Max || 100;

      // ── TC-03a: Lower tier test ─────────────────────────────────────────
      // Add one product — most products will be below the tier threshold
      await clearCart();
      await safeGoto(productUrl, 'product page (TC-03a)');
      await clickAddToCart(page);
      await safeGoto(cartUrl, 'cart (TC-03a)');
      await waitForRouteWidget(page, 6000);
      await page.waitForTimeout(1500);
      try {
        // Check current subtotal — if already above tier1Max, go to tier2 test
        const sub = await page.evaluate(async () => {
          const r = await fetch('/cart.js'); const d = r.ok ? await r.json() : null;
          const physical = (d?.items||[]).filter(i => !/route/i.test((i.handle||'')+(i.title||'')) && i.gift_card !== true);
          return physical.reduce((s,i) => s + i.line_price, 0) / 100;
        });
        if (sub <= tier1Max) {
          await verifyPremiumForCart('Lower tier', 'TC-03a');
        } else {
          log('TC-03 Premium Calculation', 'Lower tier', 'INFO',
            `Product price ($${sub.toFixed(2)}) already above tier threshold — skipping lower tier test`);
        }
      } catch(e) {
        log('TC-03 Premium Calculation', 'Lower tier', 'WARN', e.message.split('\n')[0]);
      }

      // ── TC-03b: Upper tier test ─────────────────────────────────────────
      // Keep adding products until subtotal exceeds tier1Max
      await testGap(1500);
      log('TC-03 Premium Calculation', 'Upper tier test — building cart above threshold', 'INFO',
        `Adding products to push subtotal above $${tier1Max}`);

      // Keep adding products from candidate list until subtotal > tier1Max
      const allCandidates = [productUrl, productUrl2, ...await page.evaluate(async (base) => {
        const r = await fetch(base + '/products.json?limit=20&sort_by=price-descending');
        if (!r.ok) return [];
        const d = await r.json();
        return (d.products||[]).map(p => base + '/products/' + p.handle);
      }, BASE_URL).catch(() => [])].filter(Boolean);

      let upperSubtotal = 0;
      let attempts = 0;
      while (upperSubtotal <= tier1Max && attempts < 15) {
        attempts++;
        const addUrl = allCandidates[attempts % allCandidates.length] || productUrl;
        await safeGoto(addUrl, `TC-03b product ${attempts}`);
        await clickAddToCart(page);
        upperSubtotal = await page.evaluate(async () => {
          const r = await fetch('/cart.js'); const d = r.ok ? await r.json() : null;
          return (d?.items||[]).filter(i => !/route/i.test((i.handle||'')+(i.title||'')))
            .reduce((s,i) => s + i.line_price, 0) / 100;
        });
      }

      if (upperSubtotal > tier1Max) {
        await safeGoto(cartUrl, 'cart (TC-03b upper tier)');
        await waitForRouteWidget(page, 6000);
        await page.waitForTimeout(1500);
        try { await verifyPremiumForCart('Upper tier', 'TC-03b'); }
        catch(e) { log('TC-03 Premium Calculation', 'Upper tier', 'WARN', e.message.split('\n')[0]); }
      } else {
        log('TC-03 Premium Calculation', 'Upper tier test', 'WARN',
          `Could not push cart above $${tier1Max} threshold after ${attempts} attempts — verify upper tier premium manually`);
      }
    } else {
      log('TC-03 Premium Calculation', 'Premium calculation', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('5 · TC-04: Widget Disappears Above Threshold');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    {
      const coverageLimit = RATES.coverageLimit || 5000;
      await clearCart();
      await safeGoto(cartUrl, 'cart (coverage limit)');
      await waitForRouteWidget(page, 6000);
      const widgetBelow = await findRouteWidget(page);

      if (!widgetBelow.found) {
        log('TC-04 Widget Disappears Above Threshold', 'Widget present below coverage limit', 'WARN', 'No product in cart to test widget visibility');
      } else {
        // Try to add enough quantity to exceed limit
        if (productUrl) {
          await clearCart();
          await safeGoto(productUrl, 'product (coverage limit)');
          await clickAddToCart(page);
          const cartD = await page.evaluate(async () => { const r = await fetch('/cart.js'); return r.ok ? r.json() : null; });
          if (cartD && cartD.total_price) {
            const subtotal = cartD.total_price / 100;
            const unitPrice = (cartD.items||[]).filter(i=>!/route/i.test(i.title)).reduce((s,i)=>s+i.price,0)/100;
            if (unitPrice > 0 && subtotal < coverageLimit) {
              const qtyNeeded = Math.ceil((coverageLimit - subtotal) / unitPrice) + 1;
              const inp = await page.$('input[name="updates[]"], input[class*="quantity"], input[type="number"]');
              if (inp) {
                await inp.fill(String(Math.min(qtyNeeded + 1, 50)));
                await inp.press('Enter');
                await page.waitForTimeout(1000);
              }
            }
            await safeGoto(cartUrl, 'cart (above limit)');
            await waitForRouteWidget(page, 6000);
            const widgetAbove = await findRouteWidget(page);
            const newCart = await page.evaluate(async () => { const r = await fetch('/cart.js'); return r.ok ? r.json() : null; });
            const newSubtotal = (newCart?.total_price||0) / 100;
            if (newSubtotal > coverageLimit) {
              await snap();
              log('TC-04 Widget Disappears Above Threshold',
                `Widget hidden when cart > $${coverageLimit.toLocaleString()}`,
                !widgetAbove.visible ? 'PASS' : 'FAIL',
                `Cart subtotal: $${newSubtotal.toFixed(2)} | Widget ${widgetAbove.visible ? 'STILL VISIBLE — issue!' : 'correctly hidden'}`,
                'TC-04');
            } else {
              log('TC-04 Widget Disappears Above Threshold', 'Coverage limit test', 'WARN',
                `Could not exceed $${coverageLimit} limit (product unit price too low or qty limit reached)`);
            }
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('6 · TC-05: Multi Route Checkout');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {
      // 6a: single product
      await clearCart();
      await safeGoto(productUrl, 'product (TC-05a)');
      await clickAddToCart(page);
      await safeGoto(cartUrl, 'cart (TC-05a)');
      await waitForRouteWidget(page, 6000);
      const clicked5a = await clickCheckout();
      if (clicked5a) {
        await page.waitForTimeout(4000);
        if (/checkout|checkouts/i.test(page.url())) {
          await page.waitForTimeout(1500);
          const r5a = await getRouteCountAtCheckout();
          await snap();
          log('TC-05 Multi Route Checkout', 'Single product → only 1 Route at checkout',
            r5a === 1 ? 'PASS' : 'FAIL',
            `${r5a} Route item(s) at checkout`, 'TC-05a');
        } else {
          log('TC-05 Multi Route Checkout', 'Single product → checkout navigation', 'WARN', 'Did not reach checkout page');
        }
      } else {
        log('TC-05 Multi Route Checkout', 'Single product checkout', 'WARN', 'Checkout button not found');
      }

      // 6b: multiple products
      if (productUrl2) {
        await clearCart();
        await safeGoto(productUrl, 'product 1 (TC-05b)');
        await clickAddToCart(page);
        await safeGoto(productUrl2, 'product 2 (TC-05b)');
        await clickAddToCart(page);
        await safeGoto(cartUrl, 'cart (TC-05b)');
        await closePopups();
        await waitForRouteWidget(page, 6000);
        const clicked5b = await clickCheckout();
        if (clicked5b) {
          await page.waitForTimeout(5000);
          if (/checkout|checkouts/i.test(page.url())) {
            await page.waitForTimeout(1500);
            const r5b = await getRouteCountAtCheckout();
            await snap();
            log('TC-05 Multi Route Checkout', 'Multiple products → only 1 Route at checkout',
              r5b === 1 ? 'PASS' : 'FAIL',
              `${r5b} Route item(s) at checkout with multiple products`, 'TC-05b');
          }
        }
      } else {
        log('TC-05 Multi Route Checkout', 'Multiple products test', 'WARN', 'Only one product URL found — skipped');
      }
    } else {
      log('TC-05 Multi Route Checkout', 'Multi route checkout', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('7 · TC-06: Updates[] / Quantity Change Checks');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {

      // ── Helper: detect "maximum qty" error messages on the cart page ───────
      const hasMaxQtyError = async () => page.evaluate(() => {
        const MAX_RE = /maximum\s*(quantity|number|amount|items?)\s*(available|added|reached|per\s*order)?|maximum\s*order\s*qty|limit\s*reached|you.*already.*max|only\s*\d+\s*(left|available|in\s*stock)/i;
        const text = document.body.innerText || '';
        return MAX_RE.test(text);
      });

      // ── Helper: get current cart subtotal from /cart.js ─────────────────
      const getCartSubtotal = async () => {
        // Wait for any in-progress navigation to settle before evaluating
        try { await page.waitForLoadState('domcontentloaded', { timeout: 5000 }); } catch(_) {}
        return page.evaluate(() =>
          fetch('/cart.js').then(r => r.json()).then(c => c.total_price / 100).catch(() => 0)
        ).catch(() => 0);
      };

      // ── Helper: checkout and verify Route ──────────────────────────────
      const checkoutAndVerifyRoute = async (label, subContext) => {
        const clicked = await clickCheckout();
        if (!clicked) {
          log('TC-06 Updates[] Checks', `${label} — checkout button`, 'WARN', 'Checkout button not found');
          return;
        }
        await page.waitForTimeout(5000);
        await handleCloudflare();
        if (!/checkout|checkouts/i.test(page.url())) {
          log('TC-06 Updates[] Checks', `${label} — navigation`, 'WARN', `Did not reach checkout — URL: ${page.url().slice(0,80)}`);
          return;
        }
        await page.waitForTimeout(2000);
        const rCount = await getRouteCountAtCheckout();
        await snap();
        log('TC-06 Updates[] Checks', `${label} — Route present at checkout`,
          rCount > 0 ? 'PASS' : 'FAIL',
          `${rCount} Route item(s) found in order summary`, subContext);
        await snap();
        log('TC-06 Updates[] Checks', `${label} — Only 1 Route item (no duplicates)`,
          rCount === 1 ? 'PASS' : 'FAIL',
          rCount === 1 ? '✓ Exactly 1 Route item' : `${rCount} Route items — check for duplicates`, subContext);
      };

      // ── Helper: try to increase qty, detect limit, find alternate if needed ─
      const tryIncreaseQty = async (targetQty) => {
        // Find quantity input
        const inp = await page.$('input[name="updates[]"], input[class*="quantity"], input[type="number"][min], input[class*="qty"]');
        if (!inp) {
          log('TC-06 Updates[] Checks', 'Quantity input', 'WARN', 'No qty input found on cart page');
          return { changed: false, hitLimit: false };
        }

        const oldSubtotal = await getCartSubtotal();

        // Focus the input, select-all, then fill — avoids click visibility timeouts
        try { await inp.focus({ timeout: 3000 }); } catch (_) {}
        await page.keyboard.press('Control+a').catch(() => {});
        await inp.fill(String(targetQty), { timeout: 5000 }).catch(async () => {
          // Fallback: set value via JS — wrap args in object (Playwright only allows 1 arg)
          await page.evaluate(({ el, v }) => {
            el.value = v;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, { el: inp, v: String(targetQty) });
        });

        // Trigger update — try Enter first, then look for an explicit "Update cart" button
        await inp.press('Enter').catch(() => {});
        await page.waitForTimeout(1000);

        // Some themes require clicking an Update / Refresh button after changing qty
        const updateBtn = await page.$([
          'button[name="update"]',
          'button[class*="update-cart"]',
          'button[class*="cart-update"]',
          'input[name="update"]',
          'button[class*="qty-update"]',
          '[data-cart-update]',
        ].join(', ')).catch(() => null);
        if (updateBtn && await updateBtn.isVisible().catch(() => false)) {
          await updateBtn.click({ force: true, timeout: 3000 }).catch(() => {});
        }

        // Also try clicking the + stepper if qty didn't go up (some themes ignore direct fill)
        // by checking current input value vs target
        const currentVal = await inp.evaluate(el => parseInt(el.value) || 0).catch(() => 0);
        if (currentVal < targetQty) {
          const plusBtn = await page.$([
            'button[class*="qty-plus"]', 'button[class*="quantity-plus"]',
            'button[aria-label*="Increase"]', 'button[aria-label*="increase"]',
            '[data-qty-plus]', '[class*="plus"]',
          ].join(', ')).catch(() => null);
          if (plusBtn && await plusBtn.isVisible().catch(() => false)) {
            const clicks = targetQty - currentVal;
            for (let c = 0; c < clicks && c < 10; c++) {
              await plusBtn.click({ force: true, timeout: 2000 }).catch(() => {});
              await page.waitForTimeout(400);
            }
          }
        }

        // Wait for cart to recalculate — up to 6s polling every 500ms
        // Wrapped in try/catch in case a navigation destroys the page context
        let newSubtotal = oldSubtotal;
        for (let attempt = 0; attempt < 12; attempt++) {
          await page.waitForTimeout(500);
          try {
            newSubtotal = await getCartSubtotal();
            if (newSubtotal !== oldSubtotal) break;
          } catch(_) {
            // Page navigated — wait for it to settle and retry once
            await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
            newSubtotal = await getCartSubtotal().catch(() => oldSubtotal);
            break;
          }
        }

        // Check for max qty error message
        const hitLimit = await hasMaxQtyError();
        if (hitLimit) {
          log('TC-06 Updates[] Checks', `Qty limit hit for product at qty=${targetQty}`,
            'INFO', 'Maximum quantity error detected — will try alternate products');
          return { changed: false, hitLimit: true };
        }

        return { changed: newSubtotal !== oldSubtotal, hitLimit: false, newSubtotal };
      };

      // ─────────────────────────────────────────────────────────────────────
      // 7a: Single product, qty 1 → 3
      // ─────────────────────────────────────────────────────────────────────
      await clearCart();
      await safeGoto(productUrl, 'product (TC-06a)');
      await clickAddToCart(page);
      await safeGoto(cartUrl, 'cart (TC-06a)');
      await closePopups();
      await waitForRouteWidget(page, 6000);
      await page.waitForTimeout(1000);

      const sub6a_before = await getCartSubtotal();
      log('TC-06 Updates[] Checks', 'Qty=1 subtotal captured', 'INFO', `Subtotal: $${sub6a_before.toFixed(2)}`);

      const qtyResult6a = await tryIncreaseQty(3);

      if (qtyResult6a.hitLimit) {
        // Try to find another product that allows qty increase
        log('TC-06 Updates[] Checks', 'Looking for alternate product without qty limit', 'INFO', '');
        let foundAlternate = false;
        const allCandidates = await collectProductLinks();
        for (const altUrl of allCandidates) {
          if (altUrl === productUrl || altUrl === productUrl2) continue;
          try {
            await safeGoto(altUrl, 'alternate product (TC-06)');
            await closePopups();
            await page.waitForTimeout(1000);
            const addable = await isProductAddable(page);
            if (!addable) continue;
            const added = await clickAddToCart(page);
            if (!added) continue;
            await safeGoto(cartUrl, 'cart with alternate product (TC-06)');
            await closePopups();
            await waitForRouteWidget(page, 5000);
            await page.waitForTimeout(1000);
            const altQtyResult = await tryIncreaseQty(3);
            if (!altQtyResult.hitLimit && altQtyResult.changed) {
              log('TC-06 Updates[] Checks', `Using alternate product for qty test`, 'INFO', altUrl);
              foundAlternate = true;
              await waitForRouteWidget(page, 3000);
              const sub6a_after = await getCartSubtotal();
              await snap();
              log('TC-06 Updates[] Checks', 'Subtotal updated after qty change', sub6a_after !== sub6a_before ? 'PASS' : 'WARN',
                `Subtotal: $${sub6a_after.toFixed(2)}`);
              await checkoutAndVerifyRoute('Single product qty=3 (alternate)', 'TC-06a');
              foundAlternate = true;
              break;
            }
          } catch (_) {}
        }
        if (!foundAlternate) {
          log('TC-06 Updates[] Checks', 'Single product qty increase — all products hit max qty limit', 'WARN',
            'Could not test qty increase — all checked products have qty restrictions');
        }
      } else if (qtyResult6a.changed) {
        await waitForRouteWidget(page, 3000);
        const sub6a_after = await getCartSubtotal();
        await snap();
        log('TC-06 Updates[] Checks', 'Subtotal updated after qty change to 3', sub6a_after > sub6a_before ? 'PASS' : 'WARN',
          `Before: $${sub6a_before.toFixed(2)} → After: $${sub6a_after.toFixed(2)}`);
        await checkoutAndVerifyRoute('Single product qty=3', 'TC-06a');
      } else {
        log('TC-06 Updates[] Checks', 'Qty change (1→3)', 'WARN', 'Subtotal did not change after qty update — cart may not have updated');
      }

      // ─────────────────────────────────────────────────────────────────────
      // 7b: Multiple products, qty increase
      // ─────────────────────────────────────────────────────────────────────
      if (productUrl2) {
        await clearCart();
        await safeGoto(productUrl, 'product 1 (TC-06b)');
        await clickAddToCart(page);
        await safeGoto(productUrl2, 'product 2 (TC-06b)');
        await clickAddToCart(page);
        await safeGoto(cartUrl, 'cart (TC-06b)');
        await closePopups();
        await waitForRouteWidget(page, 6000);
        await page.waitForTimeout(1000);

        const sub6b_before = await getCartSubtotal();
        log('TC-06 Updates[] Checks', 'Multi-product subtotal captured', 'INFO', `Subtotal: $${sub6b_before.toFixed(2)}`);

        const qtyResult6b = await tryIncreaseQty(2);
        if (!qtyResult6b.hitLimit && qtyResult6b.changed) {
          await waitForRouteWidget(page, 3000);
          const sub6b_after = await getCartSubtotal();
          await snap();
          log('TC-06 Updates[] Checks', 'Multi-product subtotal updated after qty change',
            sub6b_after > sub6b_before ? 'PASS' : 'WARN',
            `Before: $${sub6b_before.toFixed(2)} → After: $${sub6b_after.toFixed(2)}`);
          await checkoutAndVerifyRoute('Multiple products qty increase', 'TC-06b');
        } else if (qtyResult6b.hitLimit) {
          log('TC-06 Updates[] Checks', 'Multiple products qty increase — limit hit', 'WARN',
            'Product has qty restriction — verify manually with a product that allows higher quantities');
        } else {
          log('TC-06 Updates[] Checks', 'Multiple products qty change', 'WARN', 'Subtotal did not update');
        }
      } else {
        log('TC-06 Updates[] Checks', 'Multiple products test', 'WARN', 'Only one addable product found — skipped TC-06b');
      }
    } else {
      log('TC-06 Updates[] Checks', 'Quantity change checks', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('8 · TC-08: Route Disappears with Digital-Only Cart');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    {
      await clearCart();
      const giftCardData = await page.evaluate(async () => {
        // Method 1: query by product_type=Gift+Card
        try {
          const r = await fetch('/products.json?product_type=Gift+Card&limit=5');
          const d = r.ok ? await r.json() : null;
          if (d?.products?.length) {
            for (const p of d.products) {
              // Confirm this is actually a digital product via /products/<handle>.js
              try {
                const pjson = await fetch(`/products/${p.handle}.js`);
                if (pjson.ok) {
                  const pdata = await pjson.json();
                  // Must be gift_card OR requires_shipping === false on all variants
                  const isDigital = pdata.gift_card === true ||
                    (pdata.variants || []).every(v => v.requires_shipping === false);
                  if (isDigital) {
                    const v = pdata.variants?.[0];
                    return v ? { id: v.id, title: pdata.title } : null;
                  }
                }
              } catch(_) {}
            }
          }
        } catch(_) {}
        // Method 2: try common gift card URL slugs and verify
        for (const slug of ['gift-card', 'gift-cards', 'e-gift-card', 'giftcard', 'gift_card']) {
          try {
            const r = await fetch(`/products/${slug}.js`);
            if (r.ok) {
              const p = await r.json();
              const isDigital = p.gift_card === true ||
                (p.variants || []).every(v => v.requires_shipping === false);
              if (isDigital && p.variants?.[0]) {
                return { id: p.variants[0].id, title: p.title };
              }
            }
          } catch(_) {}
        }
        return null;
      });

      if (giftCardData?.id) {
        await addProductToCartApi(giftCardData.id);
        await safeGoto(cartUrl, 'cart (digital only)');
        await closePopups();
        await waitForRouteWidget(page, 6000);
        await page.waitForTimeout(1500);
        const widgetDigital = await findRouteWidget(page);
        await snapLog('TC-08 Digital-Only Cart', `Route widget absent for digital-only cart ("${giftCardData.title}")`,
          !widgetDigital.visible ? 'PASS' : 'FAIL',
          widgetDigital.visible ? 'Route widget is showing for digital-only cart — should be hidden' :
          'Route widget correctly hidden for digital-only cart', 'TC-08');
      } else {
        log('TC-08 Digital-Only Cart', 'Digital product / gift card test', 'WARN',
          'No gift card product found on this store — verify manually');
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('9 · TC-09: Physical + Digital — Premium on Physical Only');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {
      await clearCart();
      await safeGoto(productUrl, 'product (TC-09)');
      await clickAddToCart(page);
      const cartPhysical = await page.evaluate(async () => { const r = await fetch('/cart.js'); return r.ok ? r.json() : null; });
      const physicalSubtotal = (cartPhysical?.items||[])
        .filter(i => !/route/i.test(i.title) && i.requires_shipping !== false)
        .reduce((s,i) => s + i.line_price, 0) / 100;

      // Try to add a digital item
      const giftCardData2 = await page.evaluate(async () => {
        for (const slug of ['gift-card','gift-cards','e-gift-card','giftcard']) {
          try { const r = await fetch(`/products/${slug}.js`); if(r.ok){const p=await r.json();return{id:p.variants[0]?.id};} } catch(_){}
        }
        return null;
      });

      if (giftCardData2?.id) {
        await addProductToCartApi(giftCardData2.id);
        await safeGoto(cartUrl, 'cart (TC-09)');
        await closePopups();
        await waitForRouteWidget(page, 6000);
        await page.waitForTimeout(1500);
        const widgetMixed = await findRouteWidget(page);
        const priceMatch = widgetMixed.text?.match(/\$\s*([\d.]+)/);
        if (priceMatch && physicalSubtotal > 0) {
          const shown = parseFloat(priceMatch[1]);
          const rate = physicalSubtotal <= (RATES.tier1Max||100) ? (RATES.tier1Rate||1.95) : (RATES.tier2Rate||2.5);
          const expected = (RATES.tier1Format === 'flat' && physicalSubtotal <= (RATES.tier1Max||100)) ? rate : physicalSubtotal * (rate/100);
          const diff = Math.abs(shown - expected);
          await snap();
          log('TC-09 Physical+Digital Premium', 'Premium calculated on physical subtotal only',
            diff <= 0.15 ? 'PASS' : 'FAIL',
            `Physical subtotal: $${physicalSubtotal.toFixed(2)} | Expected: $${expected.toFixed(2)} | Shown: $${shown.toFixed(2)}${diff>0.15?' ← MISMATCH':''}`,
            'TC-09');
        } else {
          log('TC-09 Physical+Digital Premium', 'Premium on physical only', 'WARN',
            physicalSubtotal === 0 ? 'Physical subtotal is $0' : 'Could not parse premium from widget text');
        }
      } else {
        log('TC-09 Physical+Digital Premium', 'Physical+Digital premium test', 'WARN', 'No gift card found to add as digital item');
      }
    } else {
      log('TC-09 Physical+Digital Premium', 'Physical+Digital premium test', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('10 · TC-10: Route Product Auto-Removed from Cart');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {
      await clearCart();
      await safeGoto(productUrl, 'product (TC-10)');
      await clickAddToCart(page);
      await safeGoto(cartUrl, 'cart (TC-10)');
      await waitForRouteWidget(page, 6000);
      const countBefore = await getRouteLineItemCount(page);

      // Remove all physical items
      await page.evaluate(async () => {
        const cartData = await (await fetch('/cart.js')).json();
        const updates = {};
        for (const item of cartData.items) {
          if (!/route/i.test(item.title) && item.vendor !== 'Route') updates[item.key] = 0;
        }
        if (Object.keys(updates).length) {
          await fetch('/cart/update.js', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({updates}) });
        }
      });
      await page.waitForTimeout(1500);
      await safeGoto(cartUrl, 'cart after removing physical (TC-10)');
      await page.waitForTimeout(1500);

      const countAfter = await getRouteLineItemCount(page);
      await snap();
      log('TC-10 Route Auto-Removed', 'Route removed when no eligible physical items remain',
        countAfter === 0 ? 'PASS' : 'FAIL',
        countBefore > 0 && countAfter === 0 ? 'Route correctly auto-removed after physical items removed' :
        countAfter > 0 ? 'Route still in cart after physical items removed' :
        'Route was not in cart before test', 'TC-10');
    } else {
      log('TC-10 Route Auto-Removed', 'Route auto-removed test', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('11 · TC-11 + TC-12: Not on Storefront & Collections');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    // TC-11: Route product not browsable on storefront
    const collectionsUrl = new URL('/collections/all?sort_by=price-ascending', BASE_URL).href;
    await safeGoto(collectionsUrl, 'collections (TC-11)');
    await page.waitForTimeout(1500);
    const routeInColl = await page.evaluate(() => {
      const cards = document.querySelectorAll('a[href*="/products/"], [class*="product-card"], [class*="product-item"]');
      for (const c of cards) {
        if (/route/i.test(c.textContent) && /(protection|package|shipping)/i.test(c.textContent)) return true;
      }
      return false;
    });
    await snap();
    log('TC-11+12 Storefront Visibility', 'Route product NOT visible in /collections/all',
      !routeInColl ? 'PASS' : 'FAIL',
      !routeInColl ? 'Route not found in collections' : 'Route product visible in storefront collections!',
      'TC-11');

    // TC-12: Not in recommendations
    if (productUrl) {
      await safeGoto(productUrl, 'product (rec check)');
      await page.waitForTimeout(1000);
      const routeInRecs = await page.evaluate(() => {
        const recs = document.querySelectorAll('[class*="recommend"], [class*="related"], [class*="upsell"], [class*="suggestion"]');
        for (const r of recs) {
          if (/route/i.test(r.textContent)) return true;
        }
        return false;
      });
      await snap();
      log('TC-11+12 Storefront Visibility', 'Route product NOT in product page recommendations',
        !routeInRecs ? 'PASS' : 'FAIL',
        !routeInRecs ? 'Route not found in recommendations' : 'Route found in product page recommendations!',
        'TC-12');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('12 · TC-13+14: Value Prop & Info Modal');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {
      await clearCart();
      await safeGoto(productUrl, 'product (TC-13)');
      await clickAddToCart(page);
      await safeGoto(cartUrl, 'cart (TC-13)');
      await waitForRouteWidget(page, 6000);
      await page.waitForTimeout(1500);

      // For Preferred Checkout: value prop is the bar above the checkout button
      // showing "Your order is protected for $X.XX" — scan full page text
      const valuePropResult = await page.evaluate(() => {
        const text = document.body.innerText || '';
        // Match "Order protected for $X" / "Your order is protected for $X"
        const m = text.match(/(?:your\s+)?order\s+(?:is\s+)?protected\s+for\s+\$([\d.]+)/i)
               || text.match(/protected\s+for\s+\$([\d.]+)/i)
               || text.match(/order\s+protected\s+\$([\d.]+)/i);
        return { found: !!m, amount: m ? m[1] : null, snippet: text.slice(0,300).replace(/\s+/g,' ') };
      });
      await snap();
      log('TC-13 Value Prop', 'Widget shows "Order protected for $[amount]"',
        valuePropResult.found ? 'PASS' : 'WARN',
        valuePropResult.found
          ? `✓ Value prop text found: "Order protected for $${valuePropResult.amount}"`
          : 'Could not detect "Order protected for $X" on cart page — verify the Preferred Checkout widget is loaded');

      // Try clicking info icon for expand check
      const infoIconSelectors = [
        '[id*="route"] button[type="button"]', '[class*="route"] [class*="info"]',
        '[class*="route"] button', '[id*="route"] [class*="tooltip"]',
        '[class*="route-widget"] button', 'route-widget button',
      ];
      let infoClicked = false;
      for (const sel of infoIconSelectors) {
        const el = await page.$(sel);
        if (el) {
          try { await el.click({ timeout: 3000 }); infoClicked = true; break; } catch(_) {}
        }
      }
      if (infoClicked) {
        await page.waitForTimeout(800);
        const expanded = await page.evaluate(() => {
          const text = document.body.innerText;
          return /benefits|package protection|damage.*loss|fast refund|see details/i.test(text);
        });
        await snap();
        log('TC-13 Value Prop', 'Value prop expands and shows benefits content',
          expanded ? 'PASS' : 'WARN',
          expanded ? 'BENEFITS section visible after clicking info icon' : 'Could not verify expansion content — check manually');
      } else {
        log('TC-13 Value Prop', 'Value prop expand / info icon', 'WARN', 'Info icon not found — verify manually');
      }

      // TC-14: Route info modal
      const seeDetailsEl = await page.evaluateHandle(() => {
        const all = Array.from(document.querySelectorAll('a, button, span'));
        return all.find(el => /see details/i.test(el.innerText || el.textContent));
      });
      if (seeDetailsEl && await seeDetailsEl.evaluate(el => !!el)) {
        try {
          await seeDetailsEl.click();
          await page.waitForTimeout(1000);
          const modalContent = await page.evaluate(() => {
            const text = document.body.innerText;
            return {
              hasCovered: /we.*got you covered|shipping protection/i.test(text),
              hasBullets: /instant issue|24.*7.*claim|shipping protection/i.test(text),
              hasLinks:   /file a claim|user privacy|terms of service/i.test(text),
            };
          });
          await snap();
          log('TC-14 Route Info Modal', 'Info modal opens with correct content',
            (modalContent.hasCovered && modalContent.hasBullets) ? 'PASS' : 'WARN',
            `"We've got you covered": ${modalContent.hasCovered} | Bullets: ${modalContent.hasBullets} | Links: ${modalContent.hasLinks}`);
        } catch(e) {
          log('TC-14 Route Info Modal', 'Info modal', 'WARN', 'Could not interact with See Details — verify manually');
        }
      } else {
        log('TC-14 Route Info Modal', 'Info modal — "See Details" link', 'WARN', '"See Details" not found — verify manually');
      }
    } else {
      log('TC-13+14 Value Prop & Modal', 'Value prop and modal checks', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('13 · TC-15: BFCache Check');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {
      await clearCart();
      await safeGoto(productUrl, 'product (BFCache)');
      await clickAddToCart(page);
      await safeGoto(cartUrl, 'cart (BFCache)');
      await waitForRouteWidget(page, 6000);
      await page.waitForTimeout(1500);

      const routeBefore = await getRouteLineItemCount(page);
      if (routeBefore > 0) {
        // Navigate to checkout
        const checkoutBtn = await page.$('button[name="checkout"], input[name="checkout"], a[href*="/checkout"]');
        if (checkoutBtn) {
          await checkoutBtn.click();
          await page.waitForTimeout(3000);
          if (/checkout|checkouts/i.test(page.url())) {
            // Go back
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
            await page.waitForTimeout(5000); // wait for BFCache handler to fire
            const routeAfter = await getRouteLineItemCount(page);
            await snap();
            log('TC-15 BFCache', 'Route item removed after browser back navigation from checkout',
              routeAfter === 0 ? 'PASS' : 'FAIL',
              routeAfter === 0 ? 'BFCache handler fired correctly — Route removed after back navigation' :
              `Route still in cart (${routeAfter} item(s)) after back navigation — BFCache handler may not be installed`,
              'TC-15');
          } else {
            log('TC-15 BFCache', 'BFCache test', 'WARN', 'Did not reach checkout for BFCache test');
          }
        } else {
          log('TC-15 BFCache', 'BFCache test', 'WARN', 'No checkout button found for BFCache test');
        }
      } else {
        log('TC-15 BFCache', 'BFCache test', 'WARN', 'Route not in cart before BFCache test');
      }
    } else {
      log('TC-15 BFCache', 'BFCache check', 'WARN', 'No product URL found');
    }

    // ════════════════════════════════════════════════════════════════════════
    sectionHeader('14 · Design Checks (Non-Functional)');
    await testGap(2000);
    // ════════════════════════════════════════════════════════════════════════
    if (productUrl) {
      await clearCart();
      await safeGoto(productUrl, 'product (design)');
      await clickAddToCart(page);

      // Mobile alignment — temporarily shrink viewport for mobile check
      await page.setViewportSize({ width: 390, height: 844 });
      await safeGoto(cartUrl, 'cart (mobile design)');
      await waitForRouteWidget(page, 6000);
      const mobileWidget = await findRouteWidget(page);
      if (mobileWidget.found) {
        await snap();
        log('Design', 'Widget not overflowing mobile viewport (375px)',
          mobileWidget.right <= 390 ? 'PASS' : 'FAIL',
          mobileWidget.right > 390 ? `Widget extends to ${Math.round(mobileWidget.right)}px` : 'Fits within 375px viewport');
      } else {
        log('Design', 'Widget visible on mobile (375px)', 'WARN', 'Widget not found at mobile width');
      }
      await page.setViewportSize({ width: 1440, height: 900 }); // restore to desktop size
    }

  } catch (err) {
    console.error('\n❌  Fatal error during QA run:', err.message);
    await snap();
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

  // Send full report data + done event to the dashboard
  sseEmit('report', { pass, fail, warn, duration, results, siteUrl });
  sseEmit('done',   { pass, fail, warn, duration });
  await new Promise(r => setTimeout(r, 3000));
  if (_liveServer) _liveServer.close();
}

// ── Entry Point ────────────────────────────────────────────────────────────
// Start server → open browser → wait for UI config submission → run QA
(async () => {
  try {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║           Route Integration — QA Runner                  ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const uiConfigPromise = startLiveServer();

    // Wait for the UI to submit config via POST /start
    const uiConfig = await uiConfigPromise;

    // Strip markdown link format if pasted: [text](url) → url
    let rawUrl = uiConfig.url || BASE_URL;
    const mdMatch = rawUrl.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
    if (mdMatch) rawUrl = mdMatch[1];
    if (!rawUrl.startsWith('http')) rawUrl = 'https://' + rawUrl;
    BASE_URL = rawUrl;
    HEADLESS = uiConfig.headless || false;

    // Build RATES from UI config
    const rates = {
      tier1Max:      parseFloat(uiConfig.tier1Max)   || 100,
      tier1Rate:     parseFloat(uiConfig.tier1Rate)  || 1.95,
      tier1Format:   uiConfig.tier1Format || 'pct',
      tier1PaidBy:   uiConfig.tier1PaidBy || 'customer',
      tier1Default:  uiConfig.tier1Default || 'on',
      tier2Rate:     parseFloat(uiConfig.tier2Rate)  || 2.5,
      tier2Format:   uiConfig.tier2Format || 'pct',
      tier2PaidBy:   uiConfig.tier2PaidBy || 'customer',
      tier2Default:  uiConfig.tier2Default || 'off',
      tier2Max:      parseFloat(uiConfig.tier2Max)   || 5000,
      coverageLimit: parseFloat(uiConfig.coverageLimit) || 5000,
      isDynamic:     uiConfig.rateType === 'dynamic',
      cartWidget:    uiConfig.cartWidget || '',
      checkoutWidget: uiConfig.checkoutWidget || '',
      platform:      uiConfig.platform || 'shopify',
      merchant:      uiConfig.merchant || '',
      sitePassword:  uiConfig.sitePassword || '',
    };

    console.log(`  🌐  Site: ${BASE_URL}`);
    console.log(`  🏪  Merchant: ${rates.merchant}`);
    console.log(`  🛒  Cart widget: ${rates.cartWidget}`);
    console.log(`  💳  Checkout widget: ${rates.checkoutWidget}`);
    console.log(`  👁   Browser: ${HEADLESS ? 'headless' : 'visible'}\n`);

    sseEmit('start', { url: BASE_URL, merchant: rates.merchant });
    await new Promise(r => setTimeout(r, 1500)); // wait for browser SSE connection

    await runQA(rates);
  } catch (err) {
    console.error('Unhandled error:', err);
    process.exit(1);
  }
})();
