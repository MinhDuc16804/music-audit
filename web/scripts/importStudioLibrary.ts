/**
 * Gộp file xuất từ YouTube Studio vào public/audio-library.json.
 * Cách dùng: npm.cmd run library:studio -- C:/duong-dan/youtube-tracks.json
 * Không xóa bài nào. Dữ liệu sai thì không ghi gì, để app vẫn dùng danh sách đang có.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyLibraryAdditions, isAudioLibraryFile, mergeAudioLibraryTracks, parseStudioExport } from '../src/audioLibrary.ts';
import type { AudioLibraryFile } from '../src/audioLibrary.ts';
import { readLibraryAdditions } from './libraryAdditions.ts';

const SOURCE_URL = 'https://studio.youtube.com';
const LIBRARY_PATH = join(import.meta.dirname, '..', 'public', 'audio-library.json');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Thiếu đường dẫn file. Ví dụ: npm.cmd run library:studio -- C:/duong-dan/youtube-tracks.json');
  process.exit(1);
}

try {
  const current: unknown = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8'));
  if (!isAudioLibraryFile(current)) {
    throw new Error('Danh sách đang dùng không hợp lệ.');
  }
  const fullPath = resolve(inputPath);
  const fresh = parseStudioExport(JSON.parse(readFileSync(fullPath, 'utf8')));
  const tracks = applyLibraryAdditions(mergeAudioLibraryTracks(current.tracks, fresh), readLibraryAdditions());
  const file: AudioLibraryFile = {
    generatedAt: new Date().toISOString(),
    sourceUpdatedOn: statSync(fullPath).mtime.toISOString().slice(0, 10),
    sourceUrl: SOURCE_URL,
    tracks,
  };
  writeFileSync(LIBRARY_PATH, `${JSON.stringify(file)}\n`);
  const unconfirmed = tracks.filter((track) => track.unconfirmed).length;
  console.log(`Danh sách có ${tracks.length} bài: ${fresh.length} bài từ Studio, ${unconfirmed} bài chưa xác nhận lại.`);
} catch (error) {
  console.error(`Không nhập được: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
