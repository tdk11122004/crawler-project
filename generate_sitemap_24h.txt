#!/usr/bin/env node
/**
 * 24h sitemap collector (2010-2025)
 * - For each month: part=1.. until STOP (404 / no-html / repeated transient)
 * - Only save parts that contain >=1 article URL (.htm/.html)
 * - Handles sitemapindex -> checks child sitemaps (1-level)
 * - Handles .xml.gz (manual gunzip)
 * - Adds delay + retry to avoid anti-bot false no-html
 *
 * Outputs:
 *  - sitemap_24h.txt
 *  - debug_stop_reason.csv
 *
 * Usage:
 *   node generate_sitemap_24h.js
 *   node generate_sitemap_24h.js 2010 2025
 *
 * Optional env:
 *   DELAY_MS=300            (delay between requests)
 *   RETRIES=4               (retries per URL on transient/429/5xx)
 *   BACKOFF_MS=600          (base backoff for retries)
 */

const fs = require("fs");
const zlib = require("zlib");

const BASE = "https://www.24h.com.vn";
const OUT_FILE = "sitemap_24h.txt";
const DEBUG_FILE = "debug_stop_reason.csv";

const startYear = parseInt(process.argv[2] || "2010", 10);
const endYear = parseInt(process.argv[3] || "2025", 10);

const DELAY_MS = parseInt(process.env.DELAY_MS || "250", 10);
const RETRIES = parseInt(process.env.RETRIES || "4", 10);
const BACKOFF_MS = parseInt(process.env.BACKOFF_MS || "600", 10);

if (Number.isNaN(startYear) || Number.isNaN(endYear) || startYear > endYear) {
  console.error("Invalid years. Example: node generate_sitemap_24h.js 2010 2025");
  process.exit(1);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function buildSitemapUrl(year, month, part) {
  return `${BASE}/sitemap-article-${year}-${pad2(month)}-${part}.xml`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractLocUrls(xmlText) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xmlText)) !== null) out.push(m[1]);
  return out;
}

function countHtmlLinks(urls) {
  let c = 0;
  for (const u of urls) {
    const s = String(u).toLowerCase();
    if (s.includes(".html") || s.includes(".htm")) c++;
  }
  return c;
}

function isSitemapIndex(xmlText) {
  return /<\s*sitemapindex\b/i.test(xmlText);
}

function isUrlSet(xmlText) {
  return /<\s*urlset\b/i.test(xmlText);
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function logDebug(year, month, part, reason, status, htmlCount, url) {
  fs.appendFileSync(
    DEBUG_FILE,
    [
      year,
      pad2(month),
      part,
      reason,
      status,
      htmlCount,
      csvEscape(url),
    ].join(",") + "\n",
    "utf8"
  );
}

function shouldRetryHttpStatus(status) {
  // 403/429/5xx thường do chặn/tải cao
  return status === 403 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

async function fetchXmlText(url) {
  // delay trước mỗi request để giảm anti-bot
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "application/xml,text/xml,*/*",
      },
    });

    if (res.status === 404) return { status: 404, text: "" };

    // đọc body dạng bytes để xử lý .gz
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    if (!res.ok) {
      return { status: res.status, text: "" };
    }

    // Nếu URL kết thúc .gz hoặc content-type gợi ý binary -> gunzip
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const looksGz =
      url.toLowerCase().endsWith(".gz") ||
      contentType.includes("application/x-gzip") ||
      contentType.includes("application/gzip") ||
      contentType.includes("octet-stream");

    let text;
    if (looksGz) {
      try {
        text = zlib.gunzipSync(buf).toString("utf8");
      } catch {
        // nếu không gunzip được thì fallback decode thẳng
        text = buf.toString("utf8");
      }
    } else {
      text = buf.toString("utf8");
    }

    return { status: res.status, text: text || "" };
  } catch (e) {
    return { status: 0, text: "" }; // transient
  } finally {
    clearTimeout(timeout);
  }
}

// Cache để giảm request lặp
const xmlCache = new Map(); // url -> {status, text}

