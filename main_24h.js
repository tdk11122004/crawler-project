#!/usr/bin/env node
/**
 * 24h Crawler (sitemap -> articles) + term frequency
 *
 * MODE:
 *  - sitemap   : read sitemap_24h.txt, args are START_IDX END_IDX (1-based)
 *  - retry503  : read failed_503.txt (article urls), args are START_IDX END_IDX (1-based)
 *
 * Usage:
 *   node main_24h.js START_IDX END_IDX sitemap
 *   node main_24h.js START_IDX END_IDX retry503
 *
 * Outputs:
 *  - 24h_articles.csv (append)
 *  - failed_503.txt   (append, dedup in-memory per run)
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const zlib = require("zlib");

// =========================
// Config
// =========================
const KEYWORDS_FILE = "keywords.txt";
const SITEMAP_FILE = "sitemap_24h.txt";
const OUTPUT_CSV = "24h_articles.csv";

const FAILED_503_FILE = "failed_503.txt"; // append

const NEWSPAPER_NAME = "24h";
const REQUEST_TIMEOUT = 18000; // ms
const MIN_DELAY = 500;         // ms
const MAX_DELAY = 1100;        // ms
const PROGRESS_EVERY = 50;

const SITEMAP_CONCURRENCY = 3;
const ARTICLE_CONCURRENCY = 4;

const HEADERS_XML = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "application/xml,text/xml,*/*;q=0.9",
  "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
  "Connection": "keep-alive",
};

const HEADERS_HTML = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
  "Connection": "keep-alive",
};

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 5;
const BACKOFF_BASE = 600; // ms

// =========================
// Utils
// =========================
function log(msg) {
  console.error(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function politeSleep() {
  const delay = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  await sleep(delay);
}

function normalizeText(text) {
  if (!text) return "";
  return text.replace(/\r|\n|\t/g, " ").replace(/\s+/g, " ").trim();
}

function removeSavedBanner(text) {
  if (!text) return "";

  // Chuẩn hoá để match ổn định dù có xuống dòng / nhiều spaces
  let t = String(text).replace(/\s+/g, " ").trim();

  const phrase =
    "Lưu bài viết thành công Bạn có thể xem lại bài viết đã lưu ở trang Tin bài đã lưu";

  // Xoá đúng cụm (case-insensitive) + dọn khoảng trắng
  const re = new RegExp(escapeRegExp(phrase), "gi");
  t = t.replace(re, " ").replace(/\s+/g, " ").trim();

  return t;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsvRow(filePath, fields) {
  fs.appendFileSync(filePath, fields.map(csvEscape).join(",") + "\n", "utf8");
}

function loadLines(filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) return [];
  const content = fs.readFileSync(p, "utf8");
  return content
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("#"));
}

function loadKeywords(filePath) {
  const keywords = loadLines(filePath);
  if (keywords.length === 0) {
    log(`[ERROR] keywords.txt trống hoặc không tồn tại`);
    process.exit(1);
  }
  log(`[INFO] Loaded ${keywords.length} keywords`);
  return keywords;
}

function buildKeywordPatterns(keywords) {
  const patterns = {};
  for (const kw of keywords) {
    patterns[kw] = new RegExp("\\b" + escapeRegExp(kw) + "\\b", "gi");
  }
  return patterns;
}

function computeTermFreqs(text, patterns) {
  const freqs = {};
  for (const [kw, regex] of Object.entries(patterns)) {
    const m = text.match(regex);
    freqs[kw] = m ? m.length : 0;
  }
  return freqs;
}

// =========================
// 503 logging
// =========================
const failed503SeenThisRun = new Set();

function appendFailed503(url) {
  if (!url) return;
  const u = String(url).trim();
  if (!u) return;
  if (failed503SeenThisRun.has(u)) return;
  failed503SeenThisRun.add(u);
  fs.appendFileSync(FAILED_503_FILE, u + "\n", "utf8");
}

// =========================
// Concurrency runner
// =========================
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
        log(`[WORKER] Error: ${err?.message || err}`);
      }
    })();
    running.add(p);
    p.finally(() => running.delete(p));
  }
  if (running.size) await Promise.all(Array.from(running));
}

