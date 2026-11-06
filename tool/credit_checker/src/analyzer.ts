/**
 * Phân loại bản quyền theo luật cố định và dữ liệu mẫu, không dùng AI.
 *
 * Nguyên tắc: không chắc thì coi là rủi ro cao. Nhãn SAFE hoặc WARNING chỉ xuất hiện khi
 * khớp chính xác cả tên bài lẫn tác giả. Không có từ khóa nào tự nó làm bài trở nên an toàn.
 */

import { CATALOG, FREE_SOURCES, PAID_SOURCES, PUBLIC_DOMAIN_SOURCES } from './catalog';
import type { CatalogEntry, CopyrightStatus, MusicResource } from './catalog';

export type UseCase = 'youtube_monetized' | 'paid_ads' | 'corporate_film' | 'podcast_livestream';
export type RiskLevel = 'Thấp' | 'Trung bình' | 'Cao' | 'Rất cao';
export type MatchKind = 'catalog' | 'derivative' | 'unverified';

export const USE_CASE_LABELS: Record<UseCase, string> = {
  youtube_monetized: 'YouTube có kiếm tiền',
  paid_ads: 'Quảng cáo trả phí / TikTok Ads',
  corporate_film: 'Phim doanh nghiệp',
  podcast_livestream: 'Podcast / Livestream',
};

export const STATUS_LABELS: Record<CopyrightStatus, string> = {
  SAFE: 'An toàn (chỉ phần bản phổ)',
  WARNING: 'Có điều kiện',
  RESTRICTED: 'Rủi ro cao',
};

export interface AnalysisInput {
  title: string;
  artist: string;
  useCase: UseCase;
}

export interface AnalysisResult {
  title: string;
  artist: string;
  status: CopyrightStatus;
  statusLabel: string;
  matchKind: MatchKind;
  riskLevel: RiskLevel;
  licenseType: string;
  compositionRights: string;
  masterRights: string;
  sourceNote: string;
  steps: string[];
  alternatives: MusicResource[];
  attribution?: string;
}

const DERIVATIVE_WORDS =
  /\b(remix|cover|mashup|edit|mix|version|karaoke|live|feat|ft|nightcore|lofi|lo fi|sped up|slowed|instrumental|beat|ban phoi|phoi lai)\b/;

/** Chuẩn hóa để so sánh: bỏ dấu, viết thường, chỉ giữ chữ và số, kể cả chữ không phải Latin. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Chuẩn hóa tên bài và bỏ phần trong ngoặc. */
export function normalizeTitle(value: string): string {
  return normalizeText(value.replace(/\(.*?\)|\[.*?\]/g, ' '));
}

/** Bản remix, cover hay bản phối có quyền riêng, kể cả khi bản gốc đã tự do. */
export function isDerivativeTitle(title: string): boolean {
  return DERIVATIVE_WORDS.test(normalizeText(title));
}

/** Tìm bài trong dữ liệu mẫu. Phải khớp toàn bộ cả tên bài và tác giả. */
export function findCatalogEntry(title: string, artist: string): CatalogEntry | undefined {
  const wantedTitle = normalizeTitle(title);
  const wantedArtist = normalizeText(artist);
  if (!wantedTitle || !wantedArtist) {
    return undefined;
  }
  return CATALOG.find(
    (entry) =>
      entry.titles.some((candidate) => normalizeTitle(candidate) === wantedTitle) &&
      entry.artists.some((candidate) => normalizeText(candidate) === wantedArtist),
  );
}

function getRiskLevel(status: CopyrightStatus, useCase: UseCase): RiskLevel {
  if (status === 'RESTRICTED') {
    return useCase === 'paid_ads' ? 'Rất cao' : 'Cao';
  }
  if (status === 'WARNING') {
    return useCase === 'paid_ads' ? 'Cao' : 'Trung bình';
  }
  return useCase === 'paid_ads' ? 'Trung bình' : 'Thấp';
}

