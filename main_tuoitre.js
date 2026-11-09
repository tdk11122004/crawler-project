#!/usr/bin/env node

/**
 * Crawler TuoiTre.vn theo category (không dùng sitemap) + đếm term frequency theo keyword list.
 *
 * Input:
 *   - keywords.txt             : danh sách từ khóa (1 từ / cụm từ mỗi dòng)
 *   - tuoitre_categories.txt   : mỗi dòng 1 URL category của Tuổi Trẻ
 *                                (vd: https://tuoitre.vn/kinh-doanh.htm)
 *
 * Chạy:
 *   node main_tuoitre.js START_IDX END_IDX
 *   (chỉ số 1-based, theo thứ tự URL trong tuoitre_categories.txt)
 *
 * Output:
 *   - tuoitre_articles.csv : file CSV (một bài báo = một dòng),
 *                            append thêm mỗi lần chạy.
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// =========================
// Config
// =========================
const KEYWORDS_FILE = "keywords.txt";
const CATEGORY_FILE = "tuoitre_categories.txt";
const OUTPUT_CSV = "tuoitre_articles.csv";

const NEWSPAPER_NAME = "TuoiTre";
const REQUEST_TIMEOUT = 12000; // ms
const MIN_DELAY = 300;         // ms
const MAX_DELAY = 900;         // ms
const PROGRESS_EVERY = 50;

const CATEGORY_CONCURRENCY = 2;     // số category xử lý song song
const ARTICLE_CONCURRENCY = 5;      // số bài fetch song song
const MAX_PAGES_PER_TIMELINE = 2000; // chặn an toàn, tránh infinite loop

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; TuoiTreCrawler/1.0; +https://tuoitre.vn/)",
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
    log("[ERROR] Không có URL nào trong tuoitre_categories.txt");
    process.exit(1);
  }

  log(
    `[INFO] Loaded ${urls.length} category URLs từ file tuoitre_categories.txt`
  );
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

      if (res.status >= 500 && res.status < 600) {
        throw new Error(`HTTP_${res.status}`);
      }
      if (res.status === 429) {
        throw new Error("HTTP_429");
      }

      return res;
    } catch (err) {
      const last = attempt === maxRetries;
      const msg = String(err.message || "");
      const jitter = Math.random() * 250;
      let backoff = Math.pow(2, attempt) * BACKOFF_BASE + jitter;

      if (msg.includes("HTTP_429")) {
        backoff *= 3;
        log(
          `[RATE-LIMIT] ${url} – ngủ ${(backoff / 1000).toFixed(
            1
          )}s trước khi thử lại`
        );
      }

      if (last) throw err;
      await sleep(backoff);
    }
  }
}

// =========================
// URL extraction helpers
// =========================

/**
 * Deep-scan mọi <a href> trong HTML, lọc link bài .htm trên tuoitre.vn.
 */
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
      fullUrl = new URL(href, "https://tuoitre.vn").toString();
    } catch {
      return;
    }

    if (!fullUrl.includes("tuoitre.vn")) return;
    if (!/\.htm$/i.test(fullUrl)) return;

    // Loại phân trang category
    if (/\/trang-\d+\.htm$/i.test(fullUrl)) return;

    urls.add(fullUrl);
  });

  return Array.from(urls);
}

/**
 * Từ HTML trang category, bắt các timeline base:
 *   <!-- /timeline/200003/trang-2.htm -->
 * -> https://tuoitre.vn/timeline/200003/trang-
 */
function extractTimelineBasesFromHtml(html) {
  const bases = new Set();
  const regex = /<!--\s*\/timeline\/(\d+)\/trang-\d+\.htm\s*-->/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const id = m[1];
    const base = `https://tuoitre.vn/timeline/${id}/trang-`;
    bases.add(base);
  }
  return Array.from(bases);
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
    ".detail-time",
    ".date-time",
    ".article__meta",
    ".meta",
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

