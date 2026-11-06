import { describe, expect, it } from 'vitest';
import { analyzeMusic, findCatalogEntry, isDerivativeTitle, normalizeText, normalizeTitle } from './analyzer';
import type { UseCase } from './analyzer';

const analyze = (title: string, artist: string, useCase: UseCase = 'youtube_monetized') =>
  analyzeMusic({ title, artist, useCase });

describe('normalizeText', () => {
  it('bỏ dấu tiếng Việt, chữ đ và ký tự đặc biệt', () => {
    expect(normalizeText('Lạc Trôi - Đen!')).toBe('lac troi den');
    expect(normalizeText('Für Elise')).toBe('fur elise');
  });

  it('giữ lại chữ không phải Latin', () => {
    expect(normalizeText('사랑')).toBe('사랑');
  });
});

describe('normalizeTitle', () => {
  it('bỏ phần trong ngoặc', () => {
    expect(normalizeTitle('Shape of You (Official Video) [4K]')).toBe('shape of you');
  });
});

describe('isDerivativeTitle', () => {
  it('nhận ra bản phái sinh', () => {
    expect(isDerivativeTitle('Fur Elise (Remix)')).toBe(true);
    expect(isDerivativeTitle('Fur Elise - Bản phối mới')).toBe(true);
  });

  it('không nhầm khi chữ chỉ nằm trong một từ khác', () => {
    expect(isDerivativeTitle('Discover')).toBe(false);
    expect(isDerivativeTitle('Fur Elise')).toBe(false);
  });
});

describe('findCatalogEntry', () => {
  it('khớp khi đúng cả tên bài và tác giả', () => {
    expect(findCatalogEntry('Für Elise', 'Ludwig van Beethoven')?.status).toBe('SAFE');
  });

  it('không khớp khi thiếu hoặc sai một trong hai', () => {
    expect(findCatalogEntry('Fur Elise', '')).toBeUndefined();
    expect(findCatalogEntry('', 'Beethoven')).toBeUndefined();
    expect(findCatalogEntry('Fur Elise', 'Taylor Swift')).toBeUndefined();
    expect(findCatalogEntry('Fur', 'Beethoven')).toBeUndefined();
  });
});

describe('analyzeMusic', () => {
  it('cho SAFE với bản phổ cổ điển nhưng vẫn cảnh báo bản thu', () => {
    const result = analyze('Fur Elise', 'Beethoven');
    expect(result.status).toBe('SAFE');
    expect(result.riskLevel).toBe('Thấp');
    expect(result.masterRights).toContain('Bản thu');
  });

  it('không coi tên có chữ bach là nhạc cổ điển', () => {
    const result = analyze('Bach Tuyet', 'Ca si Viet');
    expect(result.status).toBe('RESTRICTED');
    expect(result.matchKind).toBe('unverified');
  });

  it('không để tên nhạc cổ điển lấn át nghệ sĩ thương mại', () => {
    expect(analyze('Fur Elise', 'Taylor Swift').status).toBe('RESTRICTED');
  });

  it('coi bản remix là bản phái sinh dù tác giả gốc đúng', () => {
    const result = analyze('Fur Elise (Remix)', 'Beethoven');
    expect(result.status).toBe('RESTRICTED');
    expect(result.matchKind).toBe('derivative');
  });

  it('Faded của Alan Walker là bản thương mại, không phải CC BY', () => {
    const result = analyze('Faded', 'Alan Walker');
    expect(result.status).toBe('RESTRICTED');
    expect(result.attribution).toBeUndefined();
  });

  it('nhận bài tiếng Việt khi nhập có dấu', () => {
    expect(analyze('Lạc Trôi', 'Sơn Tùng M-TP').matchKind).toBe('catalog');
  });

  it('bài lạ hoặc thiếu tác giả mặc định là rủi ro cao', () => {
    expect(analyze('Bài hát lạ', 'Ai đó').status).toBe('RESTRICTED');
    expect(analyze('Fur Elise', '').status).toBe('RESTRICTED');
  });

  it('CC BY có đoạn ghi nguồn và bước hành động', () => {
    const result = analyze('Carefree', 'Kevin MacLeod');
    expect(result.status).toBe('WARNING');
    expect(result.attribution).toContain('Kevin MacLeod');
    expect(result.attribution).toContain('creativecommons.org/licenses/by/4.0');
  });

  it('mức rủi ro và các bước đổi theo mục đích sử dụng', () => {
    const youtube = analyze('Carefree', 'Kevin MacLeod', 'youtube_monetized');
    const ads = analyze('Carefree', 'Kevin MacLeod', 'paid_ads');
    expect(youtube.riskLevel).toBe('Trung bình');
    expect(ads.riskLevel).toBe('Cao');
    expect(ads.steps).not.toEqual(youtube.steps);
    expect(analyze('Shape of You', 'Ed Sheeran', 'paid_ads').riskLevel).toBe('Rất cao');
  });

  it('luôn có nguồn nhạc thay thế', () => {
    expect(analyze('Bài hát lạ', 'Ai đó').alternatives.length).toBeGreaterThan(0);
  });
});
