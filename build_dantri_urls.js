#!/usr/bin/env node

/**
 * Build dantri_article_urls.txt từ sitemap_dantri.txt
 *
 * Ý tưởng:
 *   - Đọc file sitemap_dantri.txt (mỗi dòng 1 sitemap .xml)
 *   - Với mỗi sitemap trong khoảng [START_IDX, END_IDX] (1-based):
 *       + Fetch sitemap XML
 *       + Lấy tất cả <loc> kết thúc bằng .htm và thuộc domain dantri.com.vn
 *   - Gom tất cả URL bài (.htm), dedup, sort và ghi vào dantri_article_urls.txt
 *
 * Chạy:
 *   - node build_dantri_urls.js            # xử lý tất cả sitemap
 *   - node build_dantri_urls.js 1 100      # xử lý sitemap 1–100
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// =========================
// Config
// =========================
const SITEMAP_FILE = "sitemap_dantri.txt";
const OUTPUT_URLS_FILE = "dantri_article_urls.txt";

const REQUEST_TIMEOUT = 18000; // ms
const MIN_DELAY = 300;        // ms
const MAX_DELAY = 800;        // ms
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 4;
const BACKOFF_BASE = 350;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; DantriSitemapCollector/1.0; +https://dantri.com.vn/)",
};

// =========================
// Utils
// =========================
function log(msg) {
  console.error(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeSleep() {
  const delay = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  await sleep(delay);
}

async function runTasksWithConcurrency(items, worker, concurrency) {
  const running = new Set();
  for (const item of items) {
    while (running.size >= concurrency) {
      await Promise.race(Array.from(running));
    }
    const p = (async () => {
      try {
        await worker(item);
      } catch (err) {
        log(
          `[WORKER] Error: ${err && err.message ? err.message : err}`
        );
      }
    })();
    running.add(p);
    p.finally(() => running.delete(p));
  }
  if (running.size) await Promise.all(Array.from(running));
}

// =========================
// HTTP fetch + retry
// =========================
async function fetchWithRetry(
  url,
  options = {},
  timeout = REQUEST_TIMEOUT,
  maxRetries = MAX_RETRIES
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);

      if (res.status >= 500 && res.status < 600) {
        throw new Error(`HTTP_${res.status}`);
      }
      if (res.status === 428 || res.status === 429) {
        throw new Error(`HTTP_RATELIMIT_${res.status}`);
      }

      return res;
    } catch (err) {
      const last = attempt === maxRetries;
      const msg = String(err.message || "");
      const jitter = Math.random() * 250;
      let backoff = Math.pow(2, attempt) * BACKOFF_BASE + jitter;

      if (msg.includes("HTTP_RATELIMIT_")) {
        backoff *= 5;
        log(
          `[RATE-LIMIT] ${url} – ngủ ${(backoff / 1000).toFixed(1)}s trước khi thử lại`
        );
      }

      if (last) throw err;
      await sleep(backoff);
    }
  }
}

// =========================
// Load sitemap list
// =========================
function loadSitemapUrlsFromFile(filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) {
    log(`[ERROR] Không tìm thấy file sitemap: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(p, "utf8");
  const lines = content.split(/\r?\n/);
  const urls = [];

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    urls.push(line);
  }

  if (urls.length === 0) {
    log("[ERROR] Không có sitemap URL nào trong sitemap_dantri.txt");
    process.exit(1);
  }

  log(`[INFO] Loaded ${urls.length} sitemap URLs từ sitemap_dantri.txt`);
  return urls;
}

// =========================
// Parse sitemap -> article URLs
// =========================
async function extractArticleUrlsFromSitemap(sitemapUrl) {
  log(`[SITEMAP] Fetching ${sitemapUrl}`);
  let resp;
  try {
    resp = await fetchWithRetry(sitemapUrl, { headers: HEADERS });
  } catch (e) {
    log(`[ERROR] Lỗi tải sitemap ${sitemapUrl}: ${e}`);
    return [];
  }

  if (!resp.ok) {
    log(`[ERROR] HTTP ${resp.status} khi tải sitemap ${sitemapUrl}`);
    return [];
  }

  const xmlText = await resp.text();
  const $ = cheerio.load(xmlText, { xmlMode: true });

  const articleUrls = [];
  $("loc").each((_, el) => {
    const url = $(el).text().trim();
    if (!url) return;

    // Dân trí thường có domain dantri.com.vn và bài kết thúc bằng .htm
    if (url.endsWith(".htm") && url.includes("dantri.com.vn")) {
      articleUrls.push(url);
    }
  });

  log(
    `[SITEMAP] Found ${articleUrls.length} article URLs in ${sitemapUrl}`
  );
  return articleUrls;
}

// =========================
// Main
// =========================
async function main() {
  const startTime = Date.now();

  // Parse args: 0 arg => all; 2 arg => start/end
  let startIdx = 1;
  let endIdx = null;

  if (process.argv.length === 4) {
    try {
      startIdx = parseInt(process.argv[2], 10);
      endIdx = parseInt(process.argv[3], 10);
    } catch (e) {
      log("[ERROR] START_IDX và END_IDX phải là số nguyên.");
      process.exit(1);
    }

    if (isNaN(startIdx) || isNaN(endIdx)) {
      log("[ERROR] START_IDX và END_IDX phải là số nguyên.");
      process.exit(1);
    }

    if (startIdx <= 0 || endIdx < startIdx) {
      log("[ERROR] START_IDX phải >= 1 và END_IDX >= START_IDX.");
      process.exit(1);
    }
  } else if (process.argv.length !== 2) {
    log("Usage:");
    log("  node build_dantri_urls.js");
    log("  node build_dantri_urls.js START_IDX END_IDX   (1-based index của sitemap)");
    process.exit(1);
  }

  const sitemapUrlsAll = loadSitemapUrlsFromFile(SITEMAP_FILE);
  const nSitemaps = sitemapUrlsAll.length;

  if (!endIdx) endIdx = nSitemaps;
  if (startIdx > nSitemaps) {
    log(
      `[ERROR] START_IDX (${startIdx}) > tổng số sitemap (${nSitemaps})`
    );
    process.exit(1);
  }
  endIdx = Math.min(endIdx, nSitemaps);

  const sitemapUrls = sitemapUrlsAll.slice(startIdx - 1, endIdx);
  log(
    `[INFO] Sẽ xử lý sitemap index từ ${startIdx} đến ${endIdx} / ${nSitemaps}`
  );

  // Load URL cũ (nếu có) để dedup giữa các lần chạy
  const outPath = path.resolve(OUTPUT_URLS_FILE);
  const existingSet = new Set();
  if (fs.existsSync(outPath)) {
    const oldContent = fs.readFileSync(outPath, "utf8");
    for (const line of oldContent.split(/\r?\n/)) {
      const u = line.trim();
      if (u) existingSet.add(u);
    }
    log(`[INFO] Đã load sẵn ${existingSet.size} URL từ ${OUTPUT_URLS_FILE}`);
  }

  const newUrlsSet = new Set();

  await runTasksWithConcurrency(
    sitemapUrls,
    async (smUrl) => {
      await politeSleep();
      const articleUrls = await extractArticleUrlsFromSitemap(smUrl);
      for (const u of articleUrls) {
        if (!existingSet.has(u)) {
          newUrlsSet.add(u);
        }
      }
    },
    3 // concurrency cho sitemap
  );

  log(
    `[INFO] Thu được mới ${newUrlsSet.size} URL (chưa trùng với file cũ)`
  );

  // Gộp cũ + mới, sort và ghi lại file
  const allUrls = new Set([...existingSet, ...newUrlsSet]);
  const sorted = Array.from(allUrls);
  sorted.sort();

  fs.writeFileSync(outPath, sorted.join("\n") + "\n", "utf8");

  log(
    `[DONE] Tổng số URL trong ${OUTPUT_URLS_FILE}: ${sorted.length}`
  );

  const endTime = Date.now();
  const elapsedMs = endTime - startTime;
  const elapsedMinutes = (elapsedMs / 60000).toFixed(2);
  log(`[TIME] Thời gian chạy: ${elapsedMinutes} phút`);
}

main().catch((err) => {
  console.error("[FATAL] Lỗi không mong muốn:", err);
  process.exit(1);
});
