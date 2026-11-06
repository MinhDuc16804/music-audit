/**
 * Kết luận cho một video từ kết quả lệnh identify và dữ liệu giấy phép của đội.
 *
 * Nguyên tắc: khớp thì tin, không khớp thì chưa biết. Video chỉ có giấy phép khi mọi bài nhận ra đều có
 * giấy phép cho đúng mục đích. Không nhận ra bài hay không thấy nhạc đều không phải là an toàn.
 */

import { analyzeMusic } from './analyzer';
import type { AnalysisResult, CatalogIndex, UseCase } from './analyzer';

export type VideoVerdictKind = 'cleared' | 'needs_license' | 'unknown' | 'no_music' | 'error';

export interface VideoTrack {
  title: string;
  artists: string;
  label?: string;
  score?: number;
  played_duration?: number;
}

export interface IdentifyResult {
  url: string;
  video_id: string;
  status: 'done' | 'processing' | 'error';
  decision?: string;
  note: string;
  scan_note?: string;
  tracks?: VideoTrack[];
}

export interface CheckedTrack {
  track: VideoTrack;
  analysis: AnalysisResult;
}

export interface VideoVerdict {
  kind: VideoVerdictKind;
  title: string;
  detail: string;
  tracks: CheckedTrack[];
}

/** Dịch vụ nhận diện gộp nghệ sĩ vào một chuỗi, nên thử cả chuỗi đầy đủ lẫn từng tên. */
function getArtistCandidates(artists: string): string[] {
  return [...new Set([artists, ...artists.split(/,|&|\bfeat\.?\s|\bft\.?\s/i)].map((name) => name.trim()))];
}

export function checkTrack(track: VideoTrack, useCase: UseCase, catalogIndex: CatalogIndex, today: string): CheckedTrack {
  const results = getArtistCandidates(track.artists).map((artist) =>
    analyzeMusic({ title: track.title, artist, useCase, today }, catalogIndex),
  );
  const analysis =
    results.find((result) => result.status === 'LICENSED') ??
    results.find((result) => result.matchKind !== 'unverified') ??
    results[0];
  return { track, analysis };
}

export function getVideoVerdict(
  result: IdentifyResult,
  useCase: UseCase,
  catalogIndex: CatalogIndex,
  today: string = new Date().toISOString().slice(0, 10),
): VideoVerdict {
  const tracks = (result.tracks ?? []).map((track) => checkTrack(track, useCase, catalogIndex, today));

  if (result.status === 'error' || result.decision === 'error') {
    return { kind: 'error', title: 'Chưa có kết luận', detail: result.note, tracks };
  }
  if (result.decision === 'block') {
    if (tracks.length > 0 && tracks.every(({ analysis }) => analysis.status === 'LICENSED')) {
      return {
        kind: 'cleared',
        title: 'Mọi bài nhận ra đều có giấy phép',
        detail: 'Giấy phép đúng với mục đích đã chọn. Máy có thể bỏ sót nhạc khác trong video, nên vẫn cần người kiểm tra.',
        tracks,
      };
    }
    return { kind: 'needs_license', title: 'Có nhạc cần giấy phép', detail: result.note, tracks };
  }
  if (result.decision === 'pass_no_music') {
    return { kind: 'no_music', title: 'Máy không thấy nhạc', detail: result.note, tracks };
  }
  return { kind: 'unknown', title: 'Chưa biết, cần hỏi nguồn nhạc', detail: result.note, tracks };
}