function shouldRetryStatus(status) {
  // retry for rate limit / server issues
  return status === 503 || status === 403 || status === 408 || status === 429 || (status >= 500 && status < 600);
}

// =========================
// Fetch with retry (records 503 at final failure)
// =========================
async function fetchWithRetry(url, headers, timeout = REQUEST_TIMEOUT, maxRetries = MAX_RETRIES) {
  let lastStatus = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);

      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers,
        signal: controller.signal,
      });

      clearTimeout(id);
      lastStatus = res.status;

      // explicit 404: no retry
      if (res.status === 404) return res;

      // if should retry, throw to backoff
      if (shouldRetryStatus(res.status)) {
        throw new Error(`HTTP ${res.status}`);
      }

      return res;
    } catch (err) {
      const isLast = attempt === maxRetries;
      if (isLast) {
        // if last known status is 503 or error message indicates 503 -> log URL
        const msg = String(err?.message || "");
        if (lastStatus === 503 || msg.includes("HTTP 503")) {
          appendFailed503(url);
        }
        throw err;
      }
      const jitter = Math.random() * 350;
      const backoff = Math.pow(2, attempt) * BACKOFF_BASE + jitter;
      await sleep(backoff);
    }
  }
}

// =========================
// 24h URL classify
// =========================
function isArticleUrl(url) {
  const u = String(url).toLowerCase();
  if (!u.includes("24h.com.vn")) return false;
  return (
    u.endsWith(".htm") ||
    /-a\d+\.html$/i.test(u) ||
    /\/\d+\.html$/i.test(u) ||
    u.endsWith(".html")
  );
}

// =========================
// Sitemap parsing (supports gzip even if .xml)
// =========================
function gunzipIfNeeded(buf) {
  if (buf && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return zlib.gunzipSync(buf);
    } catch {
      return buf;
    }
  }
  return buf;
}

async function fetchXmlText(sitemapUrl) {
  let res;
  try {
    res = await fetchWithRetry(sitemapUrl, HEADERS_XML);
  } catch (e) {
    log(`[SITEMAP][ERROR] ${sitemapUrl} -> ${e?.message || e}`);
    return "";
  }

  if (!res.ok) {
    // if 503, fetchWithRetry already logged it into failed_503.txt
    log(`[SITEMAP][ERROR] HTTP ${res.status} for ${sitemapUrl}`);
    return "";
  }

  const ab = await res.arrayBuffer();
  let buf = Buffer.from(ab);

  // FIX: gunzip based on magic bytes
  buf = gunzipIfNeeded(buf);

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("gzip") || ct.includes("octet-stream")) {
    buf = gunzipIfNeeded(buf);
  }

  return buf.toString("utf8");
}

function parseLocsFromXml(xmlText) {
  const $ = cheerio.load(xmlText, { xmlMode: true });
  const locs = [];
  $("loc").each((_, el) => {
    const u = $(el).text().trim();
    if (u) locs.push(u);
  });
  return locs;
}

function isSitemapIndexXml(xmlText) {
  return /<\s*sitemapindex\b/i.test(xmlText);
}

