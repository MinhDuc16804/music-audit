/**
 * Áp library-additions.csv vào public/audio-library.json.
 * Cách dùng: npm.cmd run library:additions
 * Dữ liệu sai thì không ghi gì, để app vẫn dùng danh sách đang có.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyLibraryAdditions, isAudioLibraryFile } from '../src/audioLibrary.ts';
import { readLibraryAdditions } from './libraryAdditions.ts';

const LIBRARY_PATH = join(import.meta.dirname, '..', 'public', 'audio-library.json');

try {
  const current: unknown = JSON.parse(readFileSync(LIBRARY_PATH, 'utf8'));
  if (!isAudioLibraryFile(current)) {
    throw new Error('Danh sách đang dùng không hợp lệ.');
  }
  const tracks = applyLibraryAdditions(current.tracks, readLibraryAdditions());
  writeFileSync(LIBRARY_PATH, `${JSON.stringify({ ...current, generatedAt: new Date().toISOString(), tracks })}\n`);
  const manual = tracks.filter((track) => track.manual).length;
  console.log(`Danh sách có ${tracks.length} bài, trong đó ${manual} bài thêm tay.`);
} catch (error) {
  console.error(`Không nhập được: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
