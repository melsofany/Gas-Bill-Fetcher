/**
 * وكيل بيتروتريد المحلي
 * يشتغل على جهازك داخل مصر ويتصل بالسيرفر عبر WebSocket
 * يقوم بالاستخراج الفعلي من بيتروتريد محلياً
 *
 * الاستخدام:
 *   node index.mjs --server wss://your-app.replit.app
 *   أو
 *   SERVER_URL=wss://your-app.replit.app node index.mjs
 */

import { WebSocket } from "ws";
import { chromium } from "playwright";

// ─── إعداد رابط السيرفر ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const serverFlagIdx = args.indexOf("--server");
const serverUrl =
  serverFlagIdx !== -1
    ? args[serverFlagIdx + 1]
    : process.env.SERVER_URL;

if (!serverUrl) {
  console.error("❌  يرجى تحديد رابط السيرفر:");
  console.error("   node index.mjs --server wss://your-app.replit.app");
  console.error("   أو: SERVER_URL=wss://... node index.mjs");
  process.exit(1);
}

const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/api/agent/ws";

console.log(`🔌  الاتصال بـ: ${wsUrl}`);

// ─── Selector strategies + scraping helpers ──────────────────────────────────
const GAS_INVOICE_SELECTORS = [
  'a:has-text("فاتورة الغاز")',
  'button:has-text("فاتورة الغاز")',
  'a:has-text("فاتوره الغاز")',
  'li:has-text("فاتورة الغاز") a',
  '[href*="gas"]',
  '[href*="GAS"]',
  '[href*="invoice"]',
  'a:has-text("الغاز")',
  'button:has-text("الغاز")',
  'td:has-text("الغاز")',
  'a:has-text("استعلام")',
];

async function clickGasInvoiceService(page) {
  for (const sel of GAS_INVOICE_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        await el.click({ timeout: 10000 });
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

async function fillAccountNumber(page, accountNumber) {
  const digits = accountNumber.replace(/\D/g, "").padEnd(16, "0").slice(0, 16);
  const inputs = page.locator('input[type="text"], input[type="number"], input:not([type])');
  const count = await inputs.count();

  if (count === 0) throw new Error("لم يتم العثور على حقول إدخال رقم الحساب");

  if (count >= 8) {
    for (let i = 0; i < 8; i++) {
      const chunk = digits.slice(i * 2, i * 2 + 2);
      const input = inputs.nth(i);
      await input.click();
      await input.fill("");
      await page.keyboard.type(chunk, { delay: 80 });
      await page.waitForTimeout(150);
    }
  } else {
    const firstInput = inputs.first();
    await firstInput.click();
    await firstInput.fill("");
    await page.keyboard.type(digits, { delay: 80 });
  }
}

async function clickInvoiceTab(page) {
  const tabSelectors = [
    'button:has-text("فاتورة")',
    'a:has-text("فاتورة")',
    'li:has-text("فاتورة") a',
    'li:has-text("فاتورة")',
    '[role="tab"]:has-text("فاتورة")',
    'span:has-text("فاتورة")',
  ];
  for (const sel of tabSelectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        await el.click({ timeout: 8000 });
        await page.waitForTimeout(1500);
        return;
      }
    } catch { /* ignore */ }
  }
}

