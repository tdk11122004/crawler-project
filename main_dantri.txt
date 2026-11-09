#!/usr/bin/env node

/**
 * Crawler DanTri.com.vn dùng list URL + đếm term frequency theo keyword list.
 *
 * Input:
 *   - keywords.txt             : danh sách từ khóa (1 từ / cụm từ mỗi dòng)
 *   - dantri_article_urls.txt  : mỗi dòng 1 URL bài .htm/.html của Dantri
 *
 * Chạy:
 *   node main_dantri.js START_LINE END_LINE
 *   (chỉ số 1-based, theo thứ tự dòng trong dantri_article_urls.txt)
 *
 * Output:
 *   - dantri_articles.csv : file CSV (một bài báo = một dòng),
 *                           append thêm mỗi lần chạy.
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// =========================
// Config
// =========================
const KEYWORDS_FILE = "keywords.txt";
const ARTICLE_URLS_FILE = "dantri_article_urls.txt";
const OUTPUT_CSV = "dantri_articles.csv";

const NEWSPAPER_NAME = "DanTri";
const REQUEST_TIMEOUT = 10000; // ms
const MIN_DELAY = 200; // ms
const MAX_DELAY = 500; // ms
const PROGRESS_EVERY = 50;
const ARTICLE_CONCURRENCY = 1; // số bài fetch song song (nên để 1 cho Dantri)

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; DantriCrawler/1.0; +https://dantri.com.vn/)",
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

// FIX: tránh dính chữ khi Dantri tách câu thành nhiều inline nodes (span/span...) không có space trong HTML
function needsSpaceBetween(a, b) {
  if (!a || !b) return false;
  const last = a[a.length - 1];
  const first = b[0];
  if (/\s/.test(last) || /\s/.test(first)) return false;

  // Unicode letters/numbers (bắt được tiếng Việt có dấu)
  const isWordChar = (ch) => /[\p{L}\p{N}]/u.test(ch);
  return isWordChar(last) && isWordChar(first);
}

function extractSmartText($, rootEl) {
  const parts = [];

  const walk = (node) => {
    if (!node) return;

    if (node.type === "text") {
      if (node.data) parts.push(node.data);
      return;
    }

    if (node.type === "tag" && node.name === "br") {
      parts.push("\n");
      return;
    }

    const children = node.children || [];
    for (const child of children) walk(child);
  };

  walk(rootEl);

  let out = "";
  for (const p of parts) {
    if (!p) continue;
    if (out && needsSpaceBetween(out, p)) out += " ";
    out += p;
  }
  return out;
}

function escapeRegExp(str) {
  // dùng cho build regex từ keyword
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =========================
// Content cleaning (fix title/date bị dính vào content)
// =========================
function stripLeadingTitle(text, title) {
  let content = normalizeText(text || "");
  const t = normalizeText(title || "");
  if (!content || !t) return content;

  const cLower = content.toLowerCase();
  const tLower = t.toLowerCase();

  // Cắt nếu content bắt đầu bằng title
  if (cLower.startsWith(tLower)) {
    content = normalizeText(content.slice(t.length));
  }
  // Một số bài bị lặp title 2 lần
  if (content.toLowerCase().startsWith(tLower)) {
    content = normalizeText(content.slice(t.length));
  }
  return content;
}

function cleanContent(rawContent, title = "", date = "") {
  let content = normalizeText(rawContent || "");
  if (!content) return "";

  // 1) remove title prefix
  content = stripLeadingTitle(content, title);

  // 2) remove leading time blocks: "Thứ tư, 28/09/2005 - 14:13" (có thể lặp)
  const VN_WEEKDAY = "(?:Thứ\\s*(?:hai|ba|tư|năm|sáu|bảy)|Chủ\\s*nhật)";
  const DATE_DMY = "\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{4}";
  const TIME_HM = "\\d{1,2}:\\d{2}";
  const HEAD_TIME_BLOCK = new RegExp(
    "^\\s*(?:(?:" +
      VN_WEEKDAY +
      ")\\s*,?\\s*(?:" +
      DATE_DMY +
      ")(?:\\s*-\\s*(?:" +
      TIME_HM +
      "))?\\s*){1,3}",
    "i"
  );
  content = normalizeText(content.replace(HEAD_TIME_BLOCK, ""));

  // 3) remove leading date if still present (dd/mm/yyyy ...)
  if (date) {
    const d = normalizeText(date);
    const reDatePrefix = new RegExp(
      "^\\s*" + escapeRegExp(d) + "(?:\\s*-\\s*" + TIME_HM + ")?\\s*",
      "i"
    );
    content = normalizeText(content.replace(reDatePrefix, ""));
  }

  // 4) trim leading separators
  content = content.replace(/^[\-\–\—\|:]+/g, "").trim();

  return content;
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
// Load article URLs (simple txt)
// =========================
function loadArticleUrlsFromFile(filePath) {
  const p = path.resolve(filePath);
  if (!fs.existsSync(p)) {
    log(`[ERROR] Không tìm thấy file URL bài báo: ${filePath}`);
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
    log("[ERROR] Không có URL nào trong dantri_article_urls.txt");
    process.exit(1);
  }

  log(`[INFO] Loaded ${urls.length} article URLs từ file dantri_article_urls.txt`);
  return urls;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeSleep() {
  const delay = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
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
      // Dantri hay trả 428/429 khi bị rate limit
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
    ".dt-news__time",
    ".dt-news__meta",
    ".singular__meta",
    "[data-role='publishdate']",
    "span.time",
    "span.date",
    "div.time",
    "div.date",
    "time",
  ];

  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el || el.length === 0) continue;

    const text = el.text().replace(/\s+/g, " ").trim();
    const m = text.match(DATE_REGEX);
    if (m) {
      return m[0];
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

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const m = bodyText.match(DATE_REGEX);
  if (m) return m[0];

  return "";
}

/**
 * FIX: chỉ lấy thân bài từ <p> trong container, tránh kéo title + time
 */
