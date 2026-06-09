import { Router, type IRouter, type Request, type Response } from "express";
import { chromium } from "playwright";
import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import * as net from "net";
import { randomUUID } from "crypto";
import { agentRelay } from "../lib/agent-relay";

/**
 * Finds the system Chromium executable from the Nix store.
 * Falls back to undefined (letting Playwright use its bundled browser).
 */
function findNixChromium(): string | undefined {
    // 1. Explicit env var override (e.g. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH in Docker)
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }

    // 2. Nix store (Replit dev environment)
    const nixStore = "/nix/store";
    if (fs.existsSync(nixStore)) {
      try {
        const entries = fs.readdirSync(nixStore);
        const chromiumPkgs = entries
          .filter((e) => /^[a-z0-9]+-chromium-\d+/.test(e))
          .filter((e) => !/sandbox|dev|src|drv/.test(e))
          .sort()
          .reverse();

        for (const pkg of chromiumPkgs) {
          const bin = path.join(nixStore, pkg, "bin", "chromium");
          if (fs.existsSync(bin)) return bin;
        }
      } catch {
        // ignore
      }
    }

    // 3. System apt-installed chromium (Docker / Debian / Ubuntu)
    for (const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (fs.existsSync(p)) return p;
    }

    return undefined;
  }

const router: IRouter = Router();

interface InvoiceResult {
  accountNumber: string;
  consumption: string | null;
  creditAdjustment: string | null;
  advanceBalance: string | null;
  amount: string | null;
  issueMonth: string | null;
  status: "success" | "error" | "pending";
  error: string | null;
}

interface ScraperJob {
  jobId: string;
  status: "running" | "completed" | "failed";
  totalAccounts: number;
  processedAccounts: number;
  results: InvoiceResult[];
  startedAt: string;
  completedAt: string | null;
  pdfReady: boolean;
}

const jobs = new Map<string, ScraperJob>();
const pdfPaths = new Map<string, string>();
const proxyUrls = new Map<string, string>();

interface ProxySearchJob {
  searchId: string;
  status: "searching" | "found" | "not_found";
  tested: number;
  total: number;
  message: string;
  proxyUrl: string | null;
}

const proxySearchJobs = new Map<string, ProxySearchJob>();

/** Quick TCP reachability check — resolves true if port accepts a connection within timeoutMs */
function tcpPing(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

/**
 * Tests whether an HTTP proxy can establish a CONNECT tunnel to petrotrade.com.eg:443.
 * Returns true only when the proxy responds 200 Connection established.
 */
function testProxyConnect(proxyUrl: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(proxyUrl); } catch { resolve(false); return; }

    const proxyHost = parsed.hostname;
    const proxyPort = parseInt(parsed.port) || 80;
    const auth = parsed.username
      ? Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")
      : null;

    const timer = setTimeout(() => { req.destroy(); resolve(false); }, timeoutMs);

    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: "CONNECT",
      path: "www.petrotrade.com.eg:443",
      headers: {
        Host: "www.petrotrade.com.eg:443",
        ...(auth ? { "Proxy-Authorization": `Basic ${auth}` } : {}),
      },
    });

    req.on("connect", (res) => {
      clearTimeout(timer);
      req.destroy();
      resolve(res.statusCode === 200);
    });

    req.on("error", () => { clearTimeout(timer); resolve(false); });
    req.end();
  });
}

/** Fetches a raw list of proxies from multiple free sources, returns unique "host:port" strings */
async function fetchRawProxyList(): Promise<string[]> {
  const sources = [
    // ProxyScrape — Egyptian HTTP proxies
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=EG&anonymity=all",
    // ProxyScrape — all countries (fallback)
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&anonymity=elite&ssl=yes",
    // Clarketm proxy list
    "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  ];

  const results = new Set<string>();

  await Promise.allSettled(
    sources.map(async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return;
        const text = await res.text();
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          // Match host:port lines (IPv4 only to keep it clean)
          if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}$/.test(trimmed)) {
            results.add(trimmed);
          }
        }
      } catch { /* ignore individual source failures */ }
    })
  );

  return Array.from(results);
}

