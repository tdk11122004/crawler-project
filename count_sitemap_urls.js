#!/usr/bin/env node

/**
 * Đếm số URL .htm theo batch (mỗi batch = 20 sitemap).
 *
 * Cách chạy:
 *      node count_sitemap_urls.js BATCH_START BATCH_END
 *
 * Ví dụ:
 *      node count_sitemap_urls.js 1 4
 * → xử lý 4 batch đầu:
 *      batch 1 = sitemap 1–20
 *      batch 2 = sitemap 21–40
 *      batch 3 = sitemap 41–60
 *      batch 4 = sitemap 61–80
 *
 * Output: sitemap_counts.txt
 * Mỗi dòng chỉ là 1 con số = tổng số URL .htm trong batch đó.
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const SITEMAP_FILE = "sitemap_thanhnien.txt";
const OUTPUT_FILE = "sitemap_counts.txt";

const REQUEST_TIMEOUT = 20000;
const MIN_DELAY = 150;
const MAX_DELAY = 600;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; SitemapCounterTN/1.0; +https://thanhnien.vn/)",
};

// ---------- Utils ----------
function log(msg) {
  console.error(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeSleep() {
  await sleep(MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY));
}

function loadSitemapUrls(filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) {
    log(`[ERROR] File sitemap không tồn tại: ${filePath}`);
    process.exit(1);
  }
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// fetch with timeout
async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// count .htm in single sitemap
async function countInSitemap(sitemapUrl) {
  try {
    const resp = await fetchWithTimeout(sitemapUrl, { headers: HEADERS });
    if (!resp.ok) return 0;

    const xml = await resp.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    let count = 0;
    $("loc").each((_, el) => {
      const url = $(el).text().trim();
      if (url.endsWith(".htm")) count++;
    });

    return count;
  } catch (e) {
    log(`[ERROR] Lỗi tải sitemap: ${sitemapUrl}`);
    return 0;
  }
}

// concurrency control
async function runWithConcurrency(items, limit, worker) {
  const running = new Set();
  for (const item of items) {
    while (running.size >= limit) {
      await Promise.race([...running]);
    }
    const p = (async () => worker(item))();
    running.add(p);
    p.finally(() => running.delete(p));
  }
  await Promise.all([...running]);
}

// ---------- Main ----------
async function main() {
  if (process.argv.length !== 4) {
    console.log("Usage:");
    console.log("  node count_sitemap_urls.js BATCH_START BATCH_END");
    console.log("Ví dụ: node count_sitemap_urls.js 1 4");
    process.exit(1);
  }

  let batchStart = parseInt(process.argv[2], 10);
  let batchEnd = parseInt(process.argv[3], 10);

  if (isNaN(batchStart) || isNaN(batchEnd) || batchStart <= 0 || batchEnd < batchStart) {
    log("[ERROR] Tham số không hợp lệ. Ví dụ đúng: node count_sitemap_urls.js 1 4");
    process.exit(1);
  }

  const sitemapList = loadSitemapUrls(SITEMAP_FILE);
  const totalSitemaps = sitemapList.length;

  // clear output file
  fs.writeFileSync(OUTPUT_FILE, "");

  for (let batch = batchStart; batch <= batchEnd; batch++) {
    const startIdx = (batch - 1) * 20;
    const endIdx = Math.min(startIdx + 20, totalSitemaps);

    const batchSitemaps = sitemapList.slice(startIdx, endIdx);
    let batchTotal = 0;

    log(`\n[BATCH ${batch}] xử lý sitemap ${startIdx + 1} → ${endIdx}`);

    await runWithConcurrency(batchSitemaps, 5, async (smUrl) => {
      await politeSleep();
      const count = await countInSitemap(smUrl);
      batchTotal += count;
    });

    // 🔥 chỉ ghi số, đúng yêu cầu:
    fs.appendFileSync(OUTPUT_FILE, `${batchTotal}\n`, "utf8");

    log(`[DONE] batch ${batch}: ${batchTotal} URLs .htm`);
  }

  log(`\n[FINISHED] Output → ${OUTPUT_FILE}`);
}

main();