async function extractInvoiceData(page) {
  let consumption = null, creditAdjustment = null, advanceBalance = null,
      amount = null, issueMonth = null;

  // Strategy A: header row + data row
  try {
    const allRows = await page.locator("table tr").all();
    const headerMap = {
      "الاستهلاك": "consumption",
      "تسوية": "creditAdjustment",
      "رصيد": "advanceBalance",
      "القيمة": "amount",
      "شهر": "issueMonth",
    };
    const colIndex = {};
    let headerRowIdx = -1;

    for (let ri = 0; ri < allRows.length; ri++) {
      const cells = await allRows[ri].locator("th, td").all();
      if (cells.length < 3) continue;
      const cellTexts = await Promise.all(cells.map(c => c.innerText().catch(() => "")));
      const found = {};
      for (const [kw, field] of Object.entries(headerMap)) {
        const idx = cellTexts.findIndex(t => t.includes(kw));
        if (idx !== -1) found[field] = idx;
      }
      if (Object.keys(found).length >= 2) {
        Object.assign(colIndex, found);
        headerRowIdx = ri;
        break;
      }
    }

    if (headerRowIdx >= 0 && headerRowIdx + 1 < allRows.length) {
      const dataCells = await allRows[headerRowIdx + 1].locator("td").all();
      const dataTexts = await Promise.all(dataCells.map(c => c.innerText().catch(() => "")));
      const pick = (f) => {
        const idx = colIndex[f];
        return (idx !== undefined && idx < dataTexts.length) ? dataTexts[idx].trim() || null : null;
      };
      consumption = pick("consumption");
      creditAdjustment = pick("creditAdjustment");
      advanceBalance = pick("advanceBalance");
      amount = pick("amount");
      issueMonth = pick("issueMonth");
    }
  } catch { /* fall through */ }

  // Strategy B: label-adjacent scan
  if (!consumption && !amount) {
    try {
      const allRows = await page.locator("table tr").all();
      const monthRe = /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر/;
      for (const row of allRows) {
        const cells = await row.locator("td").all();
        if (cells.length < 2) continue;
        const texts = await Promise.all(cells.map(c => c.innerText().catch(() => "").then(t => t.trim())));
        for (let ci = 0; ci < texts.length; ci++) {
          const t = texts[ci];
          const nextNum = texts[ci + 1]?.match(/[\d,.]+/)?.[0] ?? null;
          if (/الاستهلاك/.test(t) && !consumption) consumption = nextNum;
          if (/تسوية/.test(t) && !creditAdjustment) creditAdjustment = nextNum;
          if (/رصيد دفعات|دفعات مقدمة/.test(t) && !advanceBalance) advanceBalance = nextNum;
          if (/القيمة/.test(t) && !amount) amount = nextNum;
          if (monthRe.test(t) && /\d{4}/.test(t) && !issueMonth) issueMonth = t;
          else if (monthRe.test(t) && !issueMonth) issueMonth = t;
        }
      }
    } catch { /* fall through */ }
  }

  // Strategy C: body text regex
  if (!consumption && !amount) {
    try {
      const body = await page.locator("body").innerText();
      const m = (re) => body.match(re)?.[1]?.trim() ?? null;
      consumption      = consumption      ?? m(/الاستهلاك\s*[:：]?\s*([\d,.]+)/);
      creditAdjustment = creditAdjustment ?? m(/تسوية\s*مدين[ةه]\s*[:：]?\s*([\d,.]+)/);
      advanceBalance   = advanceBalance   ?? m(/رصيد\s*دفعات\s*مقدم[ةه]\s*[:：]?\s*([\d,.]+)/);
      amount           = amount           ?? m(/القيم[ةه]\s*[:：]?\s*([\d,.]+)/);
      if (!issueMonth) {
        const mm = body.match(/(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)\s*\d{4}/);
        if (mm) issueMonth = mm[0];
      }
    } catch { /* nothing more */ }
  }

  return { consumption, creditAdjustment, advanceBalance, amount, issueMonth };
}