async function runProxySearch(searchId: string) {
  const job = proxySearchJobs.get(searchId)!;

  try {
    job.message = "جاري جلب قوائم البروكسي...";
    const rawList = await fetchRawProxyList();

    if (rawList.length === 0) {
      job.status = "not_found";
      job.message = "لم يتم العثور على أي بروكسي من مصادر البيانات المجانية. جرّب إدخال بروكسي يدوياً.";
      return;
    }

    job.total = rawList.length;
    job.message = `جاري اختبار ${rawList.length} بروكسي...`;

    for (let i = 0; i < rawList.length; i++) {
      const entry = rawList[i];
      job.tested = i + 1;
      job.message = `جاري اختبار ${i + 1} من ${rawList.length}: ${entry}`;

      const [host, portStr] = entry.split(":");
      const port = parseInt(portStr);

      // Fast TCP ping first
      const reachable = await tcpPing(host, port, 3000);
      if (!reachable) continue;

      // CONNECT tunnel test
      const proxyUrl = `http://${entry}`;
      const works = await testProxyConnect(proxyUrl, 8000);
      if (works) {
        job.status = "found";
        job.proxyUrl = proxyUrl;
        job.message = `تم العثور على بروكسي يعمل: ${entry}`;
        return;
      }
    }

    job.status = "not_found";
    job.message = `تم اختبار ${rawList.length} بروكسي ولم يعمل أي منها. الموقع قد يكون مقيداً جداً. جرّب بروكسي مدفوع مصري.`;
  } catch (err) {
    job.status = "not_found";
    job.message = `خطأ في عملية البحث: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function getAccountsFromSheet(): Promise<string[]> {
  const credsBase64 = process.env.GOOGLE_CREDENTIALS_BASE64;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!credsBase64 || !sheetId) {
    throw new Error("GOOGLE_CREDENTIALS_BASE64 and GOOGLE_SHEET_ID must be set");
  }

  const creds = JSON.parse(Buffer.from(credsBase64, "base64").toString("utf8"));

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId || "1YZK*****AE",
    range: "DATA!B2:B1000",
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    return [];
  }

  return rows
    .map((row) => row[0] as string)
    .filter((val) => val && String(val).trim() !== "")
    .map((val) => String(val).trim());
}

/**
 * Saves a debug screenshot to /tmp/petrotrade-debug/ and returns the path.
 * Errors are silently swallowed — screenshots are best-effort only.
 */
async function takeDebugScreenshot(
  page: import("playwright").Page,
  label: string
): Promise<string | null> {
  try {
    const dir = path.join(os.tmpdir(), "petrotrade-debug");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${Date.now()}-${label}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Tries several selector strategies to click the Gas Invoice entry point on the
 * Petrotrade home page.  Returns true if a click was successfully dispatched.
 */
async function clickGasInvoiceService(page: import("playwright").Page): Promise<boolean> {
  const candidateSelectors = [
    // Arabic exact text variants
    'a:has-text("فاتورة الغاز")',
    'button:has-text("فاتورة الغاز")',
    'a:has-text("فاتوره الغاز")',
    'li:has-text("فاتورة الغاز") a',
    // Partial matches
    '[href*="gas"]',
    '[href*="GAS"]',
    '[href*="invoice"]',
    // Broader fallback — any clickable element mentioning الغاز
    'a:has-text("الغاز")',
    'button:has-text("الغاز")',
    'td:has-text("الغاز")',
    // استعلام عن فاتورة
    'a:has-text("استعلام")',
  ];

  for (const sel of candidateSelectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        await el.click({ timeout: 10000 });
        return true;
      }
    } catch {
      // Try next selector
    }
  }
  return false;
}

/**
 * Fills the 16-digit account number into the Petrotrade input form.
 *
 * The form has 8 text inputs — each accepts exactly 2 digits and auto-tabs to
 * the next field on the second keystroke.  We simulate real typing so the
 * auto-tab JavaScript fires correctly.
 */
async function fillAccountNumber(
  page: import("playwright").Page,
  accountNumber: string
): Promise<void> {
  // Normalise: keep digits only, pad/truncate to 16
  const digits = accountNumber.replace(/\D/g, "").padEnd(16, "0").slice(0, 16);

  // Look for visible text/number inputs
  const inputs = page.locator('input[type="text"], input[type="number"], input:not([type])');
  const count = await inputs.count();

  if (count === 0) {
    throw new Error("لم يتم العثور على حقول إدخال رقم الحساب");
  }

  if (count >= 8) {
    // 8-field form: type each 2-digit chunk into the matching input.
    // We use keyboard.type() with a small delay so site-side auto-tab JS fires.
    for (let i = 0; i < 8; i++) {
      const chunk = digits.slice(i * 2, i * 2 + 2);
      const input = inputs.nth(i);
      await input.click();
      await input.fill(""); // clear first
      await page.keyboard.type(chunk, { delay: 80 });
      // Give auto-tab time to move focus (site may do this via maxlength or JS)
      await page.waitForTimeout(150);
    }
  } else if (count >= 1) {
    // Single (or fewer than 8) input — type the full 16 digits;
    // the auto-tab mechanism will distribute across fields automatically
    const firstInput = inputs.first();
    await firstInput.click();
    await firstInput.fill("");
    await page.keyboard.type(digits, { delay: 80 });
  }
}

/**
 * Tries to click the "فاتورة" details tab that appears after account lookup.
 * Not every page layout has this tab — failure is silently ignored.
 */
async function clickInvoiceTab(page: import("playwright").Page): Promise<void> {
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
    } catch {
      // Try next
    }
  }
}

/**
 * Parses the invoice data table returned by the Petrotrade site.
 *
 * Strategy A — Header-row detection:
 *   Find the <tr> whose cells contain the Arabic column headers, then read the
 *   NEXT data row cell-by-cell using the header position as a column index.
 *
 * Strategy B — Label-adjacent scan:
 *   Walk every <tr> on the page and match cell text against known Arabic labels;
 *   the value is in the sibling cell to the right (or left in RTL).
 *
 * Strategy C — Full-body regex:
 *   Last resort: match patterns in the full innerText of <body>.
 */
async function extractInvoiceData(page: import("playwright").Page): Promise<{
  consumption: string | null;
  creditAdjustment: string | null;
  advanceBalance: string | null;
  amount: string | null;
  issueMonth: string | null;
}> {
  let consumption: string | null = null;
  let creditAdjustment: string | null = null;
  let advanceBalance: string | null = null;
  let amount: string | null = null;
  let issueMonth: string | null = null;

  // ── Strategy A: header row + data row ───────────────────────────────────
  try {
    const allRows = await page.locator("table tr").all();

    // Arabic header keywords mapped to our result fields
    const headerMap: Record<string, keyof typeof colIndex> = {
      "الاستهلاك": "consumption",
      "تسوية": "creditAdjustment",
      "رصيد": "advanceBalance",
      "القيمة": "amount",
      "شهر": "issueMonth",
    };

    const colIndex: Record<string, number> = {};
    let headerRowIdx = -1;

    for (let ri = 0; ri < allRows.length; ri++) {
      const cells = await allRows[ri].locator("th, td").all();
      if (cells.length < 3) continue;

      const cellTexts = await Promise.all(cells.map((c) => c.innerText().catch(() => "")));
      const foundHeaders: Record<string, number> = {};

      for (const [keyword, field] of Object.entries(headerMap)) {
        const idx = cellTexts.findIndex((t) => t.includes(keyword));
        if (idx !== -1) foundHeaders[field] = idx;
      }

      if (Object.keys(foundHeaders).length >= 2) {
        Object.assign(colIndex, foundHeaders);
        headerRowIdx = ri;
        break;
      }
    }

    if (headerRowIdx >= 0 && headerRowIdx + 1 < allRows.length) {
      const dataRow = allRows[headerRowIdx + 1];
      const dataCells = await dataRow.locator("td").all();
      const dataTexts = await Promise.all(dataCells.map((c) => c.innerText().catch(() => "")));

      const pick = (field: string): string | null => {
        const idx = colIndex[field];
        if (idx === undefined || idx >= dataTexts.length) return null;
        const val = dataTexts[idx].trim();
        return val || null;
      };

      consumption = pick("consumption");
      creditAdjustment = pick("creditAdjustment");
      advanceBalance = pick("advanceBalance");
      amount = pick("amount");
      issueMonth = pick("issueMonth");
    }
  } catch {
    // Fall through to strategy B
  }

  // ── Strategy B: label-adjacent scan ─────────────────────────────────────
  if (!consumption && !amount) {
    try {
      const allRows = await page.locator("table tr").all();

      const monthRegex =
        /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر/;

      for (const row of allRows) {
        const cells = await row.locator("td").all();
        if (cells.length < 2) continue;
        const texts = await Promise.all(cells.map((c) => c.innerText().catch(() => "").then((t) => t.trim())));

        for (let ci = 0; ci < texts.length; ci++) {
          const t = texts[ci];
          // Value is in the NEXT cell
          const nextVal = ci + 1 < texts.length ? texts[ci + 1] : null;
          const numericVal = nextVal?.match(/[\d,.]+/)?.[0] ?? null;

          if (/الاستهلاك/.test(t) && !consumption) consumption = numericVal;
          if (/تسوية/.test(t) && !creditAdjustment) creditAdjustment = numericVal;
          if (/رصيد دفعات|دفعات مقدمة/.test(t) && !advanceBalance) advanceBalance = numericVal;
          if (/القيمة/.test(t) && !amount) amount = numericVal;
          if (monthRegex.test(t) && /\d{4}/.test(t) && !issueMonth) issueMonth = t;
          // Month might be in a separate "year" format: "يناير 2025"
          if (monthRegex.test(t) && !issueMonth) issueMonth = t;
        }
      }
    } catch {
      // Fall through to strategy C
    }
  }

  // ── Strategy C: full body text regex ────────────────────────────────────
  if (!consumption && !amount) {
    try {
      const bodyText = await page.locator("body").innerText();

      const m = (pattern: RegExp) => bodyText.match(pattern)?.[1]?.trim() ?? null;

      consumption      = consumption      ?? m(/الاستهلاك\s*[:：]?\s*([\d,.]+)/);
      creditAdjustment = creditAdjustment ?? m(/تسوية\s*مدين[ةه]\s*[:：]?\s*([\d,.]+)/);
      advanceBalance   = advanceBalance   ?? m(/رصيد\s*دفعات\s*مقدم[ةه]\s*[:：]?\s*([\d,.]+)/);
      amount           = amount           ?? m(/القيم[ةه]\s*[:：]?\s*([\d,.]+)/);

      if (!issueMonth) {
        const monthMatch = bodyText.match(
          /(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)\s*\d{4}/
        );
        if (monthMatch) issueMonth = monthMatch[0];
      }
    } catch {
      // Nothing more to try
    }
  }

  return { consumption, creditAdjustment, advanceBalance, amount, issueMonth };
}

async function scrapeInvoice(
  page: import("playwright").Page,
  accountNumber: string
): Promise<Omit<InvoiceResult, "accountNumber">> {
  try {
    // ── 1. Load the Petrotrade portal ──────────────────────────────────────
    await page.goto("https://www.petrotrade.com.eg/web/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for JavaScript to settle
    await page.waitForTimeout(3000);
    await takeDebugScreenshot(page, "01-homepage");

    // ── 2. Navigate to the gas invoice service ─────────────────────────────
    const found = await clickGasInvoiceService(page);
    if (!found) {
      const bodySnippet = (await page.locator("body").innerText().catch(() => "")).slice(0, 300);
      throw new Error(
        `لم يتم العثور على رابط فاتورة الغاز في الصفحة الرئيسية. نص الصفحة: ${bodySnippet}`
      );
    }

    await page.waitForTimeout(3000);
    await takeDebugScreenshot(page, "02-gas-invoice-page");

    // ── 3. Fill the account number ─────────────────────────────────────────
    await fillAccountNumber(page, accountNumber);
    await takeDebugScreenshot(page, "03-account-filled");

    // Submit — press Enter then wait for results
    await page.keyboard.press("Enter");
    // Also try clicking a submit/search button if present
    try {
      const submitBtn = page
        .locator('button[type="submit"], input[type="submit"], button:has-text("بحث"), button:has-text("استعلام")')
        .first();
      if ((await submitBtn.count()) > 0) await submitBtn.click({ timeout: 5000 });
    } catch {
      // Ignore — Enter press above is usually enough
    }

    await page.waitForTimeout(4000);
    await takeDebugScreenshot(page, "04-after-submit");

    // ── 4. Click the "فاتورة" detail tab (if it exists) ───────────────────
    await clickInvoiceTab(page);
    await takeDebugScreenshot(page, "05-invoice-tab");

    // Handle month selector / list — pick the most recent entry
    try {
      const monthSelect = page.locator("select").first();
      if ((await monthSelect.count()) > 0) {
        // Select the first option (most recent)
        const options = await monthSelect.locator("option").all();
        if (options.length > 0) {
          const firstVal = await options[0].getAttribute("value");
          if (firstVal) await monthSelect.selectOption(firstVal);
          else await options[0].click();
          await page.waitForTimeout(1500);
        }
      } else {
        // Try clicking first data row in an invoice list table
        const listRows = page.locator("table tbody tr").filter({ hasText: /\d{4}/ });
        if ((await listRows.count()) > 0) {
          await listRows.first().click({ timeout: 5000 });
          await page.waitForTimeout(1500);
        }
      }
    } catch {
      // Non-critical — proceed to extraction
    }

    await takeDebugScreenshot(page, "06-before-extract");

    // ── 5. Extract invoice data ────────────────────────────────────────────
    const data = await extractInvoiceData(page);

    await takeDebugScreenshot(page, "07-done");

    return {
      ...data,
      status: "success",
      error: null,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    try { await takeDebugScreenshot(page, "error"); } catch { /* ignore */ }
    return {
      consumption: null,
      creditAdjustment: null,
      advanceBalance: null,
      amount: null,
      issueMonth: null,
      status: "error",
      error: errorMessage,
    };
  }
}

function buildReportHTML(job: ScraperJob): string {
  const now = new Date();
  const reportDate = now.toLocaleDateString("ar-EG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const successCount = job.results.filter((r) => r.status === "success").length;
  const errorCount = job.results.filter((r) => r.status === "error").length;

  const rows = job.results
    .map((r, idx) => {
      const isError = r.status === "error";
      const rowBg = isError ? "#fff5f5" : idx % 2 === 0 ? "#f8fafc" : "#ffffff";
      const textColor = isError ? "#dc2626" : "#1e293b";
      return `
      <tr style="background:${rowBg}; color:${textColor};">
        <td>${escapeHtml(r.accountNumber)}</td>
        <td>${escapeHtml(r.issueMonth ?? "—")}</td>
        <td>${escapeHtml(r.consumption ?? "—")}</td>
        <td>${escapeHtml(r.creditAdjustment ?? "—")}</td>
        <td>${escapeHtml(r.advanceBalance ?? "—")}</td>
        <td class="amount">${escapeHtml(r.amount ?? "—")}</td>
        <td>
          ${isError
            ? `<span class="badge error">خطأ</span>`
            : r.status === "success"
            ? `<span class="badge success">ناجح</span>`
            : `<span class="badge pending">قيد الانتظار</span>`}
        </td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Cairo', 'Segoe UI', Arial, sans-serif;
    direction: rtl;
    color: #1e293b;
    background: #fff;
    padding: 32px 40px;
    font-size: 13px;
    line-height: 1.6;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding-bottom: 20px;
    border-bottom: 3px solid #1e3a5f;
    margin-bottom: 24px;
  }
  .logo-box {
    width: 52px; height: 52px;
    background: #1e3a5f;
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .logo-box svg { width: 28px; height: 28px; fill: white; }
  .header-text h1 {
    font-size: 20px; font-weight: 800; color: #1e3a5f;
  }
  .header-text p { font-size: 12px; color: #64748b; margin-top: 2px; }
  .meta {
    display: flex; gap: 32px;
    background: #f1f5f9;
    border-radius: 10px;
    padding: 14px 20px;
    margin-bottom: 24px;
  }
  .meta-item { display: flex; flex-direction: column; }
  .meta-label { font-size: 11px; color: #64748b; }
  .meta-value { font-size: 15px; font-weight: 700; color: #1e3a5f; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  thead tr {
    background: #1e3a5f;
    color: white;
  }
  thead th {
    padding: 10px 10px;
    text-align: center;
    font-weight: 700;
    font-size: 12px;
    white-space: nowrap;
  }
  tbody td {
    padding: 8px 10px;
    text-align: center;
    border-bottom: 1px solid #e2e8f0;
    font-size: 12px;
  }
  td:first-child { font-family: monospace; font-size: 11px; }
  .amount { font-weight: 700; }
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge.success { background: #dcfce7; color: #16a34a; }
  .badge.error   { background: #fee2e2; color: #dc2626; }
  .badge.pending { background: #f1f5f9; color: #64748b; }
  .summary {
    margin-top: 24px;
    display: flex;
    gap: 16px;
  }
  .summary-card {
    flex: 1;
    border-radius: 10px;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
  }
  .summary-card.total  { background: #eff6ff; }
  .summary-card.ok     { background: #f0fdf4; }
  .summary-card.failed { background: #fef2f2; }
  .summary-card .num {
    font-size: 28px; font-weight: 800;
  }
  .summary-card.total  .num { color: #1e3a5f; }
  .summary-card.ok     .num { color: #16a34a; }
  .summary-card.failed .num { color: #dc2626; }
  .summary-card .lbl { font-size: 12px; color: #64748b; margin-top: 2px; }
  .footer {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 1px solid #e2e8f0;
    text-align: center;
    font-size: 11px;
    color: #94a3b8;
  }
</style>
</head>
<body>

<div class="header">
  <div class="logo-box">
    <svg viewBox="0 0 24 24"><path d="M3 3h18v4H3V3zm0 6h18v12H3V9zm4 3v6h4v-6H7zm6 0v6h4v-6h-4z"/></svg>
  </div>
  <div class="header-text">
    <h1>تقرير فواتير الغاز — بيتروتريد</h1>
    <p>نظام الاستخراج الآلي لبيانات الاستهلاك والمطالبات</p>
  </div>
</div>

<div class="meta">
  <div class="meta-item">
    <span class="meta-label">تاريخ التقرير</span>
    <span class="meta-value">${reportDate}</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">عدد الحسابات</span>
    <span class="meta-value">${job.totalAccounts}</span>
  </div>
  <div class="meta-item">
    <span class="meta-label">تاريخ البدء</span>
    <span class="meta-value">${new Date(job.startedAt).toLocaleTimeString("ar-EG")}</span>
  </div>
  ${job.completedAt ? `
  <div class="meta-item">
    <span class="meta-label">تاريخ الانتهاء</span>
    <span class="meta-value">${new Date(job.completedAt).toLocaleTimeString("ar-EG")}</span>
  </div>` : ""}
</div>

<table>
  <thead>
    <tr>
      <th>رقم الحساب</th>
      <th>شهر الإصدار</th>
      <th>الاستهلاك</th>
      <th>تسوية مدينة</th>
      <th>رصيد دفعات مقدمة</th>
      <th>القيمة</th>
      <th>الحالة</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>

<div class="summary">
  <div class="summary-card total">
    <span class="num">${job.totalAccounts}</span>
    <span class="lbl">إجمالي الحسابات</span>
  </div>
  <div class="summary-card ok">
    <span class="num">${successCount}</span>
    <span class="lbl">حسابات ناجحة</span>
  </div>
  <div class="summary-card failed">
    <span class="num">${errorCount}</span>
    <span class="lbl">حسابات بخطأ</span>
  </div>
</div>

<div class="footer">
  تم إنشاء هذا التقرير بواسطة نظام مستخرج فواتير بيتروتريد — ${reportDate}
</div>

</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function generatePDF(job: ScraperJob): Promise<string> {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `petrotrade_${job.jobId}.pdf`);
  const htmlPath = path.join(tmpDir, `petrotrade_${job.jobId}.html`);

  // Write HTML to a temp file
  const html = buildReportHTML(job);
  fs.writeFileSync(htmlPath, html, "utf8");

  const nixChromium = findNixChromium();

  const browser = await chromium.launch({
    headless: true,
    executablePath: nixChromium,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
    // Wait for fonts to load
    await page.waitForTimeout(1500);

    await page.pdf({
      path: pdfPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" },
    });
  } finally {
    await browser.close().catch(() => {});
    // Clean up temp HTML
    fs.unlink(htmlPath, () => {});
  }

  return pdfPath;
}

async function runScraperJobViaAgent(jobId: string, accounts: string[]) {
  const job = jobs.get(jobId)!;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      const result = await agentRelay.scrapeAccount(randomUUID(), account);
      job.results[i] = { accountNumber: account, ...result };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      job.results[i] = {
        accountNumber: account,
        consumption: null,
        creditAdjustment: null,
        advanceBalance: null,
        amount: null,
        issueMonth: null,
        status: "error" as const,
        error: errorMessage,
      };
    }
    job.processedAccounts = i + 1;
  }

  const pdfPath = await generatePDF(job);
  pdfPaths.set(jobId, pdfPath);
  job.status = "completed";
  job.completedAt = new Date().toISOString();
  job.pdfReady = true;
}

async function runScraperJob(jobId: string, accounts: string[]) {
  const job = jobs.get(jobId)!;
  job.results = accounts.map((acc) => ({
    accountNumber: acc,
    consumption: null,
    creditAdjustment: null,
    advanceBalance: null,
    amount: null,
    issueMonth: null,
    status: "pending" as const,
    error: null,
  }));

  // If a local agent (inside Egypt) is connected, delegate all scraping to it
  if (agentRelay.isConnected()) {
    try {
      await runScraperJobViaAgent(jobId, accounts);
    } catch (err: unknown) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      const errorMessage = err instanceof Error ? err.message : String(err);
      job.results = job.results.map((r) =>
        r.status === "pending"
          ? { ...r, status: "error" as const, error: errorMessage }
          : r
      );
    }
    return;
  }

  let browser: import("playwright").Browser | null = null;

  try {
    // Use system Chromium from Nix store (avoids missing shared library issues on NixOS/Replit)
    const nixChromium = findNixChromium();

    // Proxy resolution priority:
      // 1. Per-job proxy URL (from request body)
      // 2. PLAYWRIGHT_HTTP_PROXY (manually configured full URL)
      // 3. BRIGHT_DATA_* component env vars (fallback)
      const perJobProxy = proxyUrls.get(jobId);
      const playwrightHttpProxy = process.env["PLAYWRIGHT_HTTP_PROXY"];
      const proxyServer = process.env.BRIGHT_DATA_PROXY;
      const proxyUser = process.env.BRIGHT_DATA_USER;
      const proxyPass = process.env.BRIGHT_DATA_PASS;

      let proxyConfig: import("playwright").LaunchOptions["proxy"] = undefined;
      if (perJobProxy) {
        proxyConfig = { server: perJobProxy };
      } else if (playwrightHttpProxy) {
        proxyConfig = { server: playwrightHttpProxy };
      } else if (proxyServer && proxyUser && proxyPass) {
        proxyConfig = {
          server: `http://${proxyServer}`,
          username: proxyUser,
          password: proxyPass,
        };
      }

    browser = await chromium.launch({
      headless: true,
      executablePath: nixChromium,
      proxy: proxyConfig,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      locale: "ar-EG",
      timezoneId: "Africa/Cairo",
    });

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      const page = await context.newPage();

      const result = await scrapeInvoice(page, account);
      await page.close();

      job.results[i] = { accountNumber: account, ...result };
      job.processedAccounts = i + 1;
    }

    await context.close();

    // Generate PDF
    const pdfPath = await generatePDF(job);
    pdfPaths.set(jobId, pdfPath);

    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.pdfReady = true;
  } catch (err: unknown) {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    const errorMessage = err instanceof Error ? err.message : String(err);
    job.results = job.results.map((r) =>
      r.status === "pending"
        ? { ...r, status: "error" as const, error: errorMessage }
        : r
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// GET /api/scraper/accounts
router.get("/scraper/accounts", async (req: Request, res: Response) => {
  try {
    const accounts = await getAccountsFromSheet();
    res.json({ accounts, count: accounts.length });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Failed to fetch accounts");
    res.status(500).json({ error });
  }
});

// POST /api/scraper/run
router.post("/scraper/run", async (req: Request, res: Response) => {
  try {
    let accounts: string[] = req.body?.accounts;
    const proxyUrl: string | undefined = req.body?.proxyUrl;

    if (!accounts || accounts.length === 0) {
      accounts = await getAccountsFromSheet();
    }

    if (accounts.length === 0) {
      res.status(400).json({ error: "لم يتم العثور على أرقام حسابات" });
      return;
    }

    const jobId = randomUUID();
    // Store proxyUrl alongside job using a separate map
    if (proxyUrl) proxyUrls.set(jobId, proxyUrl);

    const job: ScraperJob = {
      jobId,
      status: "running",
      totalAccounts: accounts.length,
      processedAccounts: 0,
      results: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
      pdfReady: false,
    };

    jobs.set(jobId, job);

    // Run in background (don't await)
    runScraperJob(jobId, accounts).catch((err) => {
      req.log.error({ err, jobId }, "Scraper job failed");
    });

    res.json(job);
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "Failed to start scraper");
    res.status(500).json({ error });
  }
});

// GET /api/scraper/status/:jobId
router.get("/scraper/status/:jobId", (req: Request, res: Response) => {
  const jobId = req.params["jobId"] as string;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(job);
});

// POST /api/scraper/find-proxy
router.post("/scraper/find-proxy", (req: Request, res: Response) => {
  const searchId = randomUUID();
  const job: ProxySearchJob = {
    searchId,
    status: "searching",
    tested: 0,
    total: 0,
    message: "جاري الاستعداد...",
    proxyUrl: null,
  };
  proxySearchJobs.set(searchId, job);

  // Run in background
  runProxySearch(searchId).catch((err) => {
    const j = proxySearchJobs.get(searchId);
    if (j) {
      j.status = "not_found";
      j.message = `خطأ: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  res.json(job);
});

// GET /api/scraper/proxy-search/:searchId
router.get("/scraper/proxy-search/:searchId", (req: Request, res: Response) => {
  const searchId = req.params["searchId"] as string;
  const job = proxySearchJobs.get(searchId);
  if (!job) {
    res.status(404).json({ error: "Search job not found" });
    return;
  }
  res.json(job);
});

// GET /api/scraper/pdf/:jobId
router.get("/scraper/pdf/:jobId", (req: Request, res: Response) => {
  const jobId = req.params["jobId"] as string;
  const job = jobs.get(jobId);

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status !== "completed" || !job.pdfReady) {
    res.status(400).json({ error: "PDF not ready yet" });
    return;
  }

  const pdfPath = pdfPaths.get(jobId);
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    res.status(404).json({ error: "PDF file not found" });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="petrotrade_invoices_${jobId}.pdf"`);
  fs.createReadStream(pdfPath).pipe(res);
});

export default router;
