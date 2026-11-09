/**
 * Danh sách bài của YouTube Audio Library và cách tra cứu.
 *
 * YouTube không có API cho thư viện này, nên danh sách được xuất từ YouTube Studio rồi gộp với danh sách cộng đồng.
 * Khớp chắc: cùng tên bài, kể cả phần trong ngoặc, và có một tên nghệ sĩ trùng nhau. AudD có khi ghi tác giả
 * ở nghệ sĩ và tên trong thư viện ở album, nên album cũng được so.
 * Gần khớp: chỉ trùng tên bài, bỏ qua phần trong ngoặc. Có thể là bài khác cùng tên, nên phải có người duyệt.
 */

import { normalizeText, normalizeTitle } from './textNormalize.ts';

/** Các loại 0 đến 2 không cần ghi nguồn, từ 3 trở lên là Creative Commons. */
const MAX_NO_ATTRIBUTION_LICENSE_TYPE = 2;

/** Giấy phép tiêu chuẩn của thư viện trong file xuất từ Studio, không cần ghi nguồn. */
const STUDIO_STANDARD_LICENSE = 'yt-audio-library';

/** Tên ngắn phải có ít nhất từng này từ mới được coi là cách viết khác của tên dài. */
const MIN_PARTIAL_NAME_WORDS = 2;

/** Các cột bắt buộc của library-additions.csv. */
const ADDITION_COLUMNS = ['title', 'artist', 'attribution', 'checkedBy', 'checkedOn'];

export interface AudioLibraryTrack {
  title: string;
  artist: string;
  /** Bài Creative Commons, phải ghi nguồn trong mô tả video. */
  attribution: boolean;
  /** Có trong danh sách cũ nhưng không thấy ở lần xuất mới nhất. File xuất có thể thiếu, nên chưa coi là đã rút. */
  unconfirmed?: boolean;
  /** Bài lấy từ library-additions.csv do người duyệt thêm, không có trong lần xuất mới nhất. */
  manual?: boolean;
}

/** Nội dung file public/audio-library.json do script nhập dữ liệu tạo ra. */
export interface AudioLibraryFile {
  generatedAt: string;
  /** Ngày nguồn được cập nhật lần cuối, dạng YYYY-MM-DD. */
  sourceUpdatedOn: string;
  sourceUrl: string;
  tracks: AudioLibraryTrack[];
}

export interface AudioLibraryIndex {
  byTitle: Map<string, AudioLibraryTrack[]>;
  /** Tên bài đã bỏ phần trong ngoặc. */
  byLooseTitle: Map<string, AudioLibraryTrack[]>;
}

function getTrackKey(title: string, artist: string): string {
  return `${normalizeText(title)}\u0000${normalizeText(artist)}`;
}

/** Dịch vụ nhận diện gộp nghệ sĩ vào một chuỗi, nên thử cả chuỗi đầy đủ lẫn từng tên. */
export function getArtistCandidates(artists: string): string[] {
  return [...new Set([artists, ...artists.split(/,|&|\/|\band\b|\bfeat\.?\s|\bft\.?\s/i)].map((name) => name.trim()))].filter(Boolean);
}

/** Cùng tên, hoặc một tên có đủ các từ của tên kia, như "Patrick Patrikios" và "Patrick Jordan Patrikios". */
export function isSameArtistName(first: string, second: string): boolean {
  const [shorter, longer] = [first, second]
    .map((name) => normalizeText(name).split(' ').filter(Boolean))
    .sort((a, b) => a.length - b.length);
  if (shorter.length === 0) {
    return false;
  }
  if (shorter.length === longer.length) {
    return shorter.join(' ') === longer.join(' ');
  }
  return shorter.length >= MIN_PARTIAL_NAME_WORDS && shorter.every((word) => longer.includes(word));
}

function addToGroup(groups: Map<string, AudioLibraryTrack[]>, key: string, track: AudioLibraryTrack) {
  groups.set(key, [...(groups.get(key) ?? []), track]);
}

export function buildAudioLibraryIndex(tracks: AudioLibraryTrack[]): AudioLibraryIndex {
  const index: AudioLibraryIndex = { byTitle: new Map(), byLooseTitle: new Map() };
  tracks.forEach((track) => {
    addToGroup(index.byTitle, normalizeText(track.title), track);
    addToGroup(index.byLooseTitle, normalizeTitle(track.title), track);
  });
  return index;
}

/** Tìm bài khớp chắc. Album chỉ dùng để so với tên nghệ sĩ trong thư viện. */
export function findAudioLibraryTrack(title: string, artists: string, index: AudioLibraryIndex, album = ''): AudioLibraryTrack | undefined {
  const names = [...getArtistCandidates(artists), album].filter(Boolean);
  return index.byTitle.get(normalizeText(title))?.find((track) =>
    getArtistCandidates(track.artist).some((libraryName) => names.some((name) => isSameArtistName(libraryName, name))),
  );
}

/** Tìm bài trùng tên, không xét nghệ sĩ. Kết quả này chỉ đủ để chuyển người duyệt, không đủ để cho qua. */
export function findNearAudioLibraryTrack(title: string, index: AudioLibraryIndex): AudioLibraryTrack | undefined {
  const key = normalizeTitle(title);
  return key ? index.byLooseTitle.get(key)?.[0] : undefined;
}

interface SourceRow {
  title?: unknown;
  artist?: unknown;
}

