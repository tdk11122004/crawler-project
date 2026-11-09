const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");

// ==== THƯ MỤC CHỨA FILE THANHNIEN ====
const INPUT_DIR = path.resolve(
  "D:\\_UNIVERSITY\\__7PROJECT\\Climate Change\\Newspaper Dataset\\dantri"
);

const DATE_COLUMN_NAME = "date";
const OUTPUT_CSV = path.resolve("article_counts_by_month.csv");

// ================== TẠO DANH SÁCH THÁNG TỪ 01/2006 ĐẾN 11/2025 ==================
function generateMonthDefs() {
  const startYear = 2006;
  const startMonth = 1; // Jan
  const endYear = 2025;
  const endMonth = 12; // Nov

  const months = [];
  let y = startYear;
  let m = startMonth;

  while (y < endYear || (y === endYear && m <= endMonth)) {
    const mm = String(m).padStart(2, "0");
    const label = `${mm}/${y}`;      // cột trong CSV: 01/2006
    const key = `${y}-${mm}`;        // key nội bộ: 2006-01
    months.push({ label, key });

    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

const MONTH_DEFS = generateMonthDefs(); // mảng {label, key}

// ================== HÀM LẤY THÁNG-NĂM TỪ Ô DATE ==================
function extractMonthKey(value) {
  if (!value) return null;

  // Trường hợp là Date object
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = value.getMonth() + 1;
    if (!isFinite(y) || !isFinite(m)) return null;
    const mm = String(m).padStart(2, "0");
    return `${y}-${mm}`;
  }

  const str = String(value).trim();

  // Format phổ biến: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy
  let m = str.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) {
    const year = parseInt(m[3], 10);
    const month = parseInt(m[2], 10);
    if (!isFinite(year) || !isFinite(month)) return null;
    const mm = String(month).padStart(2, "0");
    return `${year}-${mm}`;
  }

  // ISO hoặc kiểu yyyy-mm-dd
  m = str.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (!isFinite(year) || !isFinite(month)) return null;
    const mm = String(month).padStart(2, "0");
    return `${year}-${mm}`;
  }

  return null;
}

// ================== ĐỌC FILE, ĐẾM THEO THÁNG ==================
function main() {
  // ---- Lấy tham số A, B ----
  const A = parseInt(process.argv[2], 10);
  const B = parseInt(process.argv[3], 10);

  if (!A || !B || A > B) {
    console.error("Usage: node count_by_month.js A B  (ví dụ: node count_by_month.js 1 20)");
    process.exit(1);
  }

  console.log(`[INFO] Batch: files from ${A} to ${B}`);

  // ---- Lấy & sort danh sách file ----
  const allFiles = fs
    .readdirSync(INPUT_DIR)
    .filter((f) => f.endsWith(".xlsx"))
    .sort((a, b) => {
      const n1 = parseInt(a.match(/file (\d+)\.xlsx/)[1], 10);
      const n2 = parseInt(b.match(/file (\d+)\.xlsx/)[1], 10);
      return n1 - n2;
    });

  const targetFiles = allFiles.filter((f) => {
    const num = parseInt(f.match(/file (\d+)\.xlsx/)[1], 10);
    return num >= A && num <= B;
  });

  console.log(`[INFO] Matching files: ${targetFiles.length}`);

  // ---- Khởi tạo đếm theo tháng ----
  const monthCounts = {};
  for (const def of MONTH_DEFS) {
    monthCounts[def.key] = 0;
  }

  // ---- Đọc từng file và cộng dồn ----
  for (const file of targetFiles) {
    const filePath = path.join(INPUT_DIR, file);
    console.log(`[READ] ${file}`);

    try {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

      for (const row of rows) {
        const dateValue = row[DATE_COLUMN_NAME];
        const monthKey = extractMonthKey(dateValue);
        if (!monthKey) continue;
        if (!monthCounts.hasOwnProperty(monthKey)) {
          // Ngoài khoảng 01/2010–11/2025 -> bỏ qua
          continue;
        }
        monthCounts[monthKey] += 1;
      }
    } catch (err) {
      console.error(`[ERROR] Cannot parse ${file}:`, err.message);
    }
  }

  // ================== GHI / APPEND CSV ==================
  let isNewFile = false;
  if (!fs.existsSync(OUTPUT_CSV)) {
    isNewFile = true;
  }

  const headerCols = ["Batch", ...MONTH_DEFS.map((d) => d.label)];
  const batchLabel = `${A}-${B}`;

  // Tạo dòng dữ liệu cho batch này
  const rowValues = [batchLabel];
  for (const def of MONTH_DEFS) {
    rowValues.push(monthCounts[def.key] || 0);
  }

  let line = rowValues.join(",");

  if (isNewFile) {
    const headerLine = headerCols.join(",");
    fs.writeFileSync(OUTPUT_CSV, headerLine + "\n" + line + "\n", "utf8");
    console.log(`[DONE] Created new CSV: ${OUTPUT_CSV}`);
  } else {
    fs.appendFileSync(OUTPUT_CSV, line + "\n", "utf8");
    console.log(`[DONE] Appended to CSV: ${OUTPUT_CSV}`);
  }
}

main();
