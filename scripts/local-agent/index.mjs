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

// ─── دالة استخراج الفاتورة ───────────────────────────────────────────────
async function scrapeInvoice(page, accountNumber) {
  try {
    await page.goto("https://www.petrotrade.com.eg/web/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(2000);

    const invoiceLink = page
      .locator("a, button, span, div")
      .filter({ hasText: /فاتورة الغاز|فاتوره الغاز|gas invoice/i })
      .first();
    await invoiceLink.click({ timeout: 15000 });
    await page.waitForTimeout(2000);

    const chunks = [];
    for (let i = 0; i < accountNumber.length; i += 2) {
      chunks.push(accountNumber.substring(i, i + 2));
    }

    const inputs = page.locator(
      'input[type="text"], input[type="number"], input:not([type])'
    );
    const inputCount = await inputs.count();

    if (inputCount >= 8) {
      for (let i = 0; i < Math.min(chunks.length, inputCount); i++) {
        await inputs.nth(i).click();
        await inputs.nth(i).fill(chunks[i]);
        await page.waitForTimeout(200);
      }
    } else {
      const firstInput = inputs.first();
      await firstInput.click();
      await firstInput.fill(accountNumber);
    }

    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    const invoiceTab = page
      .locator("a, button, li, span")
      .filter({ hasText: /^فاتورة$|^فواتير$/i })
      .first();
    await invoiceTab.click({ timeout: 15000 });
    await page.waitForTimeout(2000);

    const monthSelect = page.locator("select").first();
    const hasSelect = (await monthSelect.count()) > 0;
    if (hasSelect) {
      const options = await monthSelect.locator("option").all();
      if (options.length > 0) {
        await options[0].click();
        await page.waitForTimeout(1000);
      }
    } else {
      const rows = page.locator("table tr").filter({ hasText: /\d{4}/ });
      const rowCount = await rows.count();
      if (rowCount > 0) {
        await rows.first().click();
        await page.waitForTimeout(1000);
      }
    }

    let consumption = null;
    let creditAdjustment = null;
    let advanceBalance = null;
    let amount = null;
    let issueMonth = null;

    const tableRows = await page.locator("table tr").all();

    for (const row of tableRows) {
      const text = await row.innerText().catch(() => "");

      if (/الاستهلاك/i.test(text)) {
        const cells = await row.locator("td").all();
        for (const cell of cells) {
          const ct = await cell.innerText().catch(() => "");
          if (/[\d,.-]+/.test(ct) && !/الاستهلاك/.test(ct)) {
            consumption = ct.trim();
            break;
          }
        }
      }
      if (/تسوية مدينة|تسوية/.test(text)) {
        const cells = await row.locator("td").all();
        for (const cell of cells) {
          const ct = await cell.innerText().catch(() => "");
          if (/[\d,.-]+/.test(ct) && !/تسوية/.test(ct)) {
            creditAdjustment = ct.trim();
            break;
          }
        }
      }
      if (/رصيد دفعات|دفعات مقدمة/.test(text)) {
        const cells = await row.locator("td").all();
        for (const cell of cells) {
          const ct = await cell.innerText().catch(() => "");
          if (/[\d,.-]+/.test(ct) && !/رصيد|دفعات/.test(ct)) {
            advanceBalance = ct.trim();
            break;
          }
        }
      }
      if (/القيمة|قيمة الفاتورة/.test(text)) {
        const cells = await row.locator("td").all();
        for (const cell of cells) {
          const ct = await cell.innerText().catch(() => "");
          if (/[\d,.-]+/.test(ct) && !/القيمة|قيمة/.test(ct)) {
            amount = ct.trim();
            break;
          }
        }
      }
      if (
        /\d{4}/.test(text) &&
        /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(
          text
        )
      ) {
        issueMonth = text.trim().split("\n")[0];
      }
    }

    if (!consumption && !amount) {
      const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const cm = bodyText.match(/الاستهلاك[^\d]*([\d,.]+)/);
      if (cm) consumption = cm[1];
      const cr = bodyText.match(/تسوية مدينة[^\d]*([\d,.]+)/);
      if (cr) creditAdjustment = cr[1];
      const bm = bodyText.match(/رصيد دفعات مقدمة[^\d]*([\d,.]+)/);
      if (bm) advanceBalance = bm[1];
      const am = bodyText.match(/القيمة[^\d]*([\d,.]+)/);
      if (am) amount = am[1];
    }

    return { consumption, creditAdjustment, advanceBalance, amount, issueMonth, status: "success", error: null };
  } catch (err) {
    return {
      consumption: null,
      creditAdjustment: null,
      advanceBalance: null,
      amount: null,
      issueMonth: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
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
