/**
 * Gas Bill Fetcher — Browser Extension Agent
 * background.js (Manifest V3 Service Worker)
 *
 * يتصل بالسيرفر عبر WebSocket ويستخرج بيانات الفواتير
 * من موقع بيتروتريد مباشرةً من متصفحك داخل مصر.
 */

const WS_URL = 'wss://gas-bill-fetcher.onrender.com/api/agent/ws';

let ws = null;

// ── Keepalive: keep the service worker alive & ping every 24s ────────────
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!ws || ws.readyState > 1) {
    connect();
  } else if (ws.readyState === 1) {
    try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Wait for a tab to reach status="complete".
 * If requireNavigation=true, also wait for a status="loading" first
 * (so we don't resolve immediately on an already-loaded page).
 */
function waitForTabLoad(tabId, { requireNavigation = false, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let sawLoading = false;

    const done = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete') {
        if (!requireNavigation || sawLoading) done();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, timeout);

    // Immediately resolve if tab already loaded and we don't require navigation
    if (!requireNavigation) {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        if (tab?.status === 'complete') done();
      });
    }
  });
}

/** Run a function inside the tab's page context (MAIN world = full DOM access) */
async function exec(tabId, fn, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: fn,
      args,
      world: 'MAIN'
    });
    return results?.[0]?.result ?? null;
  } catch (e) {
    console.warn('[GasBillAgent] executeScript error:', e.message);
    return null;
  }
}

// ── WebSocket connection ───────────────────────────────────────────────────
function connect() {
  if (ws && ws.readyState < 2) return; // CONNECTING or OPEN — skip
  try {
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('[GasBillAgent] ✅ Connected to server');
      chrome.storage.local.set({ status: 'connected', connectedAt: Date.now() });
    };

    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch (_) {}
    };

    ws.onclose = () => {
      console.log('[GasBillAgent] Disconnected — retrying in 5s');
      chrome.storage.local.set({ status: 'disconnected' });
      ws = null;
      setTimeout(connect, 5000);
    };

    ws.onerror = () => { /* close will fire */ };

  } catch (e) {
    console.error('[GasBillAgent] Connect error:', e.message);
    setTimeout(connect, 10000);
  }
}

function onMessage(msg) {
  if (msg.type === 'ping') {
    send({ type: 'pong' });
  } else if (msg.type === 'scrape') {
    handleScrape(msg.taskId, msg.account).catch(err =>
      sendError(msg.taskId, err.message || String(err))
    );
  }
}

const send       = obj  => { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); };
const sendResult = (id, result)  => send({ type: 'scrape_result', taskId: id, result });
const sendError  = (id, message) => send({ type: 'scrape_error',  taskId: id, message });

// ══════════════════════════════════════════════════════════════════════════
// PAGE-INJECTED FUNCTIONS
// These run inside the petrotrade.com.eg tab. NO chrome.* APIs available.
// They must be self-contained (no closures over outer variables).
// ══════════════════════════════════════════════════════════════════════════

/** Click the "فاتورة الغاز" service link on the Petrotrade homepage */
function PAGE_clickGasLink() {
  const els = Array.from(document.querySelectorAll('a, button, td, li, span, [onclick]'));

  // Pass 1: exact match
  const exact = ['فاتورة الغاز', 'فاتوره الغاز'];
  for (const kw of exact) {
    for (const el of els) {
      if ((el.textContent || '').trim() === kw) { el.click(); return { ok: true, text: kw }; }
    }
  }

  // Pass 2: contains gas + invoice keyword
  for (const el of els) {
    const t = (el.textContent || '').trim();
    if (t.includes('الغاز') && (t.includes('فاتور') || t.includes('استعلام'))) {
      el.click(); return { ok: true, text: t };
    }
  }

  // Pass 3: href contains gas/invoice
  for (const el of document.querySelectorAll('a[href]')) {
    const h = el.getAttribute('href') || '';
    if (/gas|GAS|invoice/i.test(h)) { el.click(); return { ok: true, href: h }; }
  }

  // Pass 4: any <a> mentioning gas
  for (const el of els) {
    const t = (el.textContent || '').trim();
    if (t.includes('الغاز') && el.tagName === 'A') { el.click(); return { ok: true, text: t }; }
  }

  return { ok: false, body: document.body.innerText.slice(0, 400) };
}

