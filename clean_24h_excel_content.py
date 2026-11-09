import os
import re
from openpyxl import load_workbook

BASE_DIR = r"D:\_UNIVERSITY\__7PROJECT\Climate Change\Newspaper Dataset\24h"

# File ranges
FILES_SAVE_BANNER = range(1, 6)      # 1..5
FILES_SPEED_TEXT  = range(53, 59)    # 53..58

# Trash strings to remove ONLY if they appear at the start of content
TRASH_SAVE_BANNER = "Lưu bài viết thành công Bạn có thể xem lại bài viết đã lưu ở trang Tin bài đã lưu"
TRASH_SPEED_TEXT  = "0.5 0.75 Chuẩn 1.25 1.5"

def normalize_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()

def remove_trash_prefix(content: str, trash: str) -> str:
    """
    Remove 'trash' ONLY if normalized content starts with normalized trash.
    Keep the remaining content. Do not touch other columns.
    """
    if content is None or not isinstance(content, str):
        return content

    raw = content
    norm = normalize_spaces(raw)
    trash_norm = normalize_spaces(trash)

    if not norm.lower().startswith(trash_norm.lower()):
        return raw

    # cut off exact prefix length in the normalized string
    rest = norm[len(trash_norm):].lstrip()
    return rest

def get_content_col_index(ws) -> int | None:
    """
    Find the column index (1-based) whose header equals 'content' (case-insensitive).
    Header assumed in row 1.
    """
    for col in range(1, ws.max_column + 1):
        v = ws.cell(row=1, column=col).value
        if isinstance(v, str) and v.strip().lower() == "content":
            return col
    return None

def process_one_file(filepath: str, trash: str) -> int:
    """
    Modify only the 'content' column cells. Save in-place.
    Return number of modified rows (cells changed).
    """
    wb = load_workbook(filepath)
    modified = 0

    for ws in wb.worksheets:
        ccol = get_content_col_index(ws)
        if ccol is None:
            continue

        for r in range(2, ws.max_row + 1):
            cell = ws.cell(row=r, column=ccol)
            val = cell.value

            if isinstance(val, str) and val.strip():
                new_val = remove_trash_prefix(val, trash)
                if new_val != val:
                    cell.value = new_val
                    modified += 1

    if modified > 0:
        wb.save(filepath)
    wb.close()
    return modified

def file_path(i: int) -> str:
    # Nếu file bạn là .xlsm hay tên khác, đổi extension tại đây
    return os.path.join(BASE_DIR, f"24h_articles_sitemap_file {i}.xlsx")

def main():
    print(f"[INFO] Base dir: {BASE_DIR}")

    grand_total = 0

    # Group 1: files 1-5
    for i in FILES_SAVE_BANNER:
        fp = file_path(i)
        if not os.path.exists(fp):
            print(f"[SKIP] Not found: {os.path.basename(fp)}")
            continue
        n = process_one_file(fp, TRASH_SAVE_BANNER)
        grand_total += n
        print(f"[DONE] {os.path.basename(fp)} | fixed rows: {n}")

    # Group 2: files 53-58
    for i in FILES_SPEED_TEXT:
        fp = file_path(i)
        if not os.path.exists(fp):
            print(f"[SKIP] Not found: {os.path.basename(fp)}")
            continue
        n = process_one_file(fp, TRASH_SPEED_TEXT)
        grand_total += n
        print(f"[DONE] {os.path.basename(fp)} | fixed rows: {n}")

    print(f"\n[ALL DONE] Total fixed rows: {grand_total}")

if __name__ == "__main__":
    main()
