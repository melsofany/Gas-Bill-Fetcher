// ==UserScript==
// @name         Gas Bill Fetcher Agent
// @namespace    https://gas-bill-fetcher.onrender.com
// @version      1.1
// @description  وكيل فاتورة الغاز — يتصل بالسيرفر ويجلب بيانات الفواتير تلقائياً دون التنقل بين الصفحات
// @author       Gas Bill Fetcher
// @match        https://www.petrotrade.com.eg/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const RENDER_WS = 'wss://gas-bill-fetcher.onrender.com/api/agent/ws';
  const BASE      = 'https://www.petrotrade.com.eg';

  // ── Status badge ────────────────────────────────────────────────────────
  const badge = Object.assign(document.createElement('div'), {
    style: [
      'position:fixed', 'bottom:14px', 'left:14px', 'z-index:2147483647',
      'padding:6px 14px', 'border-radius:20px', 'font-size:12px',
      'font-family:Arial,sans-serif', 'font-weight:bold', 'cursor:default',
      'box-shadow:0 2px 8px rgba(0,0,0,.35)', 'transition:background .3s',
      'color:#fff', 'background:#f59e0b', 'direction:rtl'
    ].join(';')
  });
  badge.textContent = '⚡ الوكيل: جاري الاتصال...';
  document.body.appendChild(badge);

  const setBadge = (ok, msg) => {
    badge.style.background = ok ? '#10b981' : '#f59e0b';
    badge.textContent = ok ? `⚡ الوكيل: متصل ✓` : `⚡ الوكيل: ${msg || 'جاري الاتصال...'}`;
  };

  // ── Helpers ─────────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /** Fetch a Petrotrade URL with credentials (same-origin — no CORS issues) */
  async function pt(url, opts = {}) {
    const r = await fetch(url.startsWith('http') ? url : BASE + url,
      { credentials: 'include', ...opts });
    if (!r.ok) throw new Error(`HTTP ${r.status} على ${url}`);
    return r;
  }

  /** Parse HTML text into a document */
  const parse = html => new DOMParser().parseFromString(html, 'text/html');

  /** Serialise a form's fields into URLSearchParams */
  function formBody(formEl, extraFields = {}) {
    const p = new URLSearchParams();
    for (const el of formEl.elements) {
      if (!el.name) continue;
      if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
      if (el.type === 'submit') continue;
      p.append(el.name, el.value);
    }
    for (const [k, v] of Object.entries(extraFields)) {
      if (v !== undefined) p.set(k, v);
    }
    return p.toString();
  }

  // ── Data extraction ──────────────────────────────────────────────────────
  function extractFromDoc(doc) {
    let c = null, cr = null, ab = null, amt = null, month = null;
    const mRe = /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر/;

    // Strategy A: header row + data row
    try {
      const rows = Array.from(doc.querySelectorAll('table tr'));
      const hMap = { 'الاستهلاك': 'c', 'تسوية': 'cr', 'رصيد': 'ab', 'القيمة': 'amt', 'شهر': 'month' };
      const ci = {}; let hi = -1;
      for (let i = 0; i < rows.length; i++) {
        const cells = Array.from(rows[i].querySelectorAll('th,td'));
        if (cells.length < 3) continue;
        const ts = cells.map(x => x.textContent.trim());
        const found = {};
        for (const [kw, f] of Object.entries(hMap)) {
          const idx = ts.findIndex(t => t.includes(kw));
          if (idx !== -1) found[f] = idx;
        }
        if (Object.keys(found).length >= 2) { Object.assign(ci, found); hi = i; break; }
      }
      if (hi >= 0 && hi + 1 < rows.length) {
        const dt = Array.from(rows[hi + 1].querySelectorAll('td')).map(x => x.textContent.trim());
        const p = f => (ci[f] !== undefined && ci[f] < dt.length) ? dt[ci[f]] || null : null;
        c = p('c'); cr = p('cr'); ab = p('ab'); amt = p('amt'); month = p('month');
      }
    } catch (_) {}

    // Strategy B: label-adjacent cells
    if (!c && !amt) {
      try {
        for (const row of doc.querySelectorAll('table tr')) {
          const ts = Array.from(row.querySelectorAll('td')).map(x => x.textContent.trim());
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

    // Strategy C: full-text regex
    if (!c && !amt) {
      try {
        const b = doc.body.innerText || doc.body.textContent || '';
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

  // ── Core scraping via fetch (no page navigation — WS stays alive) ───────
  async function scrapeAccount(accountNumber) {
    const digits = accountNumber.replace(/\D/g, '').padEnd(16, '0').slice(0, 16);

    // ── Step 1: load homepage ──────────────────────────────────────────────
    const homeResp = await pt('/web/');
    const homeHtml = await homeResp.text();
    const homeDoc  = parse(homeHtml);

    // ── Step 2: find gas invoice link ──────────────────────────────────────
    let gasUrl = null;
    const gasKwds = ['فاتورة الغاز', 'فاتوره الغاز'];
    for (const el of homeDoc.querySelectorAll('a, button, [onclick]')) {
      const t = (el.textContent || '').trim();
      if (gasKwds.some(kw => t === kw || t.startsWith(kw))) {
        gasUrl = el.getAttribute('href') || null; break;
      }
    }
    if (!gasUrl) {
      for (const el of homeDoc.querySelectorAll('a, button, [onclick]')) {
        const t = (el.textContent || '').trim();
        if (t.includes('الغاز') && (t.includes('فاتور') || t.includes('استعلام'))) {
          gasUrl = el.getAttribute('href') || null; break;
        }
      }
    }
    if (!gasUrl) {
      for (const el of homeDoc.querySelectorAll('a[href]')) {
        if (/gas|GAS|invoice/i.test(el.getAttribute('href') || '')) {
          gasUrl = el.getAttribute('href'); break;
        }
      }
    }
    if (!gasUrl) {
      const bodyText = homeDoc.body.textContent?.slice(0, 400) || '';
      throw new Error('لم يتم العثور على رابط فاتورة الغاز في الصفحة الرئيسية. نص الصفحة: ' + bodyText);
    }

    // Make URL absolute
    if (!gasUrl.startsWith('http')) {
      gasUrl = new URL(gasUrl, homeResp.url).href;
    }

    // ── Step 3: load gas invoice form page ────────────────────────────────
    const gasResp = await pt(gasUrl);
    const gasHtml = await gasResp.text();
    const gasDoc  = parse(gasHtml);

    const form = gasDoc.querySelector('form');
    if (!form) throw new Error('لم يتم العثور على نموذج الإدخال في صفحة الغاز');

    // ── Step 4: build form data with account number ────────────────────────
    const visibleInputs = Array.from(form.querySelectorAll(
      'input[type="text"], input[type="number"], input:not([type])'
    )).filter(el => el.type !== 'hidden');

    // Fill in the account number across fields
    const extraFields = {};
    if (visibleInputs.length >= 8) {
      for (let i = 0; i < 8 && i < visibleInputs.length; i++) {
        const n = visibleInputs[i].name;
        if (n) extraFields[n] = digits.slice(i * 2, i * 2 + 2);
      }
    } else if (visibleInputs.length > 0) {
      const n = visibleInputs[0].name;
      if (n) extraFields[n] = digits;
    }

    // Add submit button
    const submitBtn = form.querySelector('input[type="submit"], button[type="submit"]');
    if (submitBtn?.name) extraFields[submitBtn.name] = submitBtn.value || 'submit';

    const body = formBody(form, extraFields);

    // Determine form action and method
    const action = form.action
      ? (form.action.startsWith('http') ? form.action : new URL(form.action, gasResp.url).href)
      : gasResp.url;
    const method = (form.method || 'POST').toUpperCase();

    // ── Step 5: submit and read result ────────────────────────────────────
    const submitResp = await pt(action, {
      method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': gasResp.url
      },
      body
    });

    let resultDoc = parse(await submitResp.text());

    // ── Step 6: click "فاتورة" tab (simulate via fetch if link present) ──
    for (const el of resultDoc.querySelectorAll('a')) {
      if ((el.textContent || '').includes('فاتور')) {
        const tabHref = el.getAttribute('href');
        if (tabHref) {
          const tabUrl = tabHref.startsWith('http') ? tabHref : new URL(tabHref, submitResp.url).href;
          try {
            const tabResp = await pt(tabUrl);
            resultDoc = parse(await tabResp.text());
          } catch (_) {}
        }
        break;
      }
    }

    // ── Step 7: handle month selector (pick first option via fetch if link) ──
    const monthSelect = resultDoc.querySelector('select');
    if (monthSelect?.options.length) {
      const optForm = monthSelect.closest('form') || form;
      const optVal  = monthSelect.options[0].value;
      if (optVal) {
        const extraOpt = {};
        if (monthSelect.name) extraOpt[monthSelect.name] = optVal;
        const submitOpt = optForm.querySelector('input[type="submit"], button[type="submit"]');
        if (submitOpt?.name) extraOpt[submitOpt.name] = submitOpt.value || 'submit';
        const optBody    = formBody(optForm, extraOpt);
        const optAction  = optForm.action
          ? (optForm.action.startsWith('http') ? optForm.action : new URL(optForm.action, submitResp.url).href)
          : submitResp.url;
        try {
          const optResp = await pt(optAction, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': submitResp.url },
            body: optBody
          });
          resultDoc = parse(await optResp.text());
        } catch (_) {}
      }
    }

    return extractFromDoc(resultDoc);
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  let ws = null;

  function connect() {
    if (ws && ws.readyState < 2) return;
    try {
      ws = new WebSocket(RENDER_WS);
      ws.onopen  = () => setBadge(true);
      ws.onclose = () => { setBadge(false, 'جاري إعادة الاتصال...'); ws = null; setTimeout(connect, 5000); };
      ws.onerror = () => {};
      ws.onmessage = async e => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'scrape') {
            try {
              const data = await scrapeAccount(msg.account);
              ws.send(JSON.stringify({
                type: 'scrape_result', taskId: msg.taskId,
                result: { ...data, status: 'success', error: null }
              }));
            } catch (err) {
              ws.send(JSON.stringify({
                type: 'scrape_error', taskId: msg.taskId,
                message: err.message || String(err)
              }));
            }
          }
        } catch (_) {}
      };
    } catch (_) { setTimeout(connect, 10000); }
  }

  // Keepalive ping every 20s
  setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'pong' })); }, 20000);

  connect();
})();