/** Fill the 8-field account number form and submit */
function PAGE_fillAndSubmit(account) {
  const digits = account.replace(/\D/g, '').padEnd(16, '0').slice(0, 16);

  const inputs = Array.from(document.querySelectorAll(
    'input[type="text"], input[type="number"], input:not([type])'
  )).filter(el => {
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled && !el.readOnly;
  });

  if (!inputs.length) {
    return { ok: false, error: 'no-inputs', body: document.body.innerText.slice(0, 300) };
  }

  // Use the native value setter so React/Vue change-detection fires
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  const typeInto = (el, value) => {
    el.focus();
    if (nativeSetter) nativeSetter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));

    for (const ch of value) {
      el.dispatchEvent(new KeyboardEvent('keydown',  { key: ch, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
      if (nativeSetter) nativeSetter.call(el, el.value + ch);
      else el.value += ch;
      el.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup',   { key: ch, bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  };

  if (inputs.length >= 8) {
    // 8 separate fields × 2 digits each (auto-tab form)
    for (let i = 0; i < 8; i++) {
      typeInto(inputs[i], digits.slice(i * 2, i * 2 + 2));
    }
  } else {
    typeInto(inputs[0], digits);
  }

  // Submit
  const btn = document.querySelector('button[type="submit"], input[type="submit"]');
  if (btn) { btn.click(); return { ok: true, method: 'submit-btn' }; }

  const lastInput = inputs[Math.min(7, inputs.length - 1)];
  lastInput.focus();
  ['keydown', 'keypress', 'keyup'].forEach(type =>
    lastInput.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', keyCode: 13, bubbles: true }))
  );
  const form = lastInput.closest('form');
  if (form) { try { form.submit(); } catch (_) {} }

  return { ok: true, method: 'enter-key' };
}

/** Click the "فاتورة" details tab (appears after account lookup) */
function PAGE_clickInvoiceTab() {
  for (const el of document.querySelectorAll('button, a, [role="tab"], li, span')) {
    if ((el.textContent || '').includes('فاتور')) { el.click(); return true; }
  }
  return false;
}

/** Pick the most recent entry from a month selector / list */
function PAGE_handleMonthSelector() {
  const sel = document.querySelector('select');
  if (sel?.options.length) {
    sel.value = sel.options[0].value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'select';
  }
  for (const row of document.querySelectorAll('table tbody tr')) {
    if (/\d{4}/.test(row.textContent || '')) { row.click(); return 'row'; }
  }
  return 'none';
}

/**
 * Extract invoice data using 3 strategies:
 *   A — header-row + data-row detection
 *   B — label-adjacent cell scan
 *   C — full body-text regex (last resort)
 */
function PAGE_extractData() {
  let c = null, cr = null, ab = null, amt = null, month = null;
  const mRe = /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر/;

  // ── Strategy A: header row + next data row ────────────────────────────
  try {
    const rows = Array.from(document.querySelectorAll('table tr'));
    const hMap = { 'الاستهلاك': 'c', 'تسوية': 'cr', 'رصيد': 'ab', 'القيمة': 'amt', 'شهر': 'month' };
    const ci = {};
    let hi = -1;

    for (let i = 0; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll('th, td'));
      if (cells.length < 3) continue;
      const ts = cells.map(x => x.innerText.trim());
      const found = {};
      for (const [kw, f] of Object.entries(hMap)) {
        const idx = ts.findIndex(t => t.includes(kw));
        if (idx !== -1) found[f] = idx;
      }
      if (Object.keys(found).length >= 2) { Object.assign(ci, found); hi = i; break; }
    }

    if (hi >= 0 && hi + 1 < rows.length) {
      const dt = Array.from(rows[hi + 1].querySelectorAll('td')).map(x => x.innerText.trim());
      const p = f => (ci[f] !== undefined && ci[f] < dt.length) ? dt[ci[f]] || null : null;
      c = p('c'); cr = p('cr'); ab = p('ab'); amt = p('amt'); month = p('month');
    }
  } catch (_) {}

  // ── Strategy B: label-adjacent cell scan ─────────────────────────────
  if (!c && !amt) {
    try {
      for (const row of document.querySelectorAll('table tr')) {
        const ts = Array.from(row.querySelectorAll('td')).map(x => x.innerText.trim());
        for (let i = 0; i < ts.length; i++) {
          const t = ts[i], next = ts[i + 1]?.match(/[\d,.]+/)?.[0] ?? null;
          if (/الاستهلاك/.test(t)              && !c)   c   = next;
          if (/تسوية/.test(t)                  && !cr)  cr  = next;
          if (/رصيد دفعات|دفعات مقدمة/.test(t) && !ab)  ab  = next;
          if (/القيمة/.test(t)                 && !amt) amt = next;
          if (mRe.test(t) && /\d{4}/.test(t)   && !month) month = t;
        }
      }
    } catch (_) {}
  }

  // ── Strategy C: full body-text regex ─────────────────────────────────
  if (!c && !amt) {
    try {
      const b = document.body.innerText;
      const m = re => b.match(re)?.[1]?.trim() ?? null;
      c   = c   ?? m(/الاستهلاك\s*[:：]?\s*([\d,.]+)/);
      cr  = cr  ?? m(/تسوية\s*مدين[ةه]\s*[:：]?\s*([\d,.]+)/);
      ab  = ab  ?? m(/رصيد\s*دفعات\s*مقدم[ةه]\s*[:：]?\s*([\d,.]+)/);
      amt = amt ?? m(/القيم[ةه]\s*[:：]?\s*([\d,.]+)/);
      const mm = b.match(/(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)\s*\d{4}/);
      if (mm && !month) month = mm[0];
    } catch (_) {}
  }

  return { consumption: c, creditAdjustment: cr, advanceBalance: ab, amount: amt, issueMonth: month };
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN SCRAPE ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════

async function handleScrape(taskId, account) {
  let tabId = null;
  try {
    // 1. Open a hidden background tab
    const tab = await new Promise(res => chrome.tabs.create({ url: 'about:blank', active: false }, res));
    tabId = tab.id;

    // Navigate to Petrotrade portal
    await new Promise(res => chrome.tabs.update(tabId, { url: 'https://www.petrotrade.com.eg/web/' }, res));
    await waitForTabLoad(tabId);
    await sleep(3000);

    // 2. Click the gas invoice service link
    //    Register nav-listener BEFORE clicking so we don't miss it
    const nav1 = waitForTabLoad(tabId, { requireNavigation: true });
    const clickRes = await exec(tabId, PAGE_clickGasLink);
    if (!clickRes?.ok) {
      throw new Error('رابط فاتورة الغاز غير موجود. ' + (clickRes?.body?.slice(0, 100) || ''));
    }
    await Promise.race([nav1, sleep(8000)]);
    await sleep(2000);

    // 3. Fill account number and submit
    const nav2 = waitForTabLoad(tabId, { requireNavigation: true });
    const fillRes = await exec(tabId, PAGE_fillAndSubmit, [account]);
    if (!fillRes?.ok) {
      throw new Error(fillRes?.error === 'no-inputs'
        ? 'لم يتم العثور على حقول إدخال رقم الحساب. ' + (fillRes?.body?.slice(0, 100) || '')
        : (fillRes?.error || 'فشل ملء رقم الحساب')
      );
    }
    await Promise.race([nav2, sleep(8000)]);
    await sleep(3000);

    // 4. Click "فاتورة" detail tab (optional)
    await exec(tabId, PAGE_clickInvoiceTab);
    await sleep(1500);

    // 5. Handle month/period selector (optional)
    await exec(tabId, PAGE_handleMonthSelector);
    await sleep(1500);

    // 6. Extract invoice data
    const data = await exec(tabId, PAGE_extractData);

    sendResult(taskId, {
      consumption:      data?.consumption      ?? null,
      creditAdjustment: data?.creditAdjustment ?? null,
      advanceBalance:   data?.advanceBalance   ?? null,
      amount:           data?.amount           ?? null,
      issueMonth:       data?.issueMonth       ?? null,
      status: 'success',
      error:  null
    });

  } catch (err) {
    sendError(taskId, err.message || String(err));
  } finally {
    if (tabId) chrome.tabs.remove(tabId, () => {});
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────
connect();
