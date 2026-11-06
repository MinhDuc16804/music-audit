/**
 * Chuyển kết quả quét của ACRCloud thành dòng CSV cho app.
 *
 * Luật: mọi bài ACRCloud nhận ra đều là RESTRICTED. ACRCloud cho biết ai giữ quyền, không cho biết
 * công ty có được dùng hay không, nên kể cả chính sách Allow cũng không tạo ra nhãn xanh.
 * Bài không nhận ra thì không ghi gì: không khớp nghĩa là chưa biết, không phải an toàn.
 *
 * Định dạng dựa theo tài liệu API, chưa đối chiếu với tài khoản thật.
 */

import { CATALOG_COLUMNS } from './catalogImport.ts';
import { getCatalogKey, normalizeText } from './textNormalize.ts';

interface AcrRightsClaim {
  distributor?: string | { name?: string };
  rights_owners?: { name?: string; share_percentage?: number }[];
  rights_claim_policy?: string;
  territories?: string[];
}

interface AcrResult {
  title?: string;
  artists?: { name?: string }[];
  label?: string;
  external_ids?: { isrc?: string | string[] };
  rights_claim?: AcrRightsClaim[];
}

interface AcrMatch {
  result?: AcrResult;
}

export interface AcrFile {
  state?: number;
  results?: { music?: AcrMatch[]; cover_songs?: AcrMatch[] } | null;
}

export interface AcrConvertResult {
  rows: string[][];
  scannedFiles: number;
  noMatchFiles: number;
  unfinishedFiles: number;
  skippedMatches: number;
}

const UNFINISHED_STATES = [0, -2, -3];
const VERIFIED_BY = 'ACRCloud (tự động)';

/** Dấu | là ký tự ngăn tên phụ trong CSV của app. */
function cleanName(value: string | undefined): string {
  return (value ?? '').replace(/\|/g, '/').trim();
}

function getDistributorName(claim: AcrRightsClaim): string {
  return typeof claim.distributor === 'string' ? claim.distributor : (claim.distributor?.name ?? '');
}

/** Tóm tắt rights_claim thành một câu. Trả về chuỗi rỗng nếu ACRCloud không trả trường này. */
export function summarizeRightsClaims(claims: AcrRightsClaim[] | undefined): string {
  const owners = new Set<string>();
  const policies = new Set<string>();

  for (const claim of claims ?? []) {
    const distributor = getDistributorName(claim);
    if (distributor) {
      owners.add(distributor);
    }
    for (const owner of claim.rights_owners ?? []) {
      if (owner.name) {
        owners.add(owner.share_percentage === undefined ? owner.name : `${owner.name} ${owner.share_percentage}%`);
      }
    }
    if (claim.rights_claim_policy) {
      policies.add(claim.rights_claim_policy);
    }
  }

  const parts: string[] = [];
  if (owners.size > 0) {
    parts.push(`chủ quyền: ${[...owners].join('; ')}`);
  }
  if (policies.size > 0) {
    parts.push(`chính sách: ${[...policies].join('; ')}`);
  }
  return parts.join(', ');
}

function getIsrc(result: AcrResult): string {
  const isrc = result.external_ids?.isrc;
  return (Array.isArray(isrc) ? isrc[0] : isrc) ?? '';
}

function buildSource(result: AcrResult): string {
  const isrc = getIsrc(result);
  const rights = summarizeRightsClaims(result.rights_claim);
  return ['ACRCloud', isrc && `ISRC ${isrc}`, rights].filter(Boolean).join(', ');
}

export function convertAcrFiles(files: AcrFile[]): AcrConvertResult {
  const rows: string[][] = [];
  const seenKeys = new Set<string>();
  let noMatchFiles = 0;
  let unfinishedFiles = 0;
  let skippedMatches = 0;

  for (const file of files) {
    if (file.state === undefined || UNFINISHED_STATES.includes(file.state)) {
      unfinishedFiles += 1;
      continue;
    }
    const matches = [...(file.results?.music ?? []), ...(file.results?.cover_songs ?? [])];
    if (matches.length === 0) {
      noMatchFiles += 1;
    }

    for (const { result } of matches) {
      const title = cleanName(result?.title);
      const artists = (result?.artists ?? []).map(({ name }) => cleanName(name)).filter((name) => normalizeText(name));
      if (!result || !normalizeText(title) || artists.length === 0) {
        skippedMatches += 1;
        continue;
      }

      const newArtists = artists.filter((artist) => !seenKeys.has(getCatalogKey(title, artist)));
      if (newArtists.length === 0) {
        continue;
      }
      newArtists.forEach((artist) => seenKeys.add(getCatalogKey(title, artist)));

      const licenseType = result.label ? `Bản đã phát hành, hãng ${result.label}` : 'Bản đã phát hành';
      rows.push([title, newArtists.join('|'), 'RESTRICTED', licenseType, '', '', buildSource(result), VERIFIED_BY, '']);
    }
  }

  return { rows, scannedFiles: files.length, noMatchFiles, unfinishedFiles, skippedMatches };
}

/** Ghi dòng thành CSV theo đúng thứ tự cột mà bộ nhập dữ liệu yêu cầu. */
export function toCatalogCsv(rows: string[][]): string {
  const quote = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  return [[...CATALOG_COLUMNS], ...rows].map((row) => row.map(quote).join(',')).join('\n') + '\n';
}
