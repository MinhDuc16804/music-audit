/**
 * Kết luận cho một file hoặc video từ kết quả nhận diện của AudD và danh sách YouTube Audio Library.
 *
 * AudD trả từng đoạn 12 giây, mỗi đoạn có thể có nhiều bài ứng viên, và có thể nhận nhầm cả lời nói thành bài hát.
 * Bài có bằng chứng là bài có vị trí trong bài tiến đều theo video qua ít nhất hai đoạn.
 * Bài ngoài thư viện có bằng chứng thì chặn. Không có bằng chứng thì không chặn nhưng vẫn chuyển cho người duyệt, kể cả khi
 * mọi đoạn của nó đều có bài trong thư viện có bằng chứng (nhiều khả năng nhận nhầm): khớp thì tin, không khớp thì chưa biết.
 * Được dùng khi mọi bài đều khớp chắc và AudD nhận ra đủ phần lớn thời lượng. Kết luận luôn ghi tỷ lệ AudD nhận ra.
 */

import { findAudioLibraryTrack, findNearAudioLibraryTrack } from './audioLibrary.ts';
import type { AudioLibraryIndex, AudioLibraryTrack } from './audioLibrary.ts';

/** Độ dài một đoạn quét của AudD, xem CHUNK_SECONDS trong music_audit/audd.py. */
export const SCAN_SEGMENT_SECONDS = 12;
/** Hai đoạn cách nhau không quá từng này giây thì coi là một khoảng phát liền. */
const RANGE_GAP_SECONDS = 1;
/** Tỷ lệ thời lượng tối thiểu AudD phải nhận ra thì mới được kết luận Được dùng. */
const MIN_COVERAGE = 0.8;
/** Độ lệch cho phép khi so vị trí trong bài với thời gian trong video. */
const TIMECODE_TOLERANCE_SECONDS = 2;

export type VideoVerdictKind = 'allowed' | 'blocked' | 'review' | 'error';

export interface VideoTrack {
  title: string;
  artists: string;
  label?: string;
  album?: string;
  score?: number;
  played_duration?: number;
  isrc?: string;
  composers?: string;
}

export interface ScanSegment {
  offset: string;
  /** Vị trí các bài ứng viên trong tracks. */
  tracks: number[];
  /** Vị trí khớp trong từng bài ứng viên, dạng mm:ss. */
  timecodes?: string[];
}

export type ScanCoverage =
  | { kind: 'enough'; percent: number }
  | { kind: 'unknown' }
  | { kind: 'cut_off' }
  | { kind: 'low'; percent: number };

export interface IdentifyResult {
  url: string;
  video_id: string;
  status: 'done' | 'processing' | 'error';
  decision?: string;
  note: string;
  scan_note?: string;
  tracks?: VideoTrack[];
  segments?: ScanSegment[];
  /** Độ dài nội dung. Bằng 0 hoặc thiếu nghĩa là chưa biết. */
  duration_seconds?: number;
  /** Thời lượng tối đa được quét. */
  max_seconds?: number;
  /** Kết quả lấy lại từ lần quét trước, không gửi gì cho AudD. */
  cached?: boolean;
  /** Thời điểm AudD quét, dạng ISO. */
  scanned_at?: string;
}

/** Một khoảng bài phát trong video, tính bằng giây. */
export interface TrackRange {
  start: number;
  end: number;
}

export interface CheckedTrack {
  track: VideoTrack;
  /** Các khoảng trong video mà AudD thấy bài này, để người duyệt nghe lại đúng chỗ. */
  ranges?: TrackRange[];
  /** Bài tương ứng trong thư viện, không có nghĩa là không nằm trong thư viện. */
  libraryTrack?: AudioLibraryTrack;
  /** Bài trùng tên trong thư viện khi không khớp chắc. */
  nearTrack?: AudioLibraryTrack;
  /** Có vị trí trong bài tiến đều theo video, nên nhiều khả năng bài này phát thật. */
  hasEvidence?: boolean;
  /** Bài ngoài thư viện không có bằng chứng, cần người nghe lại. */
  isDoubtful?: boolean;
  /** Bài ngoài thư viện không có bằng chứng, chỉ xuất hiện cùng bài trong thư viện có bằng chứng: nhiều khả năng nhận nhầm, nhưng người duyệt vẫn phải nghe lại. */
  isIgnored?: boolean;
}

export interface VideoVerdict {
  kind: VideoVerdictKind;
  title: string;
  detail: string;
  tracks: CheckedTrack[];
}

