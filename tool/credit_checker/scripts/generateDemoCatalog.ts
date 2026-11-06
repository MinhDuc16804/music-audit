/**
 * Tạo file CSV giả để thử app với khối lượng lớn. Mọi tên đều có chữ "demo".
 * Cách dùng: npm.cmd run catalog:demo
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG_COLUMNS } from '../src/catalogImport.ts';

const args = process.argv.slice(2);
const outputPath = join(import.meta.dirname, '..', 'data', 'catalog.demo.csv');

// File có thể đang mở trong Excel và bị khóa, nên không ghi lại khi đã có sẵn.
if (args.includes('--if-missing') && existsSync(outputPath)) {
  console.log('Đã có data/catalog.demo.csv, dùng lại file này.');
  process.exit(0);
}

const SONG_COUNT = Number(args.find((arg) => !arg.startsWith('--')) ?? 5000);
const ARTIST_COUNT = 200;
const DEMO_SOURCE = 'DEMO - không phải dữ liệu thật';

const pad = (value: number, length: number) => String(value).padStart(length, '0');

function getDemoLicense(index: number) {
  const bucket = index % 10;
  if (bucket <= 3) {
    return { status: 'LICENSED', license: 'Hợp đồng demo', allowedUse: index % 20 === 2 ? 'youtube' : 'all' };
  }
  if (bucket <= 6) {
    return { status: 'SAFE', license: 'Public Domain demo', allowedUse: '' };
  }
  if (bucket === 7) {
    return { status: 'WARNING', license: 'CC BY 4.0 demo', allowedUse: '' };
  }
  return { status: 'RESTRICTED', license: 'Bản thương mại demo', allowedUse: '' };
}

const rows = [CATALOG_COLUMNS.join(',')];
for (let index = 1; index <= SONG_COUNT; index += 1) {
  const title = `Bài demo ${pad(index, 5)}`;
  const artist = `Nghệ sĩ demo ${pad(index % ARTIST_COUNT, 3)}`;
  const { status, license, allowedUse } = getDemoLicense(index);
  const expiresOn = status === 'LICENSED' ? (index % 50 === 0 ? '2020-12-31' : '2030-12-31') : '';
  const attribution = status === 'WARNING' ? `"${title}" ${artist} (demo)` : '';
  const cells = [title, artist, status, license, allowedUse, expiresOn, DEMO_SOURCE, 'demo', attribution];
  rows.push(cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','));
}

mkdirSync(join(import.meta.dirname, '..', 'data'), { recursive: true });
writeFileSync(outputPath, `${rows.join('\n')}\n`);
console.log(`Đã tạo ${SONG_COUNT} bài demo vào data/catalog.demo.csv`);
