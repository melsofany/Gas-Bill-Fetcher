import { Router, type IRouter, type Request, type Response } from "express";
import { chromium } from "playwright";
import { google } from "googleapis";
import PDFDocument from "pdfkit";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

/**
 * Finds the system Chromium executable from the Nix store.
 * Falls back to undefined (letting Playwright use its bundled browser).
 */
function findNixChromium(): string | undefined {
  const nixStore = "/nix/store";
  if (!fs.existsSync(nixStore)) return undefined;

  try {
    const entries = fs.readdirSync(nixStore);
    // Find chromium packages (not sandbox, not dev/src)
    const chromiumPkgs = entries
      .filter((e) => /^[a-z0-9]+-chromium-\d+/.test(e))
      .filter((e) => !/sandbox|dev|src|drv/.test(e))
      .sort()
      .reverse(); // newest first (hash-sorted, good enough)

    for (const pkg of chromiumPkgs) {
      const bin = path.join(nixStore, pkg, "bin", "chromium");
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    // ignore
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
    spreadsheetId: sheetId,
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

async function scrapeInvoice(
  page: import("playwright").Page,
  accountNumber: string
): Promise<Omit<InvoiceResult, "accountNumber">> {
  try {
    await page.goto("https://www.petrotrade.com.eg/web/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(2000);

    // Find and click on gas invoice / فاتورة الغاز link
    const invoiceLink = page.locator('a, button, span, div').filter({ hasText: /فاتورة الغاز|فاتوره الغاز|gas invoice/i }).first();
    await invoiceLink.click({ timeout: 15000 });
    await page.waitForTimeout(2000);

    // Enter account number - 16 digits, 2 per field (auto-tab)
    const chunks: string[] = [];
    for (let i = 0; i < accountNumber.length; i += 2) {
      chunks.push(accountNumber.substring(i, i + 2));
    }

    // Find input fields for account number
    const inputs = page.locator('input[type="text"], input[type="number"], input:not([type])');
    const inputCount = await inputs.count();

    if (inputCount >= 8) {
      // Fill each 2-digit chunk in a separate input box
      for (let i = 0; i < Math.min(chunks.length, inputCount); i++) {
        await inputs.nth(i).click();
        await inputs.nth(i).fill(chunks[i]);
        await page.waitForTimeout(200);
      }
    } else {
      // Try typing all digits into a single field
      const firstInput = inputs.first();
      await firstInput.click();
      await firstInput.fill(accountNumber);
    }

    // Press Enter to search
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);

    // Look for فاتورة tab/button
    const invoiceTab = page.locator('a, button, li, span').filter({ hasText: /^فاتورة$|^فواتير$/i }).first();
    await invoiceTab.click({ timeout: 15000 });
    await page.waitForTimeout(2000);

    // Get current date to find relevant month
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();

    // Find all available issue month options/rows - pick the latest one
    // Try to find month selector or table rows with months
    const monthOptions = page.locator('select option, tr, .month-row, [class*="month"]');
    
    // Try to find table with invoice data
    // Look for rows containing the data we need
    await page.waitForTimeout(1000);

    // Try to find the latest/most recent invoice row
    // Look for month selector if present
    const monthSelect = page.locator('select').first();
    const hasSelect = await monthSelect.count() > 0;
    
    if (hasSelect) {
      // Get options and select the most recent
      const options = await monthSelect.locator('option').all();
      if (options.length > 0) {
        // Select first option (usually most recent)
        await options[0].click();
        await page.waitForTimeout(1000);
      }
    } else {
      // Try clicking the first invoice row
      const rows = page.locator('table tr').filter({ hasText: /\d{4}/ });
      const rowCount = await rows.count();
      if (rowCount > 0) {
        await rows.first().click();
        await page.waitForTimeout(1000);
      }
    }

    // Extract data from the table
    // Look for the columns: الاستهلاك، تسوية مدينة، رصيد دفعات مقدمة، القيمة
    const pageContent = await page.content();
    
    // Extract values using text patterns near known Arabic labels
    const extractValue = async (labelPattern: RegExp): Promise<string | null> => {
      try {
        const cell = page.locator('td, th, span, div').filter({ hasText: labelPattern }).first();
        const count = await cell.count();
        if (count === 0) return null;
        
        // Try to get the next sibling's text
        const parentRow = cell.locator('..').locator('..').first();
        const rowText = await parentRow.innerText();
        
        const match = rowText.match(/[\d,.-]+/);
        return match ? match[0] : null;
      } catch {
        return null;
      }
    };

    // Try to find data in table cells
    const tableRows = await page.locator('table tr').all();
    
    let consumption: string | null = null;
    let creditAdjustment: string | null = null;
    let advanceBalance: string | null = null;
    let amount: string | null = null;
    let issueMonth: string | null = null;

    for (const row of tableRows) {
      const text = await row.innerText().catch(() => "");
      
      if (/الاستهلاك/i.test(text)) {
        const cells = await row.locator('td').all();
        for (const cell of cells) {
          const cellText = await cell.innerText().catch(() => "");
          if (/[\d,.-]+/.test(cellText) && !/الاستهلاك/.test(cellText)) {
            consumption = cellText.trim();
            break;
          }
        }
      }
      
      if (/تسوية مدينة|تسوية/.test(text)) {
        const cells = await row.locator('td').all();
        for (const cell of cells) {
          const cellText = await cell.innerText().catch(() => "");
          if (/[\d,.-]+/.test(cellText) && !/تسوية/.test(cellText)) {
            creditAdjustment = cellText.trim();
            break;
          }
        }
      }
      
      if (/رصيد دفعات|دفعات مقدمة/.test(text)) {
        const cells = await row.locator('td').all();
        for (const cell of cells) {
          const cellText = await cell.innerText().catch(() => "");
          if (/[\d,.-]+/.test(cellText) && !/رصيد|دفعات/.test(cellText)) {
            advanceBalance = cellText.trim();
            break;
          }
        }
      }
      
      if (/القيمة|قيمة الفاتورة/.test(text)) {
        const cells = await row.locator('td').all();
        for (const cell of cells) {
          const cellText = await cell.innerText().catch(() => "");
          if (/[\d,.-]+/.test(cellText) && !/القيمة|قيمة/.test(cellText)) {
            amount = cellText.trim();
            break;
          }
        }
      }
      
      if (/\d{4}/.test(text) && /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(text)) {
        issueMonth = text.trim().split('\n')[0];
      }
    }

    // If we couldn't find via table rows, try a different approach
    // Look for the data in the full page text
    if (!consumption && !amount) {
      const bodyText = await page.locator('body').innerText().catch(() => "");
      
      const consumptionMatch = bodyText.match(/الاستهلاك[^\d]*([\d,.]+)/);
      if (consumptionMatch) consumption = consumptionMatch[1];
      
      const creditMatch = bodyText.match(/تسوية مدينة[^\d]*([\d,.]+)/);
      if (creditMatch) creditAdjustment = creditMatch[1];
      
      const balanceMatch = bodyText.match(/رصيد دفعات مقدمة[^\d]*([\d,.]+)/);
      if (balanceMatch) advanceBalance = balanceMatch[1];
      
      const amountMatch = bodyText.match(/القيمة[^\d]*([\d,.]+)/);
      if (amountMatch) amount = amountMatch[1];
    }

    return {
      consumption,
      creditAdjustment,
      advanceBalance,
      amount,
      issueMonth,
      status: "success",
      error: null,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
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

async function generatePDF(job: ScraperJob): Promise<string> {
  const tmpDir = os.tmpdir();
  const pdfPath = path.join(tmpDir, `petrotrade_${job.jobId}.pdf`);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      info: {
        Title: "تقرير فواتير بيتروتريد",
        Author: "Petrotrade Invoice Extractor",
      },
    });

    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // Title
    doc.fontSize(20).text("تقرير فواتير الغاز - بيتروتريد", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`تاريخ التقرير: ${new Date().toLocaleDateString("ar-EG")}`, { align: "center" });
    doc.fontSize(12).text(`عدد الحسابات: ${job.totalAccounts}`, { align: "center" });
    doc.moveDown(1);

    // Table header
    const tableTop = doc.y;
    const colWidths = [80, 80, 80, 80, 80, 100];
    const headers = ["رقم الحساب", "الاستهلاك", "تسوية مدينة", "رصيد دفعات", "القيمة", "شهر الإصدار"];
    const startX = 40;

    // Draw header background
    doc.rect(startX, tableTop, colWidths.reduce((a, b) => a + b, 0), 25).fill("#1e40af");
    doc.fillColor("white").fontSize(9);

    let x = startX;
    headers.forEach((header, i) => {
      doc.text(header, x + 2, tableTop + 7, { width: colWidths[i] - 4, align: "center" });
      x += colWidths[i];
    });

    doc.fillColor("black");
    let rowY = tableTop + 25;

    // Draw rows
    job.results.forEach((result, idx) => {
      const bgColor = idx % 2 === 0 ? "#f8fafc" : "#ffffff";
      const rowHeight = 22;

      doc.rect(startX, rowY, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(bgColor).stroke("#e2e8f0");

      const rowData = [
        result.accountNumber,
        result.consumption ?? (result.status === "error" ? "خطأ" : "-"),
        result.creditAdjustment ?? "-",
        result.advanceBalance ?? "-",
        result.amount ?? "-",
        result.issueMonth ?? "-",
      ];

      doc.fillColor(result.status === "error" ? "#dc2626" : "#1e293b").fontSize(8);
      x = startX;
      rowData.forEach((cell, i) => {
        doc.text(String(cell), x + 2, rowY + 7, { width: colWidths[i] - 4, align: "center" });
        x += colWidths[i];
      });

      rowY += rowHeight;

      // Add new page if needed
      if (rowY > 750) {
        doc.addPage();
        rowY = 40;
      }
    });

    // Summary
    doc.moveDown(2);
    doc.fillColor("#1e293b").fontSize(11);
    const successCount = job.results.filter((r) => r.status === "success").length;
    const errorCount = job.results.filter((r) => r.status === "error").length;
    doc.text(`ملخص: ${successCount} حساب تم بنجاح، ${errorCount} حساب بخطأ`, { align: "right" });

    doc.end();
    stream.on("finish", () => resolve(pdfPath));
    stream.on("error", reject);
  });
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

  let browser: import("playwright").Browser | null = null;

  try {
    // Use system Chromium from Nix store (avoids missing shared library issues on NixOS/Replit)
    const nixChromium = findNixChromium();

    // HTTP proxy support — from request body (proxyUrls map) or env var PLAYWRIGHT_HTTP_PROXY
    // e.g. http://user:pass@proxy.eg:8080
    const httpProxy = proxyUrls.get(jobId) || process.env["PLAYWRIGHT_HTTP_PROXY"];
    const proxyConfig = httpProxy ? { server: httpProxy } : undefined;

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
