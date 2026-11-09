#!/usr/bin/env node

/**
 * Crawler VnExpress.net theo category (phân trang -p2, -p3, ...) + đếm term frequency theo keyword list.
 *
 * Input:
 *   - keywords.txt               : danh sách từ khóa (1 từ / cụm từ mỗi dòng)
 *   - vnexpress_categories.txt   : mỗi dòng 1 URL category của VnExpress
 *                                 (vd: https://vnexpress.net/thoi-su/chinh-tri)
 *
 * Chạy:
 *   node main_vnexpress.js START_IDX END_IDX
 *   (chỉ số 1-based, theo thứ tự URL trong vnexpress_categories.txt)
 *
 * Output:
 *   - vnexpress_articles.csv : file CSV (một bài báo = một dòng),
 *                             append thêm mỗi lần chạy.
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// =========================
// Config
// =========================
const KEYWORDS_FILE = "keywords.txt";
const CATEGORY_FILE = "vnexpress_categories.txt";
const OUTPUT_CSV = "vnexpress_articles.csv";

const NEWSPAPER_NAME = "VnExpress";

const REQUEST_TIMEOUT = 12000; // ms
const MIN_DELAY = 300; // ms
const MAX_DELAY = 900; // ms
const PROGRESS_EVERY = 50;

const CATEGORY_CONCURRENCY = 2;
const ARTICLE_CONCURRENCY = 6;

// Chặn an toàn cho phân trang category
const MAX_PAGES_PER_CATEGORY = 2000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; VnExpressCrawler/1.0; +https://vnexpress.net/)",
  "Accept-Language": "vi,en;q=0.9",
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
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        log(`[WORKER] Error: ${err && err.message ? err.message : err}`);
      }
    })();
    running.add(p);
    p.finally(() => running.delete(p));
  }
  if (running.size) await Promise.all(Array.from(running));
}

// =========================
// Loaders
// =========================
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
    // giữ như bản Tuổi Trẻ của bạn: word-boundary (tùy keyword có dấu/space vẫn match ổn)
    const pattern = new RegExp("\\b" + escapeRegExp(kw) + "\\b", "gi");
    patterns[kw] = pattern;
  }
  return patterns;
}

function loadCategoryUrlsFromFile(filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) {
    log(`[ERROR] Không tìm thấy file category: ${filePath}`);
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
    log("[ERROR] Không có URL nào trong vnexpress_categories.txt");
    process.exit(1);
  }

  log(`[INFO] Loaded ${urls.length} category URLs từ file vnexpress_categories.txt`);
  return urls;
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

      if (res.status >= 500 && res.status < 600) throw new Error(`HTTP_${res.status}`);
      if (res.status === 429) throw new Error("HTTP_429");

      return res;
    } catch (err) {
      const last = attempt === maxRetries;
      const msg = String(err.message || "");
      const jitter = Math.random() * 250;
      let backoff = Math.pow(2, attempt) * BACKOFF_BASE + jitter;

      if (msg.includes("HTTP_429")) {
        backoff *= 3;
        log(`[RATE-LIMIT] ${url} – ngủ ${(backoff / 1000).toFixed(1)}s trước khi thử lại`);
      }

      if (last) throw err;
      await sleep(backoff);
    }
  }
}

// =========================
// Pagination helpers (VnExpress -p2, -p3...)
// =========================
function stripTrailingSlash(u) {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}

function stripPageSuffix(catUrl) {
  // https://vnexpress.net/thoi-su/chinh-tri-p2  -> .../chinh-tri
  // https://vnexpress.net/chu-de/hoi-nghi-...-p2 -> ... (giữ nguyên slug, bỏ -p2)
  const s = stripTrailingSlash(catUrl);
  return s.replace(/-p\d+$/i, "");
}

function buildCategoryPageUrl(catUrl, page) {
  const base = stripPageSuffix(catUrl);
  if (page === 1) return base;
  return `${base}-p${page}`;
}

// =========================
// URL extraction helpers
// =========================
function extractArticleUrlsFromHtml($) {
  const urls = new Set();

  $("a[href]").each((_, el) => {
    let href = $(el).attr("href");
    if (!href) return;
    href = href.trim();

    if (
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("mailto:")
    ) {
      return;
    }

    let fullUrl;
    try {
      fullUrl = new URL(href, "https://vnexpress.net").toString();
    } catch {
      return;
    }

    if (!fullUrl.includes("vnexpress.net")) return;

    // bài VnExpress thường .html
    if (!/\.html(\?|$)/i.test(fullUrl)) return;

    // loại các URL không phải bài (một số trang service, tag)
    if (/\/tim-kiem/i.test(fullUrl)) return;

    urls.add(fullUrl.split("#")[0]);
  });

  return Array.from(urls);
}

// =========================
// Article parsing
// =========================
function extractTitle($) {
  const h1 = $("h1").first();
  if (h1.length && h1.text().trim()) return h1.text().trim();

  const og = $('meta[property="og:title"]').first();
  if (og.length && og.attr("content")) return og.attr("content").trim();

  const title = $("title").first();
  if (title.length && title.text().trim()) return title.text().trim();

  return "";
}

function isoToDmy(iso) {
  // iso: 2025-12-12T08:12:00+07:00
  const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const [, y, mo, d] = m;
  return `${d}/${mo}/${y}`;
}

function extractDate($) {
  // ưu tiên meta
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[property="article:modified_time"]',
    'meta[name="pubdate"]',
    'meta[name="publish-date"]',
    'meta[name="date"]',
    'meta[itemprop="datePublished"]',
  ];

  for (const sel of metaSelectors) {
    const el = $(sel).first();
    const content = el && el.attr("content");
    if (content) {
      const dmy = isoToDmy(content);
      if (dmy) return dmy;
    }
  }

  // fallback: <time datetime="...">
  const t = $("time").first();
  if (t && t.attr("datetime")) {
    const dmy = isoToDmy(t.attr("datetime"));
    if (dmy) return dmy;
  }

  // fallback text scan dd/mm/yyyy hoặc dd-mm-yyyy
  const DATE_REGEX = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}\b/;
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const m = bodyText.match(DATE_REGEX);
  return m ? m[0] : "";
}

function extractContent($) {
  // VnExpress thường dùng .fck_detail cho thân bài
  let container =
    $(".fck_detail").first().length ? $(".fck_detail").first() : null;

  if (!container || container.length === 0) {
    const art = $("article").first();
    if (art.length) container = art;
  }
  if (!container || container.length === 0) container = $("body");

  // remove noisy blocks
  container.find("script, style, noscript, iframe").remove();
  container
    .find(
      ".box-tinlienquan, .box_comment, .footer, .header, .social, .share, .tag, .ads, .qc, .quangcao"
    )
    .remove();

  const parts = [];
  container.find("p, h2, h3, li").each((_, el) => {
    const cls = ($(el).attr("class") || "").toLowerCase();
    if (
      /meta|time|date|author|byline|share|social|tag|comment|ads|qc|quangcao|related|tinlienquan/i.test(
        cls
      )
    ) {
      return;
    }
    const txt = $(el).text().replace(/\s+/g, " ").trim();
    if (txt) parts.push(txt);
  });

  let text = parts.join("\n").trim();
  if (!text) text = container.text().replace(/\s+/g, " ").trim();
  if (!text) text = $("body").text().replace(/\s+/g, " ").trim();

  // quan trọng: gom về 1 ô CSV (không newline)
  return normalizeText(text);
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

  let title = normalizeText(extractTitle($));
  let date = normalizeText(extractDate($));
  let content = extractContent($);

  return [date, title, content];
}

// =========================
// Term frequency + CSV
// =========================
function computeTermFreqs(text, patterns) {
  const freqs = {};
  for (const [kw, regex] of Object.entries(patterns)) {
    const matches = text.match(regex);
    freqs[kw] = matches ? matches.length : 0;
  }
  return freqs;
}

function escapeCsvField(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function writeCsvRow(filePath, fields) {
  const line = fields.map(escapeCsvField).join(",") + "\n";
  fs.appendFileSync(filePath, line, "utf8");
}

// =========================
// Crawl 1 category (VnExpress phân trang -p2)
// =========================
async function crawlCategory(
  categoryUrl,
  patterns,
  fieldnames,
  outPath,
  visitedArticles,
  counters
) {
  const base = stripPageSuffix(categoryUrl);
  log(`[CAT] Bắt đầu category: ${base}`);

  const articleUrls = new Set();

  for (let page = 1; page <= MAX_PAGES_PER_CATEGORY; page++) {
    const pageUrl = buildCategoryPageUrl(base, page);
    await politeSleep();

    let resp;
    try {
      resp = await fetchWithRetry(pageUrl, { headers: HEADERS });
    } catch (e) {
      log(`[CAT] Lỗi tải page ${pageUrl}: ${e}`);
      break;
    }

    if (!resp.ok) {
      if (resp.status === 404) {
        log(`[CAT] ${pageUrl} trả 404, dừng category.`);
        break;
      }
      log(`[CAT] HTTP ${resp.status} khi tải ${pageUrl}, dừng category.`);
      break;
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    const urls = extractArticleUrlsFromHtml($);
    if (urls.length === 0) {
      log(`[CAT] ${pageUrl} không có URL bài nào, dừng category.`);
      break;
    }

    const before = articleUrls.size;
    for (const u of urls) articleUrls.add(u);
    const added = articleUrls.size - before;

    log(
      `[CAT] ${base} – Page ${page} (${pageUrl}): thấy ${urls.length} URL, mới thêm ${added}, tổng unique: ${articleUrls.size}`
    );

    // nếu page mới không thêm gì -> thường là lặp/đụng cache, dừng sớm
    if (page > 1 && added === 0) {
      log(`[CAT] ${pageUrl} không thêm URL mới, dừng category.`);
      break;
    }
  }

  log(`[CAT] Category ${base} – tổng bài unique thu được: ${articleUrls.size}`);

  await runTasksWithConcurrency(
    Array.from(articleUrls),
    async (artUrl) => {
      if (visitedArticles.has(artUrl)) return;
      visitedArticles.add(artUrl);

      await politeSleep();
      const [date, title, content] = await fetchArticle(artUrl);

      if (!content && !title) return;
      if (!date) {
        log(`[SKIP] Không tìm được date cho bài: ${artUrl}`);
        return;
      }

      const combinedText = `${title} ${content}`;
      const freqs = computeTermFreqs(combinedText, patterns);

      const rowObj = {
        source: artUrl,
        newspaper: NEWSPAPER_NAME,
        date,
        title,
        content,
        ...freqs,
      };

      const row = fieldnames.map((fn) => rowObj[fn] ?? "");
      writeCsvRow(outPath, row);

      counters.totalArticles += 1;
      if (counters.totalArticles % PROGRESS_EVERY === 0) {
        log(`[INFO] Đã ghi ${counters.totalArticles} bài (các category range đang crawl)`);
      }
    },
    ARTICLE_CONCURRENCY
  );
}

// =========================
// Main
// =========================
async function main() {
  const startTime = Date.now();

  if (process.argv.length !== 4) {
    log(
      "Usage: node main_vnexpress.js START_IDX END_IDX  (1-based index của category trong vnexpress_categories.txt)"
    );
    process.exit(1);
  }

  let startIdx = parseInt(process.argv[2], 10);
  let endIdx = parseInt(process.argv[3], 10);

  if (isNaN(startIdx) || isNaN(endIdx) || startIdx <= 0 || endIdx < startIdx) {
    log("[ERROR] START_IDX phải >= 1 và END_IDX >= START_IDX.");
    process.exit(1);
  }

  const keywords = loadKeywords(KEYWORDS_FILE);
  const patterns = buildKeywordPatterns(keywords);
  const categoryUrlsAll = loadCategoryUrlsFromFile(CATEGORY_FILE);

  const nCategories = categoryUrlsAll.length;
  if (startIdx > nCategories) {
    log(`[ERROR] START_IDX (${startIdx}) > tổng số category (${nCategories})`);
    process.exit(1);
  }

  endIdx = Math.min(endIdx, nCategories);
  const categoryUrls = categoryUrlsAll.slice(startIdx - 1, endIdx);

  log(`[INFO] Sẽ crawl category index từ ${startIdx} đến ${endIdx} / ${nCategories}`);

  const visitedArticles = new Set();
  const counters = { totalArticles: 0 };

  const fieldnames = ["source", "newspaper", "date", "title", "content"].concat(keywords);

  const outPath = path.resolve(OUTPUT_CSV);
  const fileExists = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  if (!fileExists) writeCsvRow(outPath, fieldnames);

  await runTasksWithConcurrency(
    categoryUrls,
    async (catUrl) => {
      await crawlCategory(catUrl, patterns, fieldnames, outPath, visitedArticles, counters);
    },
    CATEGORY_CONCURRENCY
  );

  log(`[DONE] Tổng số bài ghi thêm trong lần chạy này: ${counters.totalArticles}`);
  log(`[DONE] File output: ${OUTPUT_CSV}`);

  const elapsedMinutes = ((Date.now() - startTime) / 60000).toFixed(2);
  log(`[TIME] Thời gian chạy: ${elapsedMinutes} phút`);
}

main().catch((err) => {
  console.error("[FATAL] Lỗi không mong muốn:", err);
  process.exit(1);
});
