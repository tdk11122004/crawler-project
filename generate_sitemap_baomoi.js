#!/usr/bin/env node
/**
 * BaoMoi sitemap collector (daily yyyymmdd)
 * - For each date in range: check sitemap article-YYYYMMDD.xml (and optional .xml.gz fallback)
 * - Only save sitemaps that contain >=1 article URL (heuristic: NOT .xml/.xml.gz)
 * - Handles sitemapindex -> checks child sitemaps (1-level)
 * - Handles .xml.gz (manual gunzip)
 * - Adds delay + retry to reduce transient / anti-bot false negatives
 *
 * Outputs:
 *  - sitemap_baomoi.txt
 *  - debug_stop_reason_baomoi.csv
 *
 * Usage:
 *   node generate_sitemap_baomoi.js 20230801 20230831
 *   node generate_sitemap_baomoi.js 20180101 20251231
 *
 * Optional env:
 *   DELAY_MS=250
 *   RETRIES=4
 *   BACKOFF_MS=600
 *   TRY_GZ=1              (also try .xml.gz if .xml fails/empty)
 *   STOP_AFTER_404=60     (stop early if too many consecutive 404 in a row; 0 = never early stop)
 */

const fs = require("fs");
const zlib = require("zlib");

const BASE = "https://baomoi.com";
const OUT_FILE = "sitemap_baomoi.txt";
const DEBUG_FILE = "debug_stop_reason_baomoi.csv";

const startYmd = String(process.argv[2] || "").trim();
const endYmd = String(process.argv[3] || "").trim();

const DELAY_MS = parseInt(process.env.DELAY_MS || "250", 10);
const RETRIES = parseInt(process.env.RETRIES || "4", 10);
const BACKOFF_MS = parseInt(process.env.BACKOFF_MS || "600", 10);
const TRY_GZ = String(process.env.TRY_GZ || "1") === "1";
const STOP_AFTER_404 = parseInt(process.env.STOP_AFTER_404 || "60", 10);

function usageExit() {
  console.error("Usage: node generate_sitemap_baomoi.js START_YYYYMMDD END_YYYYMMDD");
  console.error("Example: node generate_sitemap_baomoi.js 20180101 20251231");
  process.exit(1);
}

function isValidYmd(ymd) {
  return /^\d{8}$/.test(ymd);
}

if (!isValidYmd(startYmd) || !isValidYmd(endYmd) || startYmd > endYmd) {
  usageExit();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseYmdToDate(ymd) {
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10) - 1;
  const d = parseInt(ymd.slice(6, 8), 10);
  // Use UTC to avoid timezone DST issues
  return new Date(Date.UTC(y, m, d));
}

function formatDateToYmd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function addDaysUTC(date, days) {
  const t = new Date(date.getTime());
  t.setUTCDate(t.getUTCDate() + days);
  return t;
}

function buildSitemapUrl(ymd, gz = false) {
  const base = `${BASE}/sitemaps/article-${ymd}.xml`;
  return gz ? `${base}.gz` : base;
}

function extractLocUrls(xmlText) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xmlText)) !== null) out.push(m[1]);
  return out;
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

function logDebug(ymd, reason, status, itemCount, checkedUrl) {
  fs.appendFileSync(
    DEBUG_FILE,
    [ymd, reason, status, itemCount, csvEscape(checkedUrl)].join(",") + "\n",
    "utf8"
  );
}

function shouldRetryHttpStatus(status) {
  return (
    status === 403 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

async function fetchXmlText(url) {
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        Accept: "application/xml,text/xml,*/*",
      },
    });

    if (res.status === 404) return { status: 404, text: "" };

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);

    if (!res.ok) return { status: res.status, text: "" };

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
        text = buf.toString("utf8");
      }
    } else {
      text = buf.toString("utf8");
    }

    return { status: res.status, text: text || "" };
  } catch {
    return { status: 0, text: "" }; // transient
  } finally {
    clearTimeout(timeout);
  }
}

const xmlCache = new Map(); // url -> {status, text}

async function fetchXmlCachedWithRetry(url) {
  if (xmlCache.has(url)) return xmlCache.get(url);

  let last = { status: 0, text: "" };
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const r = await fetchXmlText(url);
    last = r;

    if (r.status === 404) break;
    if (r.status !== 0 && !shouldRetryHttpStatus(r.status)) break;

    const wait = BACKOFF_MS * Math.pow(2, attempt);
    await sleep(wait);
  }

  xmlCache.set(url, last);
  return last;
}

