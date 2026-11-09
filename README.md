# News Sitemap Crawler

This project crawls Vietnamese news websites through their sitemap files, extracts article URLs, and downloads article content to count keyword occurrences. The scripts are designed for research/data collection workflows and generate CSV outputs for each news source.

## Project purpose

The workflow is:

1. Fetch sitemap XML files from a news site.
2. Extract article URLs from those sitemaps.
3. Download article pages.
4. Parse title, date, content, and keyword matches.
5. Save the result as CSV for later analysis.

The workspace includes crawlers for:

- Dantri
- VietnamNet
- 24h
- BaoMoi
- ThanhNien
- TuoiTre
- VNExpress

## Requirements

- Node.js 18 or newer
- npm

Install dependencies:

```bash
npm install
```

## Main files

### Sitemap generation

- `build_sitemap_dantri.js` — collects Dantri sitemap XML URLs
- `build_sitemap_vietnamnet.js` — collects VietnamNet sitemap XML URLs
- `generate_sitemap_24h.js` — generates 24h sitemap list
- `generate_sitemap_baomoi.js` — generates BaoMoi sitemap list

These scripts write files such as:

- `sitemap_dantri.txt`
- `sitemap_vietnamnet.txt`
- `sitemap_24h.txt`
- `sitemap_baomoi.txt`

### URL extraction

- `build_dantri_urls.js` — converts sitemap XML entries into article URLs
- `main_dantri.js` — crawls Dantri article URLs and counts keywords
- `main_vnnet.js` — crawls VietnamNet article URLs
- `main_24h.js` — crawls 24h article URLs
- `main_baomoi.js` — crawls BaoMoi article URLs
- `main_thanhnien.js` — crawls ThanhNien article URLs
- `main_tuoitre.js` — crawls TuoiTre article URLs
- `main_vnexpress.js` — crawls VNExpress article URLs

### Data inputs

- `keywords.txt` — list of keywords to search, one keyword per line
- `*_article_urls.txt` — article URLs generated from sitemaps

### Output files

- `*_articles.csv` — article records with extracted fields
- `failed_503.txt` — unsuccessful requests or server errors
- `debug_stop_reason*.csv` — debugging metadata for failed runs

## Typical workflow

### 1) Prepare keyword list

Edit `keywords.txt` and add one keyword per line.

Example:

```text
biến đổi khí hậu
môi trường
nước biển dâng
khí thải
```

### 2) Generate sitemap URLs

```bash
node build_sitemap_dantri.js
```

or for another source:

```bash
node build_sitemap_vietnamnet.js
node generate_sitemap_24h.js
node generate_sitemap_baomoi.js
```

### 3) Build article URL list

```bash
node build_dantri_urls.js
```

This reads the sitemap file and writes `dantri_article_urls.txt`.

### 4) Crawl article content

```bash
node main_dantri.js START_LINE END_LINE
```

Example:

```bash
node main_dantri.js 1 100
```

This processes article URLs from `dantri_article_urls.txt` between the specified line numbers and appends results to `dantri_articles.csv`.

## Notes

- The scripts use polite delays and retry logic to reduce the chance of being blocked.
- The project is designed for research and data collection use, not for production traffic.
- Some scripts are source-specific, so the exact input/output file names vary by site.
- The crawler may need to be re-run for large datasets depending on server limits and HTTP errors.

## Example file structure

```text
.
├── package.json
├── keywords.txt
├── build_sitemap_dantri.js
├── build_dantri_urls.js
├── main_dantri.js
├── sitemap_dantri.txt
├── dantri_article_urls.txt
├── dantri_articles.csv
├── ...
└── README.md
```

## Useful tips

- Check `failed_503.txt` if a run stops on HTTP 503 or similar errors.
- Use smaller ranges when testing a new source or keyword list.
- Keep each crawler focused on one source at a time to make debugging easier.

## License

This project is intended for academic and internal research use. Please ensure it complies with the terms of service and robots policies of the target news websites.
