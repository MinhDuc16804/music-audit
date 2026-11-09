/** Đọc file CSV cho các script cập nhật danh sách. Không phụ thuộc trình duyệt để script Node dùng chung được. */

function countOf(text: string, character: string): number {
  return text.split(character).length - 1;
}

/** Đọc CSV từ Excel hoặc Google Sheets: có thể có BOM, dùng dấu , ; hoặc tab, có ô trong ngoặc kép. */
export function parseCsv(text: string): string[][] {
  const content = text.replace(/^﻿/, '');
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, candidate) =>
    countOf(firstLine, candidate) > countOf(firstLine, best) ? candidate : best,
  );

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const endCell = () => {
    row.push(cell.trim());
    cell = '';
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inQuotes) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === delimiter) {
      endCell();
    } else if (character === '\n') {
      endRow();
    } else if (character !== '\r') {
      cell += character;
    }
  }
  if (cell || row.length > 0) {
    endRow();
  }
  return rows;
}