function extractContent($) {
  const selectors = [
    "div.dt-news__content",
    "div.dt-news__body",
    "div.singular-content",
    "div.singular__content",
    "div.detail-content",
    "div.article-body",
    "article .content",
    "article",
  ];

  let container = null;
  for (const sel of selectors) {
    const cand = $(sel).first();
    if (cand && cand.length) {
      container = cand;
      break;
    }
  }
  if (!container || !container.length) container = $("article").first();
  if (!container || !container.length) container = $("body");

  // Remove rác
  container.find("script, style, noscript, iframe").remove();

  // Remove các block không phải nội dung bài
  container
    .find(
      ".breadcrumb, .comment, .related, .suggest, .social, .share, .tags, .footer, .header, nav, .ads, .quangcao, .qc, .keyword, .tin-lien-quan, .author, .dt-news__tag, .dt-news__related"
    )
    .remove();

  // Tránh dính title/time nếu chúng nằm trong container
  container.find("h1, time, .dt-news__time, .dt-news__meta, .dt-news__title").remove();

  // Lấy chủ yếu là các đoạn <p>
  const paras = [];
  container.find("p").each((_, el) => {
    const txt = normalizeText(extractSmartText($, el));
    if (!txt) return;

    // lọc đoạn siêu ngắn (caption/rác)
    if (txt.length < 20) return;
    paras.push(txt);
  });

  // Fallback nếu không có <p>
  let text = paras.length ? paras.join("\n") : extractSmartText($, container.get(0));

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

  let title = extractTitle($);
  let date = extractDate($);
  let content = extractContent($);

  title = normalizeText(title);
  content = cleanContent(content, title, date);

  return [date, title, content];
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

  // Parse tham số dòng lệnh
  if (process.argv.length !== 4) {
    log(
      "Usage: node main_dantri.js START_LINE END_LINE  (1-based index của dòng URL trong dantri_article_urls.txt)"
    );
    process.exit(1);
  }

  let startLine, endLine;
  try {
    startLine = parseInt(process.argv[2], 10);
    endLine = parseInt(process.argv[3], 10);
  } catch (e) {
    log("[ERROR] START_LINE và END_LINE phải là số nguyên.");
    process.exit(1);
  }

  if (isNaN(startLine) || isNaN(endLine)) {
    log("[ERROR] START_LINE và END_LINE phải là số nguyên.");
    process.exit(1);
  }

  if (startLine <= 0 || endLine < startLine) {
    log("[ERROR] START_LINE phải >= 1 và END_LINE >= START_LINE.");
    process.exit(1);
  }

  const keywords = loadKeywords(KEYWORDS_FILE);
  const patterns = buildKeywordPatterns(keywords);
  const articleUrlsAll = loadArticleUrlsFromFile(ARTICLE_URLS_FILE);

  const nArticles = articleUrlsAll.length;
  if (startLine > nArticles) {
    log(
      `[ERROR] START_LINE (${startLine}) > tổng số URL (${nArticles}) trong dantri_article_urls.txt`
    );
    process.exit(1);
  }

  endLine = Math.min(endLine, nArticles);

  const articleUrls = articleUrlsAll.slice(startLine - 1, endLine);

  log(
    `[INFO] Sẽ crawl URL dòng từ ${startLine} đến ${endLine} / ${nArticles} trong dantri_article_urls.txt`
  );

  const visitedArticles = new Set();
  let totalArticles = 0;

  const fieldnames = ["source", "newspaper", "date", "title", "content"].concat(
    keywords
  );

  const outPath = path.resolve(OUTPUT_CSV);
  const fileExists = fs.existsSync(outPath) && fs.statSync(outPath).size > 0;

  if (!fileExists) {
    writeCsvRow(outPath, fieldnames);
  }

  try {
    await runTasksWithConcurrency(
      articleUrls,
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
            `[INFO] Đã ghi ${totalArticles} bài (range dòng ${startLine}-${endLine})`
          );
        }
      },
      ARTICLE_CONCURRENCY
    );
  } finally {
    // fs.appendFileSync tự handle
  }

  log(`[DONE] Tổng số bài ghi thêm trong lần chạy này: ${totalArticles}`);
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
