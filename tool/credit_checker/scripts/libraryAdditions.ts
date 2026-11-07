/** Đọc library-additions.csv cho các script cập nhật danh sách. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLibraryAdditions } from '../src/audioLibrary.ts';
import type { AudioLibraryTrack } from '../src/audioLibrary.ts';
import { parseCsv } from '../src/catalogImport.ts';

const ADDITIONS_PATH = join(import.meta.dirname, '..', 'library-additions.csv');

export function readLibraryAdditions(): AudioLibraryTrack[] {
  return parseLibraryAdditions(parseCsv(readFileSync(ADDITIONS_PATH, 'utf8')));
}