async function fetchXmlCachedWithRetry(url) {
  if (xmlCache.has(url)) return xmlCache.get(url);

  let last = { status: 0, text: "" };

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const r = await fetchXmlText(url);
    last = r;

    if (r.status === 404) break; // không retry 404
    if (r.status !== 0 && !shouldRetryHttpStatus(r.status)) break; // ok hoặc status không nên retry
    // retry với backoff
    const wait = BACKOFF_MS * Math.pow(2, attempt);
    await sleep(wait);
  }

  xmlCache.set(url, last);
  return last;
}

/**
 * Determine html count for a sitemap URL:
 * - If urlset: count html in <loc>
 * - If sitemapindex: fetch child sitemaps (1 level), count html in child urlset(s)
 */
async function getHtmlCountForSitemap(url) {
  const { status, text } = await fetchXmlCachedWithRetry(url);

  if (status === 404) return { status: 404, htmlCount: 0 };
  if (status === 0) return { status: 0, htmlCount: 0 };
  if (!text) return { status, htmlCount: 0 };

  const locs = extractLocUrls(text);

  if (isUrlSet(text) && !isSitemapIndex(text)) {
    return { status, htmlCount: countHtmlLinks(locs) };
  }

  if (isSitemapIndex(text)) {
    let total = 0;

    // check children 1-level deep
    for (const childUrl of locs) {
      // log child check (nhẹ) nếu bạn muốn nhìn sâu thì bỏ comment dòng dưới
      // console.log(`  [CHILD] ${childUrl}`);

      const child = await fetchXmlCachedWithRetry(childUrl);
      if (child.status === 404 || child.status === 0 || !child.text) continue;

      const childLocs = extractLocUrls(child.text);
      if (isUrlSet(child.text) && !isSitemapIndex(child.text)) {
        total += countHtmlLinks(childLocs);
        if (total > 0) break; // chỉ cần xác nhận có html
      }
    }

    return { status, htmlCount: total };
  }

  return { status, htmlCount: 0 };
}

(async () => {
  fs.writeFileSync(OUT_FILE, "", "utf8");
  fs.writeFileSync(
    DEBUG_FILE,
    "year,month,stop_part,reason,http_status,html_count,checked_url\n",
    "utf8"
  );

  let savedCount = 0;

  for (let y = startYear; y <= endYear; y++) {
    for (let m = 1; m <= 12; m++) {
      let part = 1;
      let transientErrorsInARow = 0;

      while (true) {
        const sitemapUrl = buildSitemapUrl(y, m, part);

        console.log(`\n[CHECK] ${sitemapUrl}`);

        const { status, htmlCount } = await getHtmlCountForSitemap(sitemapUrl);

        if (status === 404) {
          console.log(`[STOP]  ${y}-${pad2(m)} at part ${part}: 404`);
          logDebug(y, m, part, "404", status, htmlCount, sitemapUrl);
          break;
        }

        if (status === 0) {
          transientErrorsInARow++;
          if (transientErrorsInARow >= 3) {
            console.log(`[STOP]  ${y}-${pad2(m)} at part ${part}: transient-error`);
            logDebug(y, m, part, "transient-error", status, htmlCount, sitemapUrl);
            break;
          }
          console.log(`[WARN]  ${y}-${pad2(m)} part ${part}: transient error -> try next`);
          part++;
          continue;
        }

        transientErrorsInARow = 0;

        if (htmlCount <= 0) {
          console.log(`[STOP]  ${y}-${pad2(m)} at part ${part}: no-html`);
          logDebug(y, m, part, "no-html", status, htmlCount, sitemapUrl);
          break;
        }

        console.log(`[OK]    ${y}-${pad2(m)} part ${part}: html=${htmlCount} -> saved`);
        fs.appendFileSync(OUT_FILE, sitemapUrl + "\n", "utf8");
        savedCount++;

        part++;
      }
    }
  }

  console.log(`\n[DONE] Saved ${savedCount} sitemap URLs to ${OUT_FILE}`);
  console.log(`[DONE] Debug written to ${DEBUG_FILE}`);
})();