async function scrapeInvoice(page, accountNumber) {
  try {
    // 1. Load Petrotrade portal
    await page.goto("https://www.petrotrade.com.eg/web/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(3000);
    console.log(`   [${accountNumber}] ✓ الصفحة محملة`);

    // 2. Navigate to gas invoice service
    const found = await clickGasInvoiceService(page);
    if (!found) {
      const bodySnippet = (await page.locator("body").innerText().catch(() => "")).slice(0, 200);
      throw new Error(`لم يتم العثور على رابط فاتورة الغاز. نص الصفحة: ${bodySnippet}`);
    }
    await page.waitForTimeout(3000);
    console.log(`   [${accountNumber}] ✓ تم الدخول لخدمة الغاز`);

    // 3. Fill account number (8 fields × 2 digits, auto-tab)
    await fillAccountNumber(page, accountNumber);
    console.log(`   [${accountNumber}] ✓ تم إدخال رقم الحساب`);

    // 4. Submit
    await page.keyboard.press("Enter");
    try {
      const btn = page.locator(
        'button[type="submit"], input[type="submit"], button:has-text("بحث"), button:has-text("استعلام")'
      ).first();
      if ((await btn.count()) > 0) await btn.click({ timeout: 5000 });
    } catch { /* Enter was enough */ }
    await page.waitForTimeout(4000);
    console.log(`   [${accountNumber}] ✓ تم الإرسال`);

    // 5. Click invoice tab if present
    await clickInvoiceTab(page);

    // 6. Handle month selector
    try {
      const sel = page.locator("select").first();
      if ((await sel.count()) > 0) {
        const opts = await sel.locator("option").all();
        if (opts.length > 0) {
          const val = await opts[0].getAttribute("value");
          if (val) await sel.selectOption(val);
          else await opts[0].click();
          await page.waitForTimeout(1500);
        }
      } else {
        const rows = page.locator("table tbody tr").filter({ hasText: /\d{4}/ });
        if ((await rows.count()) > 0) {
          await rows.first().click({ timeout: 5000 });
          await page.waitForTimeout(1500);
        }
      }
    } catch { /* non-critical */ }

    // 7. Extract data
    const data = await extractInvoiceData(page);
    console.log(`   [${accountNumber}] ✓ البيانات: القيمة=${data.amount ?? "—"} الاستهلاك=${data.consumption ?? "—"}`);

    return { ...data, status: "success", error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`   [${accountNumber}] ✗ خطأ: ${msg}`);
    return {
      consumption: null, creditAdjustment: null, advanceBalance: null,
      amount: null, issueMonth: null, status: "error", error: msg,
    };
  }
}

// ─── إدارة الاتصال ────────────────────────────────────────────────────────
let browser = null;
let context = null;

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log("🌐  تشغيل المتصفح المحلي...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: "Africa/Cairo",
    });
    console.log("✅  المتصفح جاهز");
  }
  return context;
}

async function handleScrapeTask(ws, taskId, account) {
  console.log(`📋  استخراج حساب: ${account}`);
  try {
    const ctx = await ensureBrowser();
    const page = await ctx.newPage();
    const result = await scrapeInvoice(page, account);
    await page.close();
    console.log(`✅  حساب ${account}: ${result.status} — القيمة: ${result.amount ?? "—"}`);
    ws.send(JSON.stringify({ type: "scrape_result", taskId, result }));
  } catch (err) {
    console.error(`❌  خطأ في حساب ${account}:`, err.message);
    ws.send(
      JSON.stringify({
        type: "scrape_error",
        taskId,
        message: err instanceof Error ? err.message : String(err),
      })
    );
  }
}

// ─── الاتصال بالسيرفر مع إعادة المحاولة ──────────────────────────────────
let reconnectDelay = 3000;

function connect() {
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log("✅  متصل بالسيرفر — الوكيل جاهز للعمل");
    reconnectDelay = 3000;

    // إرسال ping كل 10 ثوانٍ لمنع انتهاء مهلة الـ proxy
    const keepAlive = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      } else {
        clearInterval(keepAlive);
      }
    }, 10_000);

    ws.on("close", () => clearInterval(keepAlive));
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "ready") {
      console.log("🟢  السيرفر أعلن الجاهزية — في انتظار مهام الاستخراج...");
      return;
    }

    if (msg.type === "scrape") {
      handleScrapeTask(ws, msg.taskId, msg.account);
    }
  });

  ws.on("close", () => {
    console.log(`🔴  انقطع الاتصال — إعادة المحاولة بعد ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on("error", (err) => {
    console.error("⚠️  خطأ في الاتصال:", err.message);
  });
}

// ─── بدء التشغيل ──────────────────────────────────────────────────────────
console.log("🚀  وكيل بيتروتريد المحلي — الإصدار 1.0");
console.log("   يعمل كمحطة وسيطة داخل مصر للوصول لموقع بيتروتريد\n");
connect();

process.on("SIGINT", async () => {
  console.log("\n🛑  إيقاف الوكيل...");
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
