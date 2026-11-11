/**
 * Danh sách bài của YouTube Audio Library và cách tra cứu.
 *
 * YouTube không có API cho thư viện này, nên danh sách được xuất từ YouTube Studio rồi gộp với danh sách cộng đồng.
 * Khớp chắc: cùng tên bài, kể cả phần trong ngoặc, và có một tên nghệ sĩ trùng nhau. AudD có khi ghi tác giả
 * ở nghệ sĩ và tên trong thư viện ở album, nên album cũng được so.
 * Gần khớp: chỉ trùng tên bài, bỏ qua phần trong ngoặc. Có thể là bài khác cùng tên, nên phải có người duyệt.
 */

import { foldText, normalizeText, normalizeTitle } from './textNormalize.ts';

/** Các loại 0 đến 2 không cần ghi nguồn, từ 3 trở lên là Creative Commons. */
const MAX_NO_ATTRIBUTION_LICENSE_TYPE = 2;

/** Giấy phép tiêu chuẩn của thư viện trong file xuất từ Studio, không cần ghi nguồn. */
const STUDIO_STANDARD_LICENSE = 'yt-audio-library';

/** Tên ngắn phải có ít nhất từng này từ mới được coi là cách viết khác của tên dài. */
const MIN_PARTIAL_NAME_WORDS = 2;
/** Tên dài hơn tối đa từng này từ, ví dụ thêm tên đệm. */
const MAX_EXTRA_NAME_WORDS = 1;

/** YouTube thêm bài mới hai lần mỗi tháng, nên danh sách quá từng này ngày thì coi là cũ. */
const LIBRARY_STALE_AFTER_DAYS = 30;

/** Các cột bắt buộc của library-additions.csv. */
/** Mỗi bài thêm tay phải có hai người khác nhau cùng kiểm tra trong Studio, vì dòng thêm vào sẽ cho bài đó qua thẳng. */
const ADDITION_COLUMNS = ['title', 'artist', 'attribution', 'checkedBy', 'secondCheckedBy', 'checkedOn'];

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

/**
 * Dịch vụ nhận diện gộp nghệ sĩ vào một chuỗi, nên thử cả chuỗi đầy đủ lẫn từng tên.
 * Danh sách thư viện chỉ tách theo dấu phẩy và gạch chéo: "&" và "and" thường là một phần tên nhóm, như "Density & Time".
 * Tách theo "&" sẽ ra tên một từ như "Time", dễ trùng một nghệ sĩ thương mại.
 */
export function getArtistCandidates(artists: string, isLibrary = false): string[] {
  const separator = isLibrary ? /,|\// : /,|&|\/|\band\b|\bfeat\.?\s|\bft\.?\s/i;
  return [...new Set([artists, ...artists.split(separator)].map((name) => name.trim()))].filter(Boolean);
}

/** Bỏ chữ "The" ở đầu tên nhóm, như "The U.S. Army Band". */
function nameWords(name: string): string[] {
  const words = normalizeText(name).split(' ').filter(Boolean);
  return words[0] === 'the' && words.length > 1 ? words.slice(1) : words;
}

/**
 * Cùng tên, hoặc tên dài chỉ thêm đúng một từ đệm ở giữa, như "Patrick Patrikios" và "Patrick Jordan Patrikios".
 * Từ đầu và từ cuối phải trùng, để "Kevin MacLeod" không khớp "Kevin MacLeod Tribute Orchestra".
 */
export function isSameArtistName(first: string, second: string): boolean {
  const [shorter, longer] = [first, second].map(nameWords).sort((a, b) => a.length - b.length);
  if (shorter.length === 0) {
    return false;
  }
  if (shorter.length === longer.length) {
    return shorter.join(' ') === longer.join(' ');
  }
  return (
    shorter.length >= MIN_PARTIAL_NAME_WORDS &&
    longer.length - shorter.length <= MAX_EXTRA_NAME_WORDS &&
    shorter[0] === longer[0] &&
    shorter.at(-1) === longer.at(-1) &&
    isInOrder(shorter, longer)
  );
}

/** Các từ của tên ngắn nằm trong tên dài theo đúng thứ tự. */
function isInOrder(shorter: string[], longer: string[]): boolean {
  let position = 0;
  return shorter.every((word) => {
    position = longer.indexOf(word, position) + 1;
    return position > 0;
  });
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
/**
 * Khớp chắc khi trùng tên bài và trùng nghệ sĩ. Album chỉ được tính khi trùng hẳn tên nghệ sĩ trong thư viện
 * (AudD đôi khi ghi tác giả ở ô nghệ sĩ và tên kênh phát hành ở ô album), không tính album chỉ chứa tên đó như "Best of …".
 */
export function findAudioLibraryTrack(title: string, artists: string, index: AudioLibraryIndex, album = ''): AudioLibraryTrack | undefined {
  const names = getArtistCandidates(artists);
  const albumName = nameWords(album).join(' ');
  return index.byTitle.get(normalizeText(title))?.find((track) =>
    getArtistCandidates(track.artist, true).some(
      (libraryName) => names.some((name) => isSameArtistName(libraryName, name)) || (albumName !== '' && nameWords(libraryName).join(' ') === albumName),
    ),
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
    const [title, artist, attribution, checkedBy, secondCheckedBy, checkedOn] = ADDITION_COLUMNS.map((column) => row[header.indexOf(column)] ?? '');
    const flag = attribution.toLowerCase();
    const samePerson = foldText(checkedBy).replace(/\s+/g, ' ').trim() === foldText(secondCheckedBy).replace(/\s+/g, ' ').trim();
    const rowProblems = [
      !title || !artist ? 'thiếu tên bài hoặc nghệ sĩ' : '',
      flag !== 'true' && flag !== 'false' ? 'attribution phải là true hoặc false' : '',
      !checkedBy || !secondCheckedBy ? 'thiếu người kiểm tra, cần đủ hai người' : '',
      checkedBy && secondCheckedBy && samePerson ? 'hai người kiểm tra phải là hai người khác nhau' : '',
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

/** Cho người duyệt biết danh sách mới hay cũ. Không đọc được ngày thì coi là cũ. */
export function describeLibrary(file: Pick<AudioLibraryFile, 'sourceUpdatedOn' | 'tracks'>, today: Date): { label: string; isStale: boolean } {
  const count = `${file.tracks.length.toLocaleString('vi-VN')} bài`;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(file.sourceUpdatedOn ?? '');
  const updated = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
  if (!match || Number.isNaN(updated)) {
    return { label: `Thư viện chưa rõ ngày cập nhật · ${count}`, isStale: true };
  }
  const days = Math.floor((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - updated) / 86_400_000);
  const isStale = days > LIBRARY_STALE_AFTER_DAYS;
  return { label: `Thư viện cập nhật ${match[3]}/${match[2]}/${match[1]} · ${isStale ? `đã ${days} ngày, cần cập nhật` : count}`, isStale };
}

export function isAudioLibraryFile(value: unknown): value is AudioLibraryFile {
  const tracks = (value as AudioLibraryFile | null)?.tracks;
  return Array.isArray(tracks) && tracks.length > 0;
}