async function extractArticleUrlsFromSitemap(sitemapUrl) {
  log(`[SITEMAP] Fetching ${sitemapUrl}`);
  const xml = await fetchXmlText(sitemapUrl);
  if (!xml) return [];

  const locs = parseLocsFromXml(xml);
  if (locs.length === 0) {
    // helpful debug: often means blocked/HTML returned
    const snip = xml.slice(0, 150).replace(/\s+/g, " ");
    log(`[SITEMAP][DEBUG] 0 <loc>. Snippet: ${snip}`);
    return [];
  }

  // sitemapindex -> expand children (1 level)
  if (isSitemapIndexXml(xml)) {
    const childSitemaps = locs.filter((u) => /sitemap/i.test(u) && (u.endsWith(".xml") || u.endsWith(".xml.gz")));
    const out = new Set();

    await runTasksWithConcurrency(
      childSitemaps,
      async (childUrl) => {
        await politeSleep();
        const childXml = await fetchXmlText(childUrl);
        if (!childXml) return;
        const childLocs = parseLocsFromXml(childXml);
        for (const u of childLocs) {
          if (isArticleUrl(u)) out.add(u);
        }
      },
      1
    );

    const arr = Array.from(out);
    log(`[SITEMAP] Found ${arr.length} article URLs via sitemapindex ${sitemapUrl}`);
    return arr;
  }

  // urlset direct
  const out = [];
  for (const u of locs) {
    if (isArticleUrl(u)) out.push(u);
  }
  log(`[SITEMAP] Found ${out.length} article URLs in ${sitemapUrl}`);
  return out;
}

// =========================
// Article parsing (basic)
// =========================
const DATE_DMY = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/;
const DATE_YMD = /\b(\d{4})-(\d{2})-(\d{2})\b/;

function extractTitle($) {
  const h1 = $("h1").first();
  if (h1.length && h1.text().trim()) return h1.text().trim();

  const og = $('meta[property="og:title"]').first();
  if (og.length && og.attr("content")) return og.attr("content").trim();

  const t = $("title").first();
  if (t.length && t.text().trim()) return t.text().trim();

  return "";
}

function extractDate($) {
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="pubdate"]',
    'meta[name="date"]',
    'meta[itemprop="datePublished"]',
  ];

  for (const sel of metaSelectors) {
    const el = $(sel).first();
    const c = el?.attr("content") ? String(el.attr("content")) : "";
    if (!c) continue;

    const m1 = c.match(DATE_DMY);
    if (m1) return m1[0];

    const m2 = c.match(DATE_YMD);
    if (m2) return `${m2[3]}/${m2[2]}/${m2[1]}`;
  }

  const timeEl = $("time").first();
  if (timeEl.length) {
    const txt = timeEl.text().replace(/\s+/g, " ").trim();
    const m = txt.match(DATE_DMY);
    if (m) return m[0];

    const dt = timeEl.attr("datetime");
    if (dt) {
      const m2 = dt.match(DATE_YMD);
      if (m2) return `${m2[3]}/${m2[2]}/${m2[1]}`;
    }
  }

  const body = $("body").text().replace(/\s+/g, " ").trim();
  const m = body.match(DATE_DMY);
  if (m) return m[0];

  return "";
}

function extractContent($) {
  const selectors = [
    ".text-conent",
    ".textcontent",
    ".news-content",
    ".article-content",
    ".article-body",
    ".detail-content",
    "#article_body",
    "article",
  ];

  let container = null;
  for (const sel of selectors) {
    const c = $(sel).first();
    if (c && c.length) { container = c; break; }
  }
  if (!container) container = $("body");

  container.find("script, style, noscript, iframe").remove();

  const parts = [];
  container.find("p, h2, h3, li").each((_, el) => {
    const txt = $(el).text().replace(/\s+/g, " ").trim();
    if (txt) parts.push(txt);
  });

  let text = parts.join("\n").trim();
  if (!text) text = container.text().replace(/\s+/g, " ").trim();
  return text;
}