/** So thời lượng AudD nhận ra với độ dài nội dung. Không biết độ dài thì không coi là đủ. */
export function getScanCoverage(segmentCount: number, durationSeconds = 0, maxSeconds = 0): ScanCoverage {
  if (durationSeconds <= 0) {
    return { kind: 'unknown' };
  }
  if (maxSeconds > 0 && durationSeconds > maxSeconds) {
    return { kind: 'cut_off' };
  }
  const coverage = Math.min(1, (segmentCount * SCAN_SEGMENT_SECONDS) / durationSeconds);
  const percent = Math.round(coverage * 100);
  return coverage >= MIN_COVERAGE ? { kind: 'enough', percent } : { kind: 'low', percent };
}

/** Đổi mm:ss hoặc h:mm:ss thành số giây. Không đọc được thì trả về undefined. */
export function parseTimecode(value = ''): number | undefined {
  if (!/^\d+(:\d+)+$/.test(value.trim())) {
    return undefined;
  }
  return value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** Bài có bằng chứng khi có hai lần khớp liên tiếp mà vị trí trong bài tiến đúng bằng thời gian trong video. */
export function hasSteadyTimecodes(position: number, segments: ScanSegment[]): boolean {
  const hits = segments.flatMap((segment) => {
    const candidate = segment.tracks.indexOf(position);
    const videoSeconds = parseTimecode(segment.offset);
    const trackSeconds = parseTimecode(segment.timecodes?.[candidate]);
    return candidate < 0 || videoSeconds === undefined || trackSeconds === undefined ? [] : [{ videoSeconds, trackSeconds }];
  });
  return hits.slice(1).some((hit, order) => {
    const previous = hits[order];
    const drift = hit.trackSeconds - previous.trackSeconds - (hit.videoSeconds - previous.videoSeconds);
    return Math.abs(drift) <= TIMECODE_TOLERANCE_SECONDS;
  });
}

/** Gộp các đoạn quét liền nhau có bài này thành từng khoảng phát trong video. Đoạn không đọc được vị trí thì bỏ qua. */
export function getTrackRanges(position: number, segments: ScanSegment[]): TrackRange[] {
  const starts = segments
    .flatMap((segment) => {
      const start = parseTimecode(segment.offset);
      return segment.tracks.includes(position) && start !== undefined ? [start] : [];
    })
    .sort((first, second) => first - second);
  const ranges: TrackRange[] = [];
  for (const start of starts) {
    const last = ranges.at(-1);
    if (last && start <= last.end + RANGE_GAP_SECONDS) {
      last.end = Math.max(last.end, start + SCAN_SEGMENT_SECONDS);
    } else {
      ranges.push({ start, end: start + SCAN_SEGMENT_SECONDS });
    }
  }
  return ranges;
}

function getCoverageDetail(coverage: ScanCoverage): string {
  if (coverage.kind === 'low') {
    return `AudD chỉ nhận ra khoảng ${coverage.percent}% thời lượng. Phần còn lại có thể là lời nói hoặc nhạc khác, hãy nghe kiểm tra.`;
  }
  if (coverage.kind === 'cut_off') {
    return 'Nội dung dài hơn giới hạn quét, phần sau chưa được kiểm tra. Hãy nghe kiểm tra phần đó.';
  }
  return 'Chưa biết độ dài nội dung nên không xác định được AudD đã nhận ra bao nhiêu phần. Hãy nghe kiểm tra.';
}

/** Bài chưa khớp chắc thì cần tra trong Studio, kể cả bài nhiều khả năng là nhận nhầm. */
export function needsStudioLookup({ libraryTrack }: Pick<CheckedTrack, 'libraryTrack'>): boolean {
  return !libraryTrack || Boolean(libraryTrack.unconfirmed);
}

/** Tên bài kèm nghệ sĩ để ghi trong câu kết luận. */
function trackNames(tracks: CheckedTrack[]): string {
  return tracks.map(({ track }) => `“${track.title}”${track.artists ? ` (${track.artists})` : ''}`).join(', ');
}

export function getVideoVerdict(result: IdentifyResult, libraryIndex: AudioLibraryIndex): VideoVerdict {
  // Thiếu thông tin từng đoạn thì coi mỗi bài là một đoạn riêng có bằng chứng, nên bài ngoài thư viện vẫn bị chặn.
  const scanSegments = result.segments ?? (result.tracks ?? []).map((_, position) => ({ offset: '', tracks: [position] }));
  const tracks = (result.tracks ?? []).map((track, position): CheckedTrack => {
    const libraryTrack = findAudioLibraryTrack(track.title, track.artists, libraryIndex, track.album);
    const nearTrack = libraryTrack ? undefined : findNearAudioLibraryTrack(track.title, libraryIndex);
    return {
      track,
      libraryTrack,
      nearTrack,
      hasEvidence: !result.segments || hasSteadyTimecodes(position, scanSegments),
      ranges: result.segments ? getTrackRanges(position, result.segments) : [],
    };
  });
  const isOutside = ({ libraryTrack, nearTrack }: CheckedTrack) => !libraryTrack && !nearTrack;
  const segments = scanSegments.map((segment) => segment.tracks.flatMap((position) => tracks[position] ?? []));

  tracks.forEach((checked) => {
    if (isOutside(checked) && !checked.hasEvidence) {
      const ownSegments = segments.filter((segment) => segment.includes(checked));
      checked.isIgnored = ownSegments.every((segment) => segment.some(({ libraryTrack, hasEvidence }) => libraryTrack && hasEvidence));
      checked.isDoubtful = !checked.isIgnored;
    }
  });

  if (result.status !== 'done' || result.decision === 'error') {
    return { kind: 'error', title: 'Chưa có kết luận', detail: result.note, tracks };
  }
  if (tracks.length === 0) {
    return {
      kind: 'review',
      title: 'Cần người duyệt',
      detail: 'AudD không nhận ra bài nào. Có thể không có nhạc, là nhạc tự sáng tác, hoặc là bài AudD chưa biết. Hãy hỏi nguồn nhạc.',
      tracks,
    };
  }
  if (tracks.some((checked) => isOutside(checked) && checked.hasEvidence)) {
    return {
      kind: 'blocked',
      title: 'Không được dùng',
      detail: 'Có bài không nằm trong YouTube Audio Library.',
      tracks,
    };
  }
  if (tracks.some(({ nearTrack }) => nearTrack)) {
    return {
      kind: 'review',
      title: 'Cần người duyệt',
      detail: 'Có bài gần khớp: trùng tên với bài trong thư viện nhưng khác nghệ sĩ hoặc khác phiên bản. Hãy nghe đối chiếu trong YouTube Studio.',
      tracks,
    };
  }
  if (tracks.some(({ isDoubtful }) => isDoubtful)) {
    return {
      kind: 'review',
      title: 'Cần người duyệt',
      detail: 'AudD đưa ra bài ngoài thư viện nhưng không đủ bằng chứng, có thể là nhận nhầm, kể cả nhận nhầm lời nói. Hãy nghe lại.',
      tracks,
    };
  }
  const ignored = tracks.filter(({ isIgnored }) => isIgnored);
  if (ignored.length > 0) {
    return {
      kind: 'review',
      title: 'Cần người duyệt',
      detail: `AudD còn đưa ra ${ignored.length} bài ngoài thư viện ở cùng đoạn với bài trong thư viện: ${trackNames(ignored)}. Nhiều khả năng là nhận nhầm, nhưng hãy nghe lại đúng các đoạn đó trước khi dùng.`,
      tracks,
    };
  }
  if (tracks.some(({ libraryTrack }) => libraryTrack?.unconfirmed)) {
    return {
      kind: 'review',
      title: 'Cần người duyệt',
      detail: 'Có bài chưa xác nhận lại: có trong danh sách cũ nhưng không thấy ở lần xuất mới nhất từ YouTube Studio. Hãy tra tên bài trong Studio.',
      tracks,
    };
  }
  const coverage = getScanCoverage(segments.length, result.duration_seconds, result.max_seconds);
  if (coverage.kind !== 'enough') {
    return { kind: 'review', title: 'Cần người duyệt', detail: getCoverageDetail(coverage), tracks };
  }
  const needsAttribution = tracks.some(({ libraryTrack }) => libraryTrack?.attribution);
  return {
    kind: 'allowed',
    title: 'Được dùng',
    detail: `AudD nhận ra khoảng ${coverage.percent}% thời lượng, mọi bài nhận ra đều có trong YouTube Audio Library. ${
      needsAttribution ? 'Có bài phải ghi nguồn trong mô tả video. ' : ''
    }Máy có thể bỏ sót nhạc nhỏ hoặc lẫn dưới lời nói${coverage.percent < 100 ? ' và ở phần chưa nhận ra' : ''}.`,
    tracks,
  };
}
