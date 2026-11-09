#!/usr/bin/env node

/**
 * Crawl sitemap articles của Dân Trí:
 *     https://dantri.com.vn/sitemaps/articles.xml
 *
 * Mục tiêu:
 *  - Lấy toàn bộ <loc> chứa URL .xml bên trong
 *  - Lưu vào file: sitemap_dantri.txt
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const ROOT_SITEMAP = "https://dantri.com.vn/sitemaps/articles.xml";
const OUTPUT_FILE = "sitemap_dantri.txt";

const REQUEST_TIMEOUT = 20000;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; DanTriSitemapCollector/1.0; +https://dantri.com.vn/)"
};

// ---------------------------
// Helper: sleep
// ---------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------
// Helper: fetch with timeout
// ---------------------------
async function fetchWithTimeout(url, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { signal: controller.signal, headers: HEADERS });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ---------------------------
// Parse sitemap & extract XML links
// ---------------------------
async function extractXmlLinks(sitemapUrl) {
  console.log("[SITEMAP] Fetching:", sitemapUrl);

  const resp = await fetchWithTimeout(sitemapUrl);
  if (!resp.ok) {
    console.error(`[ERROR] HTTP ${resp.status} while loading sitemap`);
    return [];
  }

  const xml = await resp.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const xmlUrls = [];

  $("loc").each((_, el) => {
    const url = $(el).text().trim();
    if (!url) return;

    // chỉ lấy các file XML con
    if (url.endsWith(".xml") && url.includes("dantri.com.vn")) {
      xmlUrls.push(url);
    }
  });

  console.log(`[SITEMAP] Found ${xmlUrls.length} XML files`);
  return xmlUrls;
}

// ---------------------------
// Main
// ---------------------------
async function main() {
  console.log("[INFO] Collecting DanTri article sitemaps...");
  console.log("[INFO] Root:", ROOT_SITEMAP);

  try {
    const xmlList = await extractXmlLinks(ROOT_SITEMAP);

    const unique = [...new Set(xmlList)].sort();

    fs.writeFileSync(OUTPUT_FILE, unique.join("\n") + "\n", "utf8");

    console.log(`[DONE] Wrote ${unique.length} XML URLs -> ${OUTPUT_FILE}`);
  } catch (err) {
    console.error("[FATAL ERROR]", err);
  }
}

main();