async function fetchArticle(url) {
  let res;
  try {
    res = await fetchWithRetry(url, HEADERS_HTML);
  } catch (e) {
    // if final was 503, fetchWithRetry already appended url to failed_503.txt
    log(`[ARTICLE][ERROR] ${url} -> ${e?.message || e}`);
    return ["", "", ""];
  }

  if (!res.ok) {
    // if 503, logged already
    log(`[ARTICLE][ERROR] HTTP ${res.status} for ${url}`);
    if (res.status === 503) appendFailed503(url);
    return ["", "", ""];
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const title = normalizeText(extractTitle($));
  const date = extractDate($);
  const content = removeSavedBanner(normalizeText(extractContent($)));


  return [date, title, content];
}

// =========================
// Main
// =========================
async function main() {
  const startTime = Date.now();

  // args: START END MODE
  if (process.argv.length < 4) {
    log("Usage: node main_24h.js START_IDX END_IDX [sitemap|retry503]");
    process.exit(1);
  }

  const startIdx = parseInt(process.argv[2], 10);
  let endIdx = parseInt(process.argv[3], 10);
  const mode = (process.argv[4] || "sitemap").trim();

  if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx) || startIdx <= 0 || endIdx < startIdx) {
    log("[ERROR] START_IDX phải >= 1 và END_IDX >= START_IDX.");
    process.exit(1);
  }

  // prepare output header
  const keywords = loadKeywords(KEYWORDS_FILE);
  const patterns = buildKeywordPatterns(keywords);
  const fieldnames = ["source", "newspaper", "date", "title", "content"].concat(keywords);

  const outPath = path.resolve(OUTPUT_CSV);
  const fileExists = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
  if (!fileExists) writeCsvRow(outPath, fieldnames);

  let inputList = [];
  if (mode === "sitemap") {
    inputList = loadLines(SITEMAP_FILE);
    log(`[INFO] Loaded ${inputList.length} sitemap URLs từ ${SITEMAP_FILE}`);
  } else if (mode === "retry503") {
    inputList = loadLines(FAILED_503_FILE);
    log(`[INFO] Loaded ${inputList.length} failed URLs từ ${FAILED_503_FILE}`);
  } else {
    log(`[ERROR] MODE không hợp lệ. Dùng 'sitemap' hoặc 'retry503'.`);
    process.exit(1);
  }

  if (inputList.length === 0) {
    log(`[ERROR] Input list trống. (mode=${mode})`);
    process.exit(1);
  }

  if (startIdx > inputList.length) {
    log(`[ERROR] START_IDX (${startIdx}) > tổng dòng (${inputList.length})`);
    process.exit(1);
  }
  endIdx = Math.min(endIdx, inputList.length);

  const slice = inputList.slice(startIdx - 1, endIdx);
  log(`[INFO] MODE=${mode}. Running from ${startIdx} to ${endIdx} / ${inputList.length}`);

  const visitedArticles = new Set();
  let totalArticles = 0;

  const handleOneArticleUrl = async (url) => {
    if (!isArticleUrl(url)) return;
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

    const rowObj = { source: url, newspaper: NEWSPAPER_NAME, date, title, content, ...freqs };
    const row = fieldnames.map((fn) => rowObj[fn] ?? "");
    writeCsvRow(outPath, row);

    totalArticles += 1;
    if (totalArticles % PROGRESS_EVERY === 0) {
      log(`[INFO] Đã ghi ${totalArticles} bài (mode=${mode} range ${startIdx}-${endIdx})`);
    }
  };

  if (mode === "retry503") {
    // Input is already article URLs
    await runTasksWithConcurrency(slice, handleOneArticleUrl, ARTICLE_CONCURRENCY);
  } else {
    // mode === sitemap
    await runTasksWithConcurrency(
      slice,
      async (sitemapUrl) => {
        await politeSleep();
        const articleUrls = await extractArticleUrlsFromSitemap(sitemapUrl);
        await runTasksWithConcurrency(articleUrls, handleOneArticleUrl, ARTICLE_CONCURRENCY);
      },
      SITEMAP_CONCURRENCY
    );
  }

  log(`[DONE] Tổng số bài ghi thêm trong lần chạy này: ${totalArticles}`);
  log(`[DONE] File output: ${OUTPUT_CSV}`);
  log(`[DONE] 503 URLs appended to: ${FAILED_503_FILE}`);
  log(`[TIME] Thời gian chạy: ${((Date.now() - startTime) / 60000).toFixed(2)} phút`);
}

main().catch((err) => {
  console.error("[FATAL] Lỗi không mong muốn:", err);
  process.exit(1);
});
