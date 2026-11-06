/**
 * Kiểm tra file CSV rồi tạo public/catalog.json cho app.
 * Cách dùng: npm.cmd run catalog:import -- data/catalog.csv
 * Có dòng lỗi thì không ghi gì cả, để app không nhận dữ liệu sai.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { importCatalogRows, parseCsv } from '../src/catalogImport.ts';
import type { CatalogFile } from '../src/catalog';

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
const inputPath = args.find((arg) => !arg.startsWith('--'));
if (!inputPath) {
  console.error('Thiếu đường dẫn file CSV. Ví dụ: npm.cmd run catalog:import -- data/catalog.csv');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const { entries, errors, warnings } = importCatalogRows(parseCsv(readFileSync(resolve(inputPath), 'utf-8')), today);

printIssues('Lỗi, cần sửa', errors);
printIssues('Cảnh báo', warnings);

if (errors.length > 0) {
  console.error('\nChưa nhập gì. Hãy sửa các dòng lỗi rồi chạy lại.');
  process.exit(1);
}

const catalogFile: CatalogFile = { generatedAt: new Date().toISOString(), isDemo, entries };
const outputPath = join(import.meta.dirname, '..', 'public', 'catalog.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(catalogFile));

const counts = new Map<string, number>();
entries.forEach(({ status }) => counts.set(status, (counts.get(status) ?? 0) + 1));
const summary = [...counts].map(([status, count]) => `${status}: ${count}`);
console.log(`\nĐã nhập ${entries.length} bài (${summary.join(', ')}) vào public/catalog.json`);
if (isDemo) {
  console.log('Đây là dữ liệu demo, app sẽ hiện cảnh báo rõ ràng.');
}
