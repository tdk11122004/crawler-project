#!/usr/bin/env node

/**
 * Crawler Vietnamnet.vn dùng sitemap + đếm term frequency theo keyword list.
 *
 * Input:
 *   - keywords.txt            : danh sách từ khóa (1 từ / cụm từ mỗi dòng)
 *   - sitemap_vietnamnet.txt  : mỗi dòng 1 URL sitemap .xml
 *
 * Chạy:
 *   node main_vnnet.js START_IDX END_IDX
 *   (chỉ số 1-based, theo thứ tự URL trong sitemap_vietnamnet.txt)
 *
 * Output:
 *   - vietnamnet_articles.csv : file CSV (một bài báo = một dòng),
 *                               append thêm mỗi lần chạy.
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// =========================
// Config
// =========================
const KEYWORDS_FILE = "keywords.txt";
const SITEMAP_FILE = "sitemap_vietnamnet.txt";
const OUTPUT_CSV = "vietnamnet_articles.csv";

const NEWSPAPER_NAME = "VietNamNet";
const REQUEST_TIMEOUT = 18000; // ms (xấp xỉ 12s như Python)
const MIN_DELAY = 200;          // ms
const MAX_DELAY = 600;          // ms
const PROGRESS_EVERY = 50;
const SITEMAP_CONCURRENCY = 5;   // số sitemap fetch song song
const ARTICLE_CONCURRENCY = 10;  // số bài fetch song song (tăng nếu muốn)

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; VietnamnetCrawler/1.0; +https://vietnamnet.vn/)",
};

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 4;
const BACKOFF_BASE = 350; // ms base for exponential backoff (jitter added)

// =========================
// Utils
// =========================
function log(msg) {
  console.error(msg);
}

function normalizeText(text) {
  if (!text) return "";
  return text.replace(/\r|\n|\t/g, " ").replace(/\s+/g, " ").trim();
}

function escapeRegExp(str) {
  // dùng cho build regex từ keyword
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadKeywords(filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) {
    log(`[ERROR] Không tìm thấy file keyword: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(p, "utf8");
  const lines = content.split(/\r?\n/);
  const keywords = [];

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    keywords.push(line);
  }

  if (keywords.length === 0) {
    log("[ERROR] Không có keyword nào trong keywords.txt");
    process.exit(1);
  }

  log(`[INFO] Loaded ${keywords.length} keywords`);
  return keywords;
}

function buildKeywordPatterns(keywords) {
  const patterns = {};
  for (const kw of keywords) {
    const pattern = new RegExp("\\b" + escapeRegExp(kw) + "\\b", "gi");
    patterns[kw] = pattern;
  }
  return patterns;
}

// =========================
// Load sitemap URLs (simple txt)
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
    log("[ERROR] Không có sitemap URL nào trong sitemap_vietnamnet.txt");
    process.exit(1);
  }

  log(
    `[INFO] Loaded ${urls.length} sitemap URLs từ file sitemap_vietnamnet.txt`
  );
  return urls;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeSleep() {
  const delay = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY); // ms
  await sleep(delay);
}

// helper concurrency
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
        log(`[WORKER] Error: ${err && err.message ? err.message : err}`);
      }
    })();
    running.add(p);
    p.finally(() => running.delete(p));
  }
  if (running.size) await Promise.all(Array.from(running));
}

// =========================
// HTTP fetch với timeout + retry
// =========================
async function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

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
      await sleep(
        backoff * (err.message && err.message.includes("429") ? 3 : 1)
      );
    }
  }
}

// =========================
// Helper phân loại URL
// =========================

// Trang tag/list thường dạng: ...-tag123456789.html
function isListingUrl(url) {
  return /-tag\d+\.html$/i.test(url) || /\/tags?\//i.test(url);
}

// chuẩn hóa href tương đối thành URL tuyệt đối
function normalizeUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch (e) {
    return null;
  }
}

// =========================
// Sitemap parsing
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
    if (url.endsWith(".html") && url.includes("vietnamnet.vn")) {
      articleUrls.push(url);
    }
  });

  log(
    `[SITEMAP] Found ${articleUrls.length} article URLs in ${sitemapUrl}`
  );
  return articleUrls;
}

// =========================
// Article parsing
// =========================
const DATE_REGEX = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}\b/;

function extractTitle($) {
  const h1 = $("h1").first();
  if (h1.length && h1.text().trim()) {
    return h1.text().trim();
  }

  const og = $('meta[property="og:title"]').first();
  if (og.length && og.attr("content")) {
    return og.attr("content").trim();
  }

  const title = $("title").first();
  if (title.length && title.text().trim()) {
    return title.text().trim();
  }

  return "";
}

function extractDate($) {
  const selectors = [
    ".bread-crumb-detail__time",
    "[data-role='publishdate']",
    "span.detail-time",
    "div.detail-time",
    "span.time",
    "span.date",
    "div.date",
    "div.meta",
    "time",
  ];

  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el || el.length === 0) continue;

    const text = el.text().replace(/\s+/g, " ").trim();
    const m = text.match(DATE_REGEX);
    if (m) {
      return m[0]; // vd: "31/01/2010"
    }

    const dt = el.attr("datetime");
    if (dt) {
      const m2 = dt.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (m2) {
        const [, y, mo, d] = m2;
        return `${d}/${mo}/${y}`;
      }
    }
  }

  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="pubdate"]',
    'meta[name="publish-date"]',
    'meta[name="date"]',
    'meta[itemprop="datePublished"]',
  ];

  for (const sel of metaSelectors) {
    const el = $(sel).first();
    if (!el || !el.attr("content")) continue;

    const content = el.attr("content");
    let m = content.match(DATE_REGEX);
    if (m) return m[0];

    m = content.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const [, y, mo, d] = m;
      return `${d}/${mo}/${y}`;
    }
  }

  const candidates = [];
  $('[class*="time"], [class*="date"]').each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, " ").trim();
    const m = txt.match(DATE_REGEX);
    if (!m) return;

    const dateStr = m[0];

    if (/Giấy phép|GP-BVHTTDL|cấp ngày|© 1997/i.test(txt)) {
      return;
    }

    candidates.push(dateStr);
  });

  if (candidates.length > 0) {
    return candidates[0];
  }

  return "";
}

function extractContent($) {
  const classPatterns = [
    /detail\-content/,
    /detail__content/,
    /cms\-body/,
    /article\-body/,
    /maincontent/,
  ];

  let container = null;

  for (const pat of classPatterns) {
    const cand = $("div,section")
      .filter((_, el) => {
        const cls = $(el).attr("class") || "";
        return pat.test(cls);
      })
      .first();
    if (cand.length) {
      container = cand;
      break;
    }
  }

  if (!container) {
    const art = $("article").first();
    if (art.length) container = art;
  }
  if (!container) container = $("body");

  container.find("script, style, noscript, iframe").remove();
  $("body").find("script, style, noscript, iframe").remove();

  const parts = [];
  container
    .find("p, h1, h2, h3, h4, h5, h6, li, div")
    .each((_, el) => {
      const cls = $(el).attr("class") || "";
      if (
        /breadcrumb|comment|related|suggest|social|share|tags|footer|header|nav|ads|quangcao|qc/i.test(
          cls
        )
      ) {
        return;
      }

      const txt = $(el).text().replace(/\s+/g, " ").trim();
      if (txt) parts.push(txt);
    });

  let text = parts.join("\n").trim();

  if (!text && container) {
    text = container.text().replace(/\s+/g, " ").trim();
  }

  if (!text) {
    text = $("body").text().replace(/\s+/g, " ").trim();
  }

  text = text
    .replace(/Chèn ads giữa bài[^]*?template\.content\.firstChild; \}/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

async function fetchArticle(url) {
  let resp;
  try {
    resp = await fetchWithRetry(url, { headers: HEADERS });
  } catch (e) {
    log(`[ERROR] Lỗi tải bài ${url}: ${e}`);
    return ["", "", ""];
  }

  if (!resp.ok) {
    log(`[ERROR] HTTP ${resp.status} khi tải bài ${url}`);
    return ["", "", ""];
  }

  const html = await resp.text();
  const $ = cheerio.load(html);

  let title = extractTitle($);
  let date = extractDate($);
  let content = extractContent($);

  title = normalizeText(title);
  content = normalizeText(content);

  return [date, title, content];
}

// =========================
// Extract article links từ TRANG LIST/TAG
// =========================
async function extractArticleUrlsFromListingPage(listUrl) {
  log(`[LIST] Fetching listing page ${listUrl}`);
  let resp;
  try {
    resp = await fetchWithRetry(listUrl, { headers: HEADERS });
  } catch (e) {
    log(`[ERROR] Lỗi tải listing ${listUrl}: ${e}`);
    return [];
  }

  if (!resp.ok) {
    log(`[ERROR] HTTP ${resp.status} khi tải listing ${listUrl}`);
    return [];
  }

  const html = await resp.text();
  const $ = cheerio.load(html);

  const links = new Set();

  // Lấy mọi <a> trỏ tới .html trong domain vietnamnet.vn, bỏ các link -tag
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = normalizeUrl(href, listUrl);
    if (!abs) return;
    if (!abs.includes("vietnamnet.vn")) return;
    if (!abs.endsWith(".html")) return;
    if (isListingUrl(abs)) return; // không lấy tag khác

    links.add(abs);
  });

  const arr = Array.from(links);
  log(`[LIST] Found ${arr.length} article links in ${listUrl}`);
  return arr;
}

// =========================
// Term frequency
// =========================
function computeTermFreqs(text, patterns) {
  const freqs = {};
  for (const [kw, regex] of Object.entries(patterns)) {
    const matches = text.match(regex);
    freqs[kw] = matches ? matches.length : 0;
  }
  return freqs;
}

// =========================
// CSV helper
// =========================
function escapeCsvField(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCsvRow(filePath, fields) {
  const line = fields.map(escapeCsvField).join(",") + "\n";
  fs.appendFileSync(filePath, line, "utf8");
}

// =========================
// Main
// =========================
async function main() {
  const startTime = Date.now();

  if (process.argv.length !== 4) {
    log(
      "Usage: node main_vnnet.js START_IDX END_IDX  (1-based index của sitemap)"
    );
    process.exit(1);
  }

  let startIdx, endIdx;
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

  const keywords = loadKeywords(KEYWORDS_FILE);
  const patterns = buildKeywordPatterns(keywords);
  const sitemapUrlsAll = loadSitemapUrlsFromFile(SITEMAP_FILE);

  const nSitemaps = sitemapUrlsAll.length;
  if (startIdx > nSitemaps) {
    log(
      `[ERROR] START_IDX (${startIdx}) > tổng số sitemap (${nSitemaps})`
    );
    process.exit(1);
  }

  endIdx = Math.min(endIdx, nSitemaps);

  const sitemapUrls = sitemapUrlsAll.slice(startIdx - 1, endIdx);

  log(
    `[INFO] Sẽ crawl sitemap index từ ${startIdx} đến ${endIdx} / ${nSitemaps}`
  );

  const visitedArticles = new Set();
  let totalArticles = 0;

  const fieldnames = ["source", "newspaper", "date", "title", "content"].concat(
    keywords
  );

  const outPath = path.resolve(OUTPUT_CSV);
  const fileExists =
    fs.existsSync(outPath) && fs.statSync(outPath).size > 0;

  if (!fileExists) {
    writeCsvRow(outPath, fieldnames);
  }

  // helper xử lý 1 URL (có thể là article hoặc listing)
  const handleArticleOrListing = async (url) => {
    // Nếu là trang listing/tag => lấy tất cả link bài trong đó rồi crawl từng bài
    if (isListingUrl(url)) {
      const innerUrls = await extractArticleUrlsFromListingPage(url);
      await runTasksWithConcurrency(
        innerUrls,
        async (innerUrl) => {
          if (visitedArticles.has(innerUrl)) return;
          visitedArticles.add(innerUrl);

          await politeSleep();
          const [date, title, content] = await fetchArticle(innerUrl);

          if (!content && !title) return;
          if (!date) {
            log(`[SKIP] Không tìm được date cho bài: ${innerUrl}`);
            return;
          }

          const combinedText = `${title} ${content}`;
          const freqs = computeTermFreqs(combinedText, patterns);

          const rowObj = {
            source: innerUrl,
            newspaper: NEWSPAPER_NAME,
            date: date,
            title: title,
            content: content,
            ...freqs,
          };

          const row = fieldnames.map((fn) => rowObj[fn] ?? "");
          writeCsvRow(outPath, row);

          totalArticles += 1;
          if (totalArticles % PROGRESS_EVERY === 0) {
            log(
              `[INFO] Đã ghi ${totalArticles} bài (range sitemap ${startIdx}-${endIdx})`
            );
          }
        },
        ARTICLE_CONCURRENCY
      );
      return;
    }

    // Ngược lại: URL là bài chi tiết
    if (visitedArticles.has(url)) return;
    visitedArticles.add(url);

    await politeSleep();
    const [date, title, content] = await fetchArticle(url);

    if (!content && !title) return;
    if (!date) {
      log(`[SKIP] Không tìm được date cho bài: ${url}`);
      return;
    }

    const combinedText = `${title} ${content}`;
    const freqs = computeTermFreqs(combinedText, patterns);

    const rowObj = {
      source: url,
      newspaper: NEWSPAPER_NAME,
      date: date,
      title: title,
      content: content,
      ...freqs,
    };

    const row = fieldnames.map((fn) => rowObj[fn] ?? "");
    writeCsvRow(outPath, row);

    totalArticles += 1;
    if (totalArticles % PROGRESS_EVERY === 0) {
      log(
        `[INFO] Đã ghi ${totalArticles} bài (range sitemap ${startIdx}-${endIdx})`
      );
    }
  };

  try {
    await runTasksWithConcurrency(
      sitemapUrls,
      async (smUrl) => {
        await politeSleep();
        const articleUrls = await extractArticleUrlsFromSitemap(smUrl);

        await runTasksWithConcurrency(
          articleUrls,
          handleArticleOrListing,
          ARTICLE_CONCURRENCY
        );
      },
      SITEMAP_CONCURRENCY
    );
  } finally {
    // fs.appendFileSync tự handle
  }

  log(
    `[DONE] Tổng số bài ghi thêm trong lần chạy này: ${totalArticles}`
  );
  log(`[DONE] File output: ${OUTPUT_CSV}`);

  const endTime = Date.now();
  const elapsedMs = endTime - startTime;
  const elapsedMinutes = (elapsedMs / 60000).toFixed(2);
  log(`[TIME] Thời gian chạy: ${elapsedMinutes} phút`);
}

main().catch((err) => {
  console.error("[FATAL] Lỗi không mong muốn:", err);
  process.exit(1);
});
