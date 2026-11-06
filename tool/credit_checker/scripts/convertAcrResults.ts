/**
 * Đọc các file kết quả ACRCloud rồi tạo data/catalog.acrcloud.csv.
 * Cách dùng: npm.cmd run catalog:acr -- <thư mục kết quả>
 * Mặc định đọc out/raw của music-audit.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { convertAcrFiles, toCatalogCsv } from '../src/acrConvert.ts';
import type { AcrFile } from '../src/acrConvert.ts';

const projectRoot = join(import.meta.dirname, '..');
const inputFolder = resolve(process.argv[2] ?? join(projectRoot, '..', '..', 'out', 'raw'));

let fileNames: string[];
try {
  fileNames = readdirSync(inputFolder).filter((name) => name.endsWith('.json'));
} catch {
  console.error(`Không đọc được thư mục ${inputFolder}. Hãy chạy submit và fetch của music-audit trước.`);
  process.exit(1);
}

const files: AcrFile[] = [];
const badFiles: string[] = [];
for (const name of fileNames) {
  try {
    files.push(JSON.parse(readFileSync(join(inputFolder, name), 'utf-8')) as AcrFile);
  } catch {
    badFiles.push(name);
  }
}

const result = convertAcrFiles(files);
const outputPath = join(projectRoot, 'data', 'catalog.acrcloud.csv');
mkdirSync(join(projectRoot, 'data'), { recursive: true });
writeFileSync(outputPath, toCatalogCsv(result.rows));

console.log(`Đã đọc ${result.scannedFiles} kết quả quét, ghi ${result.rows.length} bài vào data/catalog.acrcloud.csv`);
console.log(`- Không nhận ra bài nào: ${result.noMatchFiles} file. Các file này không được coi là an toàn.`);
console.log(`- Chưa xong hoặc lỗi, đã bỏ qua: ${result.unfinishedFiles} file`);
console.log(`- Thiếu tên bài hoặc nghệ sĩ, đã bỏ qua: ${result.skippedMatches} bài`);
if (badFiles.length > 0) {
  console.log(`- Không đọc được: ${badFiles.join(', ')}`);
  process.exitCode = 1;
}