/** Bỏ bài trùng, giữ yêu cầu ghi nguồn. Dữ liệu sai thì báo lỗi để không ghi đè danh sách đang dùng. */
function collectTracks<Row extends SourceRow>(
  rows: Row[],
  needsAttribution: (row: Row) => boolean,
): AudioLibraryTrack[] {
  const tracks = new Map<string, AudioLibraryTrack>();
  rows.forEach((row, position) => {
    const { title, artist } = row;
    if (typeof title !== 'string' || !title.trim() || typeof artist !== 'string' || !artist.trim()) {
      throw new Error(`Bài thứ ${position + 1} thiếu tên bài hoặc nghệ sĩ.`);
    }
    const key = getTrackKey(title, artist);
    const attribution = needsAttribution(row) || Boolean(tracks.get(key)?.attribution);
    tracks.set(key, { title: title.trim(), artist: artist.trim(), attribution });
  });
  return [...tracks.values()];
}

/** Đổi file của nguồn cộng đồng thành danh sách gọn. */
export function parseAudioLibrarySource(source: unknown): AudioLibraryTrack[] {
  const rows = (source as { tracks?: unknown } | null)?.tracks;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('File nguồn không có danh sách tracks.');
  }
  return collectTracks(rows as (SourceRow & { license_type?: unknown })[], ({ license_type: licenseType }) => {
    return typeof licenseType !== 'number' || licenseType > MAX_NO_ATTRIBUTION_LICENSE_TYPE;
  });
}

/** Đổi file xuất từ Studio thành danh sách gọn. Giấy phép lạ thì coi là cần ghi nguồn. */
export function parseStudioExport(source: unknown): AudioLibraryTrack[] {
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error('File xuất từ Studio không có bài nào.');
  }
  return collectTracks(source as (SourceRow & { license?: unknown })[], ({ license }) => license !== STUDIO_STANDARD_LICENSE);
}

/** Gộp lần xuất mới với danh sách đang dùng. Không xóa bài nào: bài không còn thấy được đánh dấu chưa xác nhận. */
export function mergeAudioLibraryTracks(current: AudioLibraryTrack[], fresh: AudioLibraryTrack[]): AudioLibraryTrack[] {
  const freshKeys = new Set(fresh.map(({ title, artist }) => getTrackKey(title, artist)));
  const missing = current.filter(({ title, artist }) => !freshKeys.has(getTrackKey(title, artist)));
  return [...fresh, ...missing.map((track) => ({ ...track, unconfirmed: true }))];
}

/** Đọc các dòng của library-additions.csv. Có dòng sai thì báo lỗi cả file, vì mỗi dòng sẽ cho bài đó qua thẳng. */
export function parseLibraryAdditions(rows: string[][]): AudioLibraryTrack[] {
  const [header = [], ...body] = rows;
  const missingColumns = ADDITION_COLUMNS.filter((column) => !header.includes(column));
  if (missingColumns.length > 0) {
    throw new Error(`File bổ sung thiếu cột: ${missingColumns.join(', ')}.`);
  }

  const problems: string[] = [];
  const entries = body.flatMap((row, position) => {
    if (row.every((cell) => !cell)) {
      return [];
    }
    const [title, artist, attribution, checkedBy, checkedOn] = ADDITION_COLUMNS.map((column) => row[header.indexOf(column)] ?? '');
    const flag = attribution.toLowerCase();
    const rowProblems = [
      !title || !artist ? 'thiếu tên bài hoặc nghệ sĩ' : '',
      flag !== 'true' && flag !== 'false' ? 'attribution phải là true hoặc false' : '',
      !checkedBy ? 'thiếu người kiểm tra' : '',
      !/^\d{4}-\d{2}-\d{2}$/.test(checkedOn) || Number.isNaN(Date.parse(checkedOn)) ? 'checkedOn phải có dạng YYYY-MM-DD' : '',
    ].filter(Boolean);
    if (rowProblems.length > 0) {
      problems.push(`Dòng ${position + 2}: ${rowProblems.join(', ')}.`);
      return [];
    }
    return [{ title, artist, attribution: flag === 'true' }];
  });

  if (problems.length > 0) {
    throw new Error(`File bổ sung có dòng sai:\n${problems.join('\n')}`);
  }
  return collectTracks(entries, ({ attribution }) => attribution);
}

/**
 * Áp file bổ sung lên danh sách, chạy lại nhiều lần vẫn cho cùng kết quả.
 * Bài thêm tay đã bị xóa khỏi file thì rời danh sách, để sửa được dòng thêm nhầm. Bài vốn "chưa xác nhận" cũng vậy:
 * bị chặn hẳn an toàn hơn là giữ lại một bài từng bị coi là thêm nhầm.
 */
export function applyLibraryAdditions(tracks: AudioLibraryTrack[], additions: AudioLibraryTrack[]): AudioLibraryTrack[] {
  const pending = new Map(additions.map((track) => [getTrackKey(track.title, track.artist), track]));
  const kept = tracks.flatMap((track) => {
    const key = getTrackKey(track.title, track.artist);
    const addition = pending.get(key);
    if (!addition) {
      return track.manual ? [] : [track];
    }
    pending.delete(key);
    const attribution = addition.attribution || (!track.manual && track.attribution);
    return [track.manual || track.unconfirmed ? { ...addition, attribution, manual: true } : { ...track, attribution }];
  });
  return [...kept, ...[...pending.values()].map((track) => ({ ...track, manual: true }))];
}

export function isAudioLibraryFile(value: unknown): value is AudioLibraryFile {
  const tracks = (value as AudioLibraryFile | null)?.tracks;
  return Array.isArray(tracks) && tracks.length > 0;
}