function extractContent($) {
  const classPatterns = [
    /content\-detail/,
    /detail\-content/,
    /detail__content/,
    /article__body/,
    /main\-content/,
  ];

  let container = null;

  for (const pat of classPatterns) {
    const cand = $("div,section,article")
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
        /breadcrumb|comment|related|suggest|social|share|tags|footer|header|nav|ads|quangcao|qc|keyword|tin\-lien\-quan/i.test(
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

  text = text.replace(/\s+/g, " ").trim();
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
// Crawl 1 category
// =========================
async function crawlCategory(
  categoryUrl,
  patterns,
  fieldnames,
  outPath,
  visitedArticles,
  counters
) {
  log(`[CAT] Bắt đầu category: ${categoryUrl}`);

  const articleUrls = new Set();

  // 1) Crawl trang category chính
  let resp;
  try {
    resp = await fetchWithRetry(categoryUrl, { headers: HEADERS });
  } catch (e) {
    log(`[CAT] Lỗi tải category ${categoryUrl}: ${e}`);
    return;
  }

  if (!resp.ok) {
    log(
      `[CAT] HTTP ${resp.status} khi tải category ${categoryUrl}, bỏ qua category này.`
    );
    return;
  }

  const html = await resp.text();
  let $ = cheerio.load(html);

  const firstPageUrls = extractArticleUrlsFromHtml($);
  for (const u of firstPageUrls) {
    articleUrls.add(u);
  }
  log(
    `[CAT] ${categoryUrl} – Trang category chính: tìm được ${firstPageUrls.length} URL, tổng unique hiện tại: ${articleUrls.size}`
  );

  // 2) Tìm các timeline base trong HTML
  const timelineBases = extractTimelineBasesFromHtml(html);
  if (timelineBases.length === 0) {
    log(`[CAT] ${categoryUrl} – Không tìm được timeline nào (<!-- /timeline/... -->), chỉ dùng trang chính.`);
  } else {
    log(
      `[CAT] ${categoryUrl} – Tìm được ${timelineBases.length} timeline base: ${timelineBases.join(
        ", "
      )}`
    );
  }

  // 3) Crawl từng timeline: /timeline/<id>/trang-2.htm, 3, ...
  for (const base of timelineBases) {
    log(`[CAT] ${categoryUrl} – Bắt đầu crawl timeline: ${base}2.htm ...`);

    for (let page = 2; page <= MAX_PAGES_PER_TIMELINE; page++) {
      const pageUrl = `${base}${page}.htm`;
      await politeSleep();

      let r;
      try {
        r = await fetchWithRetry(pageUrl, { headers: HEADERS });
      } catch (e) {
        log(`[CAT] Lỗi tải timeline page ${pageUrl}: ${e}`);
        break;
      }

      if (!r.ok) {
        if (r.status === 404) {
          log(`[CAT] Timeline ${pageUrl} trả 404, dừng timeline này.`);
          break;
        }
        log(
          `[CAT] HTTP ${r.status} khi tải timeline page ${pageUrl}, dừng timeline này.`
        );
        break;
      }

      const htmlPage = await r.text();
      const $page = cheerio.load(htmlPage);

      const pageUrls = extractArticleUrlsFromHtml($page);

      if (pageUrls.length === 0) {
        log(
          `[CAT] ${categoryUrl} – Timeline page ${pageUrl} không có URL bài nào, dừng timeline này.`
        );
        break;
      }

      const before = articleUrls.size;
      for (const u of pageUrls) {
        articleUrls.add(u);
      }
      const added = articleUrls.size - before;

      log(
        `[CAT] ${categoryUrl} – Timeline page ${pageUrl}: tìm được ${
          pageUrls.length
        } URL, mới thêm ${added}, tổng unique: ${articleUrls.size}`
      );
    }
  }

  log(
    `[CAT] Category ${categoryUrl} – tổng bài unique thu được: ${articleUrls.size}`
  );

  // 4) Crawl nội dung từng bài
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
        date: date,
        title: title,
        content: content,
        ...freqs,
      };

      const row = fieldnames.map((fn) => rowObj[fn] ?? "");
      writeCsvRow(outPath, row);

      counters.totalArticles += 1;
      if (counters.totalArticles % PROGRESS_EVERY === 0) {
        log(
          `[INFO] Đã ghi ${counters.totalArticles} bài (các category range đang crawl)`
        );
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
      "Usage: node main_tuoitre.js START_IDX END_IDX  (1-based index của category trong tuoitre_categories.txt)"
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
  const categoryUrlsAll = loadCategoryUrlsFromFile(CATEGORY_FILE);

  const nCategories = categoryUrlsAll.length;
  if (startIdx > nCategories) {
    log(
      `[ERROR] START_IDX (${startIdx}) > tổng số category (${nCategories})`
    );
    process.exit(1);
  }

  endIdx = Math.min(endIdx, nCategories);
  const categoryUrls = categoryUrlsAll.slice(startIdx - 1, endIdx);

  log(
    `[INFO] Sẽ crawl category index từ ${startIdx} đến ${endIdx} / ${nCategories}`
  );

  const visitedArticles = new Set();
  const counters = { totalArticles: 0 };

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
      categoryUrls,
      async (catUrl) => {
        await crawlCategory(
          catUrl,
          patterns,
          fieldnames,
          outPath,
          visitedArticles,
          counters
        );
      },
      CATEGORY_CONCURRENCY
    );
  } finally {
    // nothing
  }

  log(
    `[DONE] Tổng số bài ghi thêm trong lần chạy này: ${counters.totalArticles}`
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
