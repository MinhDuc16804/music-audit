/**
 * Tạo public/audio-library.json từ file JSON của nguồn cộng đồng.
 * Cách dùng: npm.cmd run library:import -- data/music-1000.json
 * Dữ liệu sai thì không ghi gì, để app vẫn dùng danh sách đang có.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyLibraryAdditions, parseAudioLibrarySource } from '../src/audioLibrary.ts';
import type { AudioLibraryFile } from '../src/audioLibrary.ts';
import { readLibraryAdditions } from './libraryAdditions.ts';

const SOURCE_URL = 'https://github.com/operator-name/youtube-audio-library-download-all';
const SOURCE_UPDATED_ON = '2020-04-21';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Thiếu đường dẫn file. Ví dụ: npm.cmd run library:import -- data/music-1000.json');
  process.exit(1);
}

try {
  const tracks = applyLibraryAdditions(parseAudioLibrarySource(JSON.parse(readFileSync(resolve(inputPath), 'utf8'))), readLibraryAdditions());
  const file: AudioLibraryFile = {
    generatedAt: new Date().toISOString(),
    sourceUpdatedOn: SOURCE_UPDATED_ON,
    sourceUrl: SOURCE_URL,
    tracks,
  };
  writeFileSync(join(import.meta.dirname, '..', 'public', 'audio-library.json'), `${JSON.stringify(file)}\n`);
  console.log(`Đã nhập ${tracks.length} bài, ${tracks.filter((track) => track.attribution).length} bài cần ghi nguồn.`);
} catch (error) {
  console.error(`Không nhập được: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
