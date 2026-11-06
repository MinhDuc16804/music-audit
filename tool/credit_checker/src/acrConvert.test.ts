import { describe, expect, it } from 'vitest';
import { convertAcrFiles, summarizeRightsClaims, toCatalogCsv } from './acrConvert.ts';
import type { AcrFile } from './acrConvert.ts';
import { analyzeMusic, buildCatalogIndex } from './analyzer';
import { importCatalogRows, mergeCatalogEntries, parseCsv } from './catalogImport.ts';

const TODAY = '2026-11-06';
const STATUS_COLUMN = 2;
const SOURCE_COLUMN = 6;

const match = (title: string, artists: string[], extra: object = {}) => ({
  result: { title, artists: artists.map((name) => ({ name })), label: 'Hang A', ...extra },
});
const file = (...music: ReturnType<typeof match>[]): AcrFile => ({ state: 1, results: { music } });
const toEntries = (acrFile: AcrFile) => {
  const csv = toCatalogCsv(convertAcrFiles([acrFile]).rows);
  return importCatalogRows(parseCsv(csv), TODAY);
};

describe('summarizeRightsClaims', () => {
  it('tóm tắt chủ quyền, tỷ lệ và chính sách', () => {
    const summary = summarizeRightsClaims([
      { rights_owners: [{ name: 'Hang A', share_percentage: 60 }], rights_claim_policy: 'BlockAccess' },
      { distributor: { name: 'Nha phan phoi B' }, rights_claim_policy: 'Monetize' },
    ]);
    expect(summary).toContain('Hang A 60%');
    expect(summary).toContain('Nha phan phoi B');
    expect(summary).toContain('BlockAccess; Monetize');
  });

  it('trả về chuỗi rỗng khi không có trường này', () => {
    expect(summarizeRightsClaims(undefined)).toBe('');
  });
});

describe('convertAcrFiles', () => {
  it('mọi bài nhận ra đều là RESTRICTED, kể cả chính sách Allow', () => {
    const { rows } = convertAcrFiles([
      file(match('Bai A', ['Ca si A'], { rights_claim: [{ rights_claim_policy: 'Allow' }] })),
    ]);
    expect(rows[0][STATUS_COLUMN]).toBe('RESTRICTED');
    expect(rows[0][SOURCE_COLUMN]).toContain('Allow');
  });

  it('đọc cả cover_songs và ghi ISRC vào nguồn', () => {
    const { rows } = convertAcrFiles([
      { state: 1, results: { cover_songs: [match('Bai B', ['Ca si B'], { external_ids: { isrc: ['VNA1'] } })] } },
    ]);
    expect(rows[0][SOURCE_COLUMN]).toContain('ISRC VNA1');
  });

  it('không ghi gì cho file không nhận ra bài và đếm riêng', () => {
    const result = convertAcrFiles([
      { state: -1, results: null },
      { state: 1, results: { music: [] } },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.noMatchFiles).toBe(2);
  });

  it('bỏ qua file chưa xong hoặc lỗi', () => {
    const result = convertAcrFiles([{ state: 0 }, { state: -2 }, { state: -3 }, {}]);
    expect(result.rows).toEqual([]);
    expect(result.unfinishedFiles).toBe(4);
  });

  it('bỏ qua bài thiếu tên hoặc nghệ sĩ', () => {
    const result = convertAcrFiles([file(match('', ['Ca si']), match('Bai', []))]);
    expect(result.rows).toEqual([]);
    expect(result.skippedMatches).toBe(2);
  });

  it('gộp bài trùng và giữ nghệ sĩ mới', () => {
    const { rows } = convertAcrFiles([
      file(match('Bai A', ['Ca si A']), match('BÀI A (Remix)', ['Ca sĩ A'])),
      file(match('Bai A', ['Ca si A', 'Ca si B'])),
    ]);
    expect(rows.length).toBe(2);
    expect(rows[1][1]).toBe('Ca si B');
  });

  it('thay dấu | trong tên để không bị hiểu là tên phụ', () => {
    expect(convertAcrFiles([file(match('Bai | A', ['Ca si']))]).rows[0][0]).toBe('Bai / A');
  });
});

describe('từ ACRCloud vào app', () => {
  it('CSV tạo ra qua được bộ kiểm tra, kể cả tên có dấu phẩy và ngoặc kép', () => {
    const { entries, errors } = toEntries(file(match('Bai, "A"', ['Ca si, B', 'Ca si C'])));
    expect(errors).toEqual([]);
    expect(entries[0].titles).toEqual(['Bai, "A"']);
    expect(entries[0].artists).toEqual(['Ca si, B', 'Ca si C']);
  });

  it('app coi bài từ ACRCloud là rủi ro cao', () => {
    const index = buildCatalogIndex(toEntries(file(match('Bai A', ['Ca si A']))).entries);
    const result = analyzeMusic({ title: 'Bai A', artist: 'Ca si A', useCase: 'paid_ads', today: TODAY }, index);
    expect(result.status).toBe('RESTRICTED');
    expect(result.matchKind).toBe('catalog');
    expect(result.sourceNote).toContain('ACRCloud');
  });

  it('hợp đồng của đội được ưu tiên khi trùng bài', () => {
    const header = 'title,artist,status,license_type,allowed_use,expires_on,source,verified_by,attribution';
    const contract = importCatalogRows(parseCsv(`${header}\nBai A,Ca si A,LICENSED,HD 1,all,,HD 1,Duc,`), TODAY);
    const acr = toEntries(file(match('Bai A', ['Ca si A']), match('Bai B', ['Ca si B'])));
    const { entries, skippedCount } = mergeCatalogEntries([contract.entries, acr.entries]);
    expect(skippedCount).toBe(1);
    expect(entries.map(({ status }) => status)).toEqual(['LICENSED', 'RESTRICTED']);
  });
});