const USE_CASE_STEPS: Record<CopyrightStatus, Record<UseCase, string>> = {
  SAFE: {
    youtube_monetized: 'Bản thu có sẵn vẫn có thể bị Content ID nhận diện. Hãy lưu bằng chứng giấy phép để kháng nghị khi cần.',
    paid_ads: 'Quảng cáo trả phí nên dùng bản tự thu hoặc bản thu có giấy phép bằng văn bản.',
    corporate_film: 'Lưu giấy phép bản thu cùng hồ sơ dự án để bàn giao cho khách hàng.',
    podcast_livestream: 'Livestream có thể bị tắt tiếng tự động, nên thử trước bằng buổi phát riêng tư.',
  },
  WARNING: {
    youtube_monetized: 'Dán đoạn ghi nguồn vào phần mô tả video trước khi đăng.',
    paid_ads: 'Quảng cáo thường không có chỗ ghi nguồn. Nên mua giấy phép không cần ghi nguồn hoặc đổi bài.',
    corporate_film: 'Đưa phần ghi nguồn vào credit cuối phim và mô tả nơi đăng.',
    podcast_livestream: 'Đọc hoặc ghi nguồn trong shownote và mô tả buổi phát.',
  },
  RESTRICTED: {
    youtube_monetized: 'Video có thể bị chặn, bị chuyển doanh thu cho chủ quyền hoặc nhận cảnh cáo bản quyền.',
    paid_ads: 'Tuyệt đối không dùng cho quảng cáo trả phí nếu chưa có Sync License bằng văn bản.',
    corporate_film: 'Cần giấy phép cho cả phần sáng tác lẫn bản thu trước khi phát hành.',
    podcast_livestream: 'Không phát trong podcast hoặc livestream nếu chưa có giấy phép phù hợp.',
  },
};

function getActionSteps(status: CopyrightStatus, useCase: UseCase, matchKind: MatchKind): string[] {
  const steps: string[] = [];
  if (matchKind === 'derivative') {
    steps.push('Xác định tác giả của bản phối hoặc bản cover, vì bản này có quyền riêng với bản gốc.');
  }
  if (matchKind === 'unverified') {
    steps.push('Bài chưa có trong dữ liệu mẫu nên công cụ chưa biết tình trạng thật. Hãy tìm chủ quyền của bài.');
  }
  if (status === 'SAFE') {
    steps.push('Tự thu âm lại từ bản phổ là cách chắc chắn nhất.');
    steps.push('Nếu dùng bản thu có sẵn, hãy kiểm tra quyền của chính bản thu đó.');
  }
  if (status === 'WARNING') {
    steps.push('Mở trang gốc của bài để xác nhận giấy phép vẫn còn hiệu lực.');
  }
  if (status === 'RESTRICTED') {
    steps.push('Liên hệ chủ quyền để xin Sync License, hoặc đổi sang nguồn nhạc an toàn.');
  }
  steps.push(USE_CASE_STEPS[status][useCase]);
  steps.push('Lưu giấy phép, hóa đơn và ảnh chụp trang điều khoản vào hồ sơ dự án.');
  return steps;
}

function getAlternatives(status: CopyrightStatus): MusicResource[] {
  if (status === 'SAFE') {
    return PUBLIC_DOMAIN_SOURCES;
  }
  if (status === 'WARNING') {
    return FREE_SOURCES;
  }
  return [...PAID_SOURCES, ...FREE_SOURCES];
}

function getFallbackDetails(matchKind: MatchKind, hasArtist: boolean) {
  if (matchKind === 'derivative') {
    return {
      licenseType: 'Bản phái sinh, chưa xác minh',
      compositionRights: 'Bản phái sinh dùng phần sáng tác của bài gốc, và tình trạng của bài gốc không tự chuyển sang bản này.',
      masterRights: 'Bản phối hoặc bản cover có bản thu và người giữ quyền riêng.',
      sourceNote: 'Tên bài có dấu hiệu là bản remix, cover hoặc bản phối.',
    };
  }
  return {
    licenseType: 'Chưa xác minh, giả định còn bản quyền',
    compositionRights: 'Không có dữ liệu. Mặc định phần sáng tác còn được bảo hộ.',
    masterRights: 'Không có dữ liệu. Mặc định bản thu có chủ quyền.',
    sourceNote: hasArtist
      ? 'Bài không có trong dữ liệu mẫu. Kết quả này là giả định an toàn, không phải kết luận về bài.'
      : 'Thiếu tên tác giả nên không thể đối chiếu. Kết quả này là giả định an toàn.',
  };
}

export function analyzeMusic({ title, artist, useCase }: AnalysisInput): AnalysisResult {
  const derivative = isDerivativeTitle(title);
  const entry = derivative ? undefined : findCatalogEntry(title, artist);
  const matchKind: MatchKind = entry ? 'catalog' : derivative ? 'derivative' : 'unverified';
  const status: CopyrightStatus = entry?.status ?? 'RESTRICTED';
  const details = entry ?? getFallbackDetails(matchKind, Boolean(artist.trim()));

  return {
    title: title.trim(),
    artist: artist.trim(),
    status,
    statusLabel: STATUS_LABELS[status],
    matchKind,
    riskLevel: getRiskLevel(status, useCase),
    licenseType: details.licenseType,
    compositionRights: details.compositionRights,
    masterRights: details.masterRights,
    sourceNote: details.sourceNote,
    steps: getActionSteps(status, useCase, matchKind),
    alternatives: getAlternatives(status),
    attribution: entry?.attribution,
  };
}