/**
 * Heuristic "article url count":
 * - In urlset: count locs that look like article pages (not .xml/.gz)
 * - In sitemapindex: look 1-level down; stop early once found >=1
 */
function countArticleLikeLinks(urls) {
  let c = 0;
  for (const u of urls) {
    const s = String(u).toLowerCase();
    // avoid counting child sitemap links
    if (s.endsWith(".xml") || s.endsWith(".xml.gz") || s.includes("/sitemaps/")) continue;
    c++;
  }
  return c;
}

async function getArticleCountForSitemap(url) {
  const { status, text } = await fetchXmlCachedWithRetry(url);

  if (status === 404) return { status: 404, count: 0 };
  if (status === 0) return { status: 0, count: 0 };
  if (!text) return { status, count: 0 };

  const locs = extractLocUrls(text);

  if (isUrlSet(text) && !isSitemapIndex(text)) {
    return { status, count: countArticleLikeLinks(locs) };
  }

  if (isSitemapIndex(text)) {
    let total = 0;
    for (const childUrl of locs) {
      const child = await fetchXmlCachedWithRetry(childUrl);
      if (child.status === 404 || child.status === 0 || !child.text) continue;

      const childLocs = extractLocUrls(child.text);
      if (isUrlSet(child.text) && !isSitemapIndex(child.text)) {
        total += countArticleLikeLinks(childLocs);
        if (total > 0) break; // only need confirm existence
      }
    }
    return { status, count: total };
  }

  return { status, count: 0 };
}

(async () => {
  fs.writeFileSync(OUT_FILE, "", "utf8");
  fs.writeFileSync(
    DEBUG_FILE,
    "ymd,reason,http_status,item_count,checked_url\n",
    "utf8"
  );

  let savedCount = 0;
  let consecutive404 = 0;

  let d = parseYmdToDate(startYmd);
  const end = parseYmdToDate(endYmd);

  while (d.getTime() <= end.getTime()) {
    const ymd = formatDateToYmd(d);

    const urlXml = buildSitemapUrl(ymd, false);
    const urlGz = buildSitemapUrl(ymd, true);

    console.log(`\n[CHECK] ${ymd} -> ${urlXml}`);

    let checkedUrl = urlXml;
    let r = await getArticleCountForSitemap(urlXml);

    // Optional: fallback to .gz if .xml missing/empty
    if (
      TRY_GZ &&
      (r.status === 404 || (r.status !== 0 && r.count <= 0)) // missing OR empty
    ) {
      console.log(`[FALLBACK] try gz -> ${urlGz}`);
      checkedUrl = urlGz;
      r = await getArticleCountForSitemap(urlGz);
    }

    if (r.status === 404) {
      consecutive404++;
      logDebug(ymd, "404", r.status, r.count, checkedUrl);
      console.log(`[MISS] ${ymd}: 404 (${consecutive404} in a row)`);

      if (STOP_AFTER_404 > 0 && consecutive404 >= STOP_AFTER_404) {
        console.log(
          `[STOP] Reached ${STOP_AFTER_404} consecutive 404s. Stop early at ${ymd}.`
        );
        break;
      }

      d = addDaysUTC(d, 1);
      continue;
    }

    // transient: log and keep going
    if (r.status === 0) {
      logDebug(ymd, "transient-error", r.status, r.count, checkedUrl);
      console.log(`[WARN] ${ymd}: transient error -> continue`);
      consecutive404 = 0;
      d = addDaysUTC(d, 1);
      continue;
    }

    consecutive404 = 0;

    if (r.count <= 0) {
      logDebug(ymd, "no-article-links", r.status, r.count, checkedUrl);
      console.log(`[SKIP] ${ymd}: no article links`);
      d = addDaysUTC(d, 1);
      continue;
    }

    fs.appendFileSync(OUT_FILE, checkedUrl + "\n", "utf8");
    savedCount++;
    console.log(`[OK]   ${ymd}: items=${r.count} -> saved (${checkedUrl})`);

    d = addDaysUTC(d, 1);
  }

  console.log(`\n[DONE] Saved ${savedCount} sitemap URLs to ${OUT_FILE}`);
  console.log(`[DONE] Debug written to ${DEBUG_FILE}`);
})();
