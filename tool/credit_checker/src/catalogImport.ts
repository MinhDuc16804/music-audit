/**
 * Đọc và kiểm tra file CSV dữ liệu bài hát. Dòng lỗi không được đi vào app.
 * File này không phụ thuộc trình duyệt để script Node dùng chung được.
 */

import type { UseCase } from './analyzer';
import type { CatalogEntry, CopyrightStatus } from './catalog';
import { getCatalogKey, normalizeText } from './textNormalize.ts';

export interface ImportIssue {
  line: number;
  message: string;
}

export interface ImportResult {
  entries: CatalogEntry[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export const CATALOG_COLUMNS = [
  'title',
  'artist',
  'status',
  'license_type',
  'allowed_use',
  'expires_on',
  'source',
  'verified_by',
  'attribution',
] as const;

const REQUIRED_COLUMNS = ['title', 'artist', 'status', 'license_type', 'source', 'verified_by'];
const STATUSES: CopyrightStatus[] = ['SAFE', 'LICENSED', 'WARNING', 'RESTRICTED'];
const ALL_USES: UseCase[] = ['youtube_monetized', 'paid_ads', 'corporate_film', 'podcast_livestream'];
const USE_ALIASES: Record<string, UseCase> = {
  youtube: 'youtube_monetized',
  ads: 'paid_ads',
  film: 'corporate_film',
  podcast: 'podcast_livestream',
};

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

function splitAliases(value: string): string[] {
  return value
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function parseAllowedUses(value: string): UseCase[] | null {
  const parts = splitAliases(value.toLowerCase());
  if (parts.includes('all')) {
    return ALL_USES;
  }
  const uses = parts.map((part) => USE_ALIASES[part]);
  return uses.length > 0 && uses.every(Boolean) ? uses : null;
}

function getRightsText(status: CopyrightStatus, licenseType: string) {
  if (status === 'SAFE') {
    return {
      compositionRights: `Theo nguồn đã ghi, bản phổ không còn được bảo hộ (${licenseType}).`,
      masterRights: 'Bản thu hiện đại vẫn có thể có bản quyền riêng, hãy kiểm tra bản thu cụ thể.',
    };
  }
  if (status === 'LICENSED') {
    return {
      compositionRights: `Theo giấy phép của đội: ${licenseType}.`,
      masterRights: 'Đối chiếu hợp đồng để chắc giấy phép gồm cả quyền bản thu.',
    };
  }
  if (status === 'WARNING') {
    return {
      compositionRights: `Dùng theo điều kiện của giấy phép: ${licenseType}.`,
      masterRights: 'Áp dụng cùng điều kiện, nếu nguồn không ghi khác.',
    };
  }
  return {
    compositionRights: 'Còn được bảo hộ, cần giấy phép trước khi dùng.',
    masterRights: 'Thuộc hãng đĩa hoặc đơn vị phát hành.',
  };
}

/** Kiểm tra từng dòng. Số dòng tính cả dòng tiêu đề, khớp với số dòng trong Excel. */
export function importCatalogRows(rows: string[][], today: string): ImportResult {
  const entries: CatalogEntry[] = [];
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const [header, ...body] = rows;

  const columns = (header ?? []).map((name) => name.toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    errors.push({ line: 1, message: `Thiếu cột: ${missing.join(', ')}` });
    return { entries, errors, warnings };
  }

  const seenKeys = new Map<string, number>();

  body.forEach((cells, index) => {
    const line = index + 2;
    if (cells.every((cell) => !cell)) {
      return;
    }
    const addError = (message: string) => errors.push({ line, message });
    if (cells.length > columns.length) {
      addError('Thừa cột, ô có dấu phẩy cần nằm trong ngoặc kép');
      return;
    }
    if (cells.some((cell) => cell.includes('�'))) {
      addError('Lỗi mã hóa tiếng Việt, hãy lưu file dạng CSV UTF-8');
      return;
    }

    const read = (name: string) => cells[columns.indexOf(name)] ?? '';
    const titles = splitAliases(read('title'));
    const artists = splitAliases(read('artist'));
    const status = read('status').toUpperCase() as CopyrightStatus;
    const licenseType = read('license_type');
    const source = read('source');
    const verifiedBy = read('verified_by');
    const expiresOn = read('expires_on');
    const allowedUseText = read('allowed_use');
    const attribution = read('attribution').replace(/\\n/g, '\n');

    if (titles.length === 0 || artists.length === 0) {
      addError('Thiếu title hoặc artist');
      return;
    }
    if (!STATUSES.includes(status)) {
      addError(`status phải là một trong ${STATUSES.join(', ')}`);
      return;
    }
    if (!licenseType || !source || !verifiedBy) {
      addError('Thiếu license_type, source hoặc verified_by');
      return;
    }
    if (titles.some((title) => !normalizeText(title)) || artists.some((artist) => !normalizeText(artist))) {
      addError('title hoặc artist không có chữ hay số nào');
      return;
    }
    if (expiresOn && !isValidDate(expiresOn)) {
      addError('expires_on phải có dạng YYYY-MM-DD, ví dụ 2027-12-31');
      return;
    }

    const allowedUses = allowedUseText ? parseAllowedUses(allowedUseText) : undefined;
    if (allowedUses === null) {
      addError('allowed_use chỉ nhận all, youtube, ads, film, podcast, ngăn bằng |');
      return;
    }
    if (status === 'LICENSED' && !allowedUses) {
      addError('Dòng LICENSED phải ghi allowed_use');
      return;
    }

    const keys = titles.flatMap((title) => artists.map((artist) => getCatalogKey(title, artist)));
    const duplicateOf = keys.map((key) => seenKeys.get(key)).find((found) => found !== undefined);
    if (duplicateOf !== undefined) {
      addError(`Trùng bài với dòng ${duplicateOf}`);
      return;
    }
    keys.forEach((key) => seenKeys.set(key, line));

    if (expiresOn && expiresOn < today) {
      warnings.push({ line, message: `Giấy phép đã hết hạn từ ${expiresOn}, app sẽ coi là rủi ro cao` });
    }
    if (status === 'WARNING' && !attribution) {
      warnings.push({ line, message: 'Dòng WARNING chưa có attribution nên app không có đoạn ghi nguồn để sao chép' });
    }

    entries.push({
      titles,
      artists,
      status,
      licenseType,
      ...getRightsText(status, licenseType),
      sourceNote: `Nguồn: ${source}. Người xác nhận: ${verifiedBy}.`,
      attribution: attribution || undefined,
      allowedUses,
      expiresOn: expiresOn || undefined,
    });
  });

  return { entries, errors, warnings };
}
