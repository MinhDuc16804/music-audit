/**
 * Kiểm tra một hoặc nhiều file CSV rồi tạo public/catalog.json cho app.
 * Cách dùng: npm.cmd run catalog:import -- data/catalog.csv data/catalog.acrcloud.csv
 * Khi trùng bài, file đứng trước được ưu tiên, nên hãy đặt file hợp đồng lên đầu.
 * Có dòng lỗi thì không ghi gì cả, để app không nhận dữ liệu sai.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { importCatalogRows, mergeCatalogEntries, parseCsv } from '../src/catalogImport.ts';
import type { CatalogEntry, CatalogFile } from '../src/catalog';

const MAX_PRINTED_ISSUES = 20;

function printIssues(title: string, issues: { line: number; message: string }[]) {
  if (issues.length === 0) {
    return;
  }
  console.log(`\n${title}: ${issues.length}`);
  issues.slice(0, MAX_PRINTED_ISSUES).forEach(({ line, message }) => console.log(`- Dòng ${line}: ${message}`));
  if (issues.length > MAX_PRINTED_ISSUES) {
    console.log(`- ... và ${issues.length - MAX_PRINTED_ISSUES} dòng khác`);
  }
}

const args = process.argv.slice(2);
const isDemo = args.includes('--demo');
const inputPaths = args.filter((arg) => !arg.startsWith('--'));
if (inputPaths.length === 0) {
  console.error('Thiếu đường dẫn file CSV. Ví dụ: npm.cmd run catalog:import -- data/catalog.csv');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const lists: CatalogEntry[][] = [];
let hasErrors = false;

for (const inputPath of inputPaths) {
  const { entries, errors, warnings } = importCatalogRows(parseCsv(readFileSync(resolve(inputPath), 'utf-8')), today);
  printIssues(`${inputPath}, lỗi cần sửa`, errors);
  printIssues(`${inputPath}, cảnh báo`, warnings);
  hasErrors ||= errors.length > 0;
  lists.push(entries);
}

if (hasErrors) {
  console.error('\nChưa nhập gì. Hãy sửa các dòng lỗi rồi chạy lại.');
  process.exit(1);
}

const { entries, skippedCount } = mergeCatalogEntries(lists);
const catalogFile: CatalogFile = { generatedAt: new Date().toISOString(), isDemo, entries };
const outputPath = join(import.meta.dirname, '..', 'public', 'catalog.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(catalogFile));

const counts = new Map<string, number>();
entries.forEach(({ status }) => counts.set(status, (counts.get(status) ?? 0) + 1));
const summary = [...counts].map(([status, count]) => `${status}: ${count}`);
console.log(`\nĐã nhập ${entries.length} bài (${summary.join(', ')}) vào public/catalog.json`);
if (skippedCount > 0) {
  console.log(`Bỏ qua ${skippedCount} bài trùng với file đứng trước.`);
}
if (isDemo) {
  console.log('Đây là dữ liệu demo, app sẽ hiện cảnh báo rõ ràng.');
}
