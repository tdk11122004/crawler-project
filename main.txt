#!/usr/bin/env node

/**
 * Crawler ThanhNien.vn dùng sitemap + đếm term frequency theo keyword list.
 *
 * Input:
 *   - keywords.txt          : danh sách từ khóa (1 từ / cụm từ mỗi dòng)
 *   - sitemap_thanhnien.txt : mỗi dòng 1 URL sitemap .xml
 *
 * Chạy:
 *   node main.js START_IDX END_IDX
 *   (chỉ số 1-based, theo thứ tự URL trong sitemap_thanhnien.txt)
 *
 * Output:
 *   - thanhnien_articles.csv : file CSV (một bài báo = một dòng),
 *                              append thêm mỗi lần chạy.
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

// =========================
// Config
// =========================
const KEYWORDS_FILE = "keywords.txt";
const SITEMAP_FILE = "sitemap_thanhnien.txt";
const OUTPUT_CSV = "thanhnien_articles.csv";

const NEWSPAPER_NAME = "ThanhNien";
const REQUEST_TIMEOUT = 18000; // ms (xấp xỉ 12s như Python)
const MIN_DELAY = 200;          // ms
const MAX_DELAY = 600;          // ms
const PROGRESS_EVERY = 50;
const SITEMAP_CONCURRENCY = 5;   // số sitemap fetch song song
const ARTICLE_CONCURRENCY = 10;   // số bài fetch song song (tăng nếu muốn)
const WRITE_CONCURRENCY = 1;     // để ghi file sequential (không bắt buộc)

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; ThanhNienCrawler/1.0; +https://thanhnien.vn/)",
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
    log("[ERROR] Không có sitemap URL nào trong sitemap_thanhnien.txt");
    process.exit(1);
  }

  log(`[INFO] Loaded ${urls.length} sitemap URLs từ file sitemap_thanhnien.txt`);
  return urls;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function politeSleep() {
  const delay =
    MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY); // ms
  await sleep(delay);
}

// thêm helper concurrency
async function runTasksWithConcurrency(items, worker, concurrency) {
  const running = new Set();
  for (const item of items) {
    // chờ tới khi có slot rảnh
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
// HTTP fetch với timeout
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

async function fetchWithRetry(url, options = {}, timeout = REQUEST_TIMEOUT, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);

      // retry on server errors
      if (res.status >= 500 && res.status < 600) {
        throw new Error(`HTTP ${res.status}`);
      }

      // If 429 rate-limit, throw to retry with longer backoff
      if (res.status === 429) {
        throw new Error("HTTP 429");
      }

      return res;
    } catch (err) {
      const last = attempt === maxRetries;
      // small jitter
      const jitter = Math.random() * 250;
      const backoff = Math.pow(2, attempt) * BACKOFF_BASE + jitter;
      if (last) throw err;
      // on 429, wait longer
      await sleep(backoff * (err.message && err.message.includes("429") ? 3 : 1));
    }
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
    log(
      `[ERROR] HTTP ${resp.status} khi tải sitemap ${sitemapUrl}`
    );
    return [];
  }

  const xmlText = await resp.text();
  const $ = cheerio.load(xmlText, { xmlMode: true });

  const articleUrls = [];
  $("loc").each((_, el) => {
    const url = $(el).text().trim();
    if (!url) return;
    if (url.endsWith(".htm") && url.includes("thanhnien.vn")) {
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
  // 1. Các selector thường gặp trên Thanh Niên
  const selectors = [
    "[data-role='publishdate']",  // thêm dòng này
    "span.detail-time",
    "div.detail-time",
    "div.meta",
    "div.date",
    "span.date",
    "time",
  ];

  // Ưu tiên quét theo selector
  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el || el.length === 0) continue;

    const text = el.text().replace(/\s+/g, " ").trim();
    // ví dụ: "01/10/2021 10:10 GMT+7"
    const m = text.match(DATE_REGEX);
    if (m) {
      return m[0]; // trả về "01/10/2021"
    }

    // nếu là thẻ <time datetime="2021-10-01T10:10:00+07:00">
    const dt = el.attr("datetime");
    if (dt) {
      const m2 = dt.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (m2) {
        const [, y, mo, d] = m2;
        return `${d}/${mo}/${y}`;
      }
    }
  }

  // 2. Thử thêm trong meta nếu có (phòng xa)
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

    const m = content.match(DATE_REGEX);
    if (m) return m[0];

    const m2 = content.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m2) {
      const [, y, mo, d] = m2;
      return `${d}/${mo}/${y}`;
    }
  }

  // 3. Fallback cuối: quét toàn body (như code cũ)
  const allText = $("body").text().replace(/\s+/g, " ").trim();
  const m3 = allText.match(DATE_REGEX);
  return m3 ? m3[0] : "";
}

function extractContent($) {
  const classPatterns = [
    /detail\-content/,
    /detail__content/,
    /cms\-body/,
    /article\-body/,
  ];

  let container = null;

  // 1. Tìm container chính
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

  // ❗ RẤT QUAN TRỌNG: xoá script/style/noscript/iframe khỏi DOM trước khi lấy text
  container.find("script, style, noscript, iframe").remove();
  $("body").find("script, style, noscript, iframe").remove();

  // 2. Gom text từ các tag nội dung chính
  const parts = [];
  container
    .find("p, h1, h2, h3, h4, h5, h6, li, div")
    .each((_, el) => {
      const cls = $(el).attr("class") || "";
      // bỏ qua khu vực ads, liên quan, comment, share...
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

  // 3. Fallback: nếu vẫn rỗng, lấy text container (sau khi đã remove script/style)
  if (!text && container) {
    text = container.text().replace(/\s+/g, " ").trim();
  }

  // 4. Fallback cuối: text body (cũng đã remove script/style)
  if (!text) {
    text = $("body").text().replace(/\s+/g, " ").trim();
  }

  // 5. (Optional) xoá bớt chuỗi rác nếu còn sót
  text = text.replace(/Chèn ads giữa bài[^]*?template\.content\.firstChild; \}/gi, "");
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
  // -------- BẮT ĐẦU ĐO THỜI GIAN CHẠY --------
  const startTime = Date.now();   // thời điểm bắt đầu (ms)
  
  // -------- Parse tham số dòng lệnh --------
  if (process.argv.length !== 4) {
    log("Usage: node main.js START_IDX END_IDX  (1-based index của sitemap)");
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

  // -------- Load dữ liệu cấu hình --------
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

  // slice 1-based -> 0-based
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

  // Ghi header nếu file mới / rỗng
  if (!fileExists) {
    writeCsvRow(outPath, fieldnames);
  }

  try {
    // Replace sequential sitemap loop with concurrency
    await runTasksWithConcurrency(sitemapUrls, async (smUrl) => {
      await politeSleep();
      const articleUrls = await extractArticleUrlsFromSitemap(smUrl);
      // process articles with limited concurrency
      await runTasksWithConcurrency(articleUrls, async (artUrl) => {
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
        // file write is sync in original code (fs.appendFileSync) — keep same behavior
        writeCsvRow(outPath, row);

        totalArticles += 1;
        if (totalArticles % PROGRESS_EVERY === 0) {
          log(`[INFO] Đã ghi ${totalArticles} bài (range sitemap ${startIdx}-${endIdx})`);
        }
      }, ARTICLE_CONCURRENCY);
    }, SITEMAP_CONCURRENCY);
  } finally {
    // không cần close gì thêm vì fs.appendFileSync tự handle
  }

  log(
    `[DONE] Tổng số bài ghi thêm trong lần chạy này: ${totalArticles}`
  );
  log(`[DONE] File output: ${OUTPUT_CSV}`);

  // -------- KẾT THÚC ĐO THỜI GIAN CHẠY --------
  const endTime = Date.now();
  const elapsedMs = endTime - startTime;
  const elapsedMinutes = (elapsedMs / 60000).toFixed(2);
  log(`[TIME] Thời gian chạy: ${elapsedMinutes} phút`);

}

main().catch((err) => {
  console.error("[FATAL] Lỗi không mong muốn:", err);
  process.exit(1);
});
