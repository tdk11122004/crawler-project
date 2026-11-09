#!/usr/bin/env node

/**
 * Build sitemap_vietnamnet.txt từ sitemap chính của Vietnamnet.
 *
 * Ý tưởng:
 *   - Lấy sitemap gốc: https://vietnamnet.vn/sitemap.xml
 *   - Parse XML, lấy tất cả <loc> kết thúc bằng .xml và thuộc domain vietnamnet.vn
 *   - Ghi ra sitemap_vietnamnet.txt, mỗi dòng 1 URL (.xml)
 *
 * Chạy:
 *   node build_sitemap_vietnamnet.js
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// =========================
// Config
// =========================

// CHỈ dùng sitemap chính, không đi sâu child
const ROOT_SITEMAP_URL = "https://vietnamnet.vn/sitemap.xml";

const OUTPUT_SITEMAP_TXT = "sitemap_vietnamnet.txt";

const REQUEST_TIMEOUT = 18000; // ms
const MIN_DELAY = 200;
const MAX_DELAY = 600;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 4;
const BACKOFF_BASE = 350;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; VietnamnetSitemapBuilder/1.0; +https://vietnamnet.vn/)",
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
        throw new Error(`HTTP ${res.status}`);
      }
      if (res.status === 429) {
        throw new Error("HTTP 429");
      }

      return res;
    } catch (err) {
      const last = attempt === maxRetries;
      const jitter = Math.random() * 250;
      const backoff = Math.pow(2, attempt) * BACKOFF_BASE + jitter;
      if (last) throw err;
      await sleep(backoff * (err.message && err.message.includes("429") ? 3 : 1));
    }
  }
}

// =========================
// Sitemap parsing
// =========================

/**
 * Lấy TẤT CẢ link .xml trong sitemap chính
 * (không đi sâu, không đệ quy)
 */
async function extractXmlLocsFromRootSitemap(sitemapUrl) {
  log(`[SITEMAP] Fetching root sitemap: ${sitemapUrl}`);
  let resp;
  try {
    resp = await fetchWithRetry(sitemapUrl, { headers: HEADERS });
  } catch (e) {
    log(`[ERROR] Lỗi tải sitemap gốc ${sitemapUrl}: ${e}`);
    return [];
  }

  if (!resp.ok) {
    log(`[ERROR] HTTP ${resp.status} khi tải sitemap gốc ${sitemapUrl}`);
    return [];
  }

  const xmlText = await resp.text();
  const $ = cheerio.load(xmlText, { xmlMode: true });

  const urls = [];
  $("loc").each((_, el) => {
    const u = $(el).text().trim();
    if (!u) return;

    // Chỉ lấy các link .xml thuộc domain vietnamnet.vn
    if (u.endsWith(".xml") && u.includes("vietnamnet.vn")) {
      urls.push(u);
    }
  });

  log(`[SITEMAP] Found ${urls.length} .xml locs trong sitemap gốc`);
  return urls;
}

// =========================
// Main
// =========================
async function main() {
  const startTime = Date.now();
  log(`[INFO] Bắt đầu build sitemap_vietnamnet.txt từ ${ROOT_SITEMAP_URL}`);

  await politeSleep();
  const xmlLocs = await extractXmlLocsFromRootSitemap(ROOT_SITEMAP_URL);

  // dedup + sort
  const unique = Array.from(new Set(xmlLocs));
  unique.sort();

  const outPath = path.resolve(OUTPUT_SITEMAP_TXT);
  fs.writeFileSync(outPath, unique.join("\n") + "\n", "utf8");

  log(`[DONE] Đã ghi ${unique.length} sitemap URL vào ${OUTPUT_SITEMAP_TXT}`);

  const endTime = Date.now();
  const elapsedMs = endTime - startTime;
  const elapsedMinutes = (elapsedMs / 60000).toFixed(2);
  log(`[TIME] Thời gian chạy: ${elapsedMinutes} phút`);
}

main().catch((err) => {
  console.error("[FATAL] Lỗi không mong muốn:", err);
  process.exit(1);
});
