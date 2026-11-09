import { describe, expect, it } from 'vitest';
import { isSameOriginJson, isSameOriginUpload, parseUploadName } from '../server/identifyPlugin.ts';
import { buildAudioLibraryIndex } from './audioLibrary';
import { getScanCoverage, getVideoVerdict, hasSteadyTimecodes, needsStudioLookup, parseTimecode } from './videoCheck';
import type { IdentifyResult, VideoTrack } from './videoCheck';
import { getVideoUrl, parseYoutubeVideoId } from './youtubeLink';

const VIDEO_ID = 'dQw4w9WgXcQ';

const index = buildAudioLibraryIndex([
  { title: 'Bai Thu Vien', artist: 'Ca Si A', attribution: false },
  { title: 'Bai Ghi Nguon', artist: 'Ca Si B', attribution: true },
  { title: 'Bai Chua Xac Nhan', artist: 'Ca Si C', attribution: false, unconfirmed: true },
]);

const scan = (decision: string, tracks: VideoTrack[] = [], status: IdentifyResult['status'] = 'done'): IdentifyResult => ({
  url: 'u',
  video_id: VIDEO_ID,
  status,
  decision,
  note: 'ghi chú từ máy',
  tracks,
  duration_seconds: Math.max(tracks.length, 1) * 12,
  max_seconds: 3600,
});
const verdict = (result: IdentifyResult) => getVideoVerdict(result, index);

describe('parseYoutubeVideoId', () => {
  it('nhận các dạng link của một video', () => {
    const links = [
      `https://www.youtube.com/watch?v=${VIDEO_ID}&t=42s`,
      `http://m.youtube.com/watch?feature=share&v=${VIDEO_ID}`,
      `https://music.youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtu.be/${VIDEO_ID}?si=abc`,
      `https://www.youtube.com/shorts/${VIDEO_ID}`,
      `https://www.youtube.com/live/${VIDEO_ID}`,
      `  youtube.com/watch?v=${VIDEO_ID}  `,
    ];
    links.forEach((link) => expect(parseYoutubeVideoId(link)).toBe(VIDEO_ID));
  });

  it('link trong playlist chỉ giữ lại video', () => {
    const link = `https://www.youtube.com/watch?v=${VIDEO_ID}&list=PL123&index=2`;
    expect(getVideoUrl(parseYoutubeVideoId(link))).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  });

  it('từ chối mọi link khác', () => {
    const links = [
      '',
      'khong-phai-link',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/@kenh-a',
      'https://www.youtube.com/channel/UC1234567890123456789012',
      'https://www.youtube.com/embed/videoseries?list=PL123',
      'https://www.youtube.com/watch?v=ngan',
      `https://evil.example/youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtube.com.evil.example/watch?v=${VIDEO_ID}`,
      `ftp://youtube.com/watch?v=${VIDEO_ID}`,
    ];
    links.forEach((link) => expect(parseYoutubeVideoId(link)).toBe(''));
  });
});

describe('getVideoVerdict', () => {
  it('được dùng khi mọi bài đều có trong thư viện', () => {
    const result = verdict(scan('block', [{ title: 'Bai Thu Vien', artists: 'Ca Si X, Ca Si A' }]));
    expect(result.kind).toBe('allowed');
    expect(result.detail).toContain('bỏ sót');
    expect(result.detail).not.toContain('ghi nguồn');
  });

  it('nhắc ghi nguồn khi có bài Creative Commons', () => {
    const result = verdict(scan('block', [{ title: 'Bai Ghi Nguon', artists: 'Ca Si B' }]));
    expect(result.kind).toBe('allowed');
    expect(result.detail).toContain('ghi nguồn');
  });

  it('có bài chưa xác nhận lại thì chuyển người duyệt, không cho qua', () => {
    const tracks = [
      { title: 'Bai Thu Vien', artists: 'Ca Si A' },
      { title: 'Bai Chua Xac Nhan', artists: 'Ca Si C' },
    ];
    const result = verdict(scan('block', tracks));
    expect(result.kind).toBe('review');
    expect(result.detail).toContain('Studio');
  });

  it('bài ngoài thư viện vẫn chặn dù có bài chưa xác nhận lại', () => {
    const tracks = [
      { title: 'Bai Chua Xac Nhan', artists: 'Ca Si C' },
      { title: 'Bai La', artists: 'Ca Si Z' },
    ];
    expect(verdict(scan('block', tracks)).kind).toBe('blocked');
  });

  it('một bài ngoài thư viện là chặn cả video', () => {
    const tracks = [
      { title: 'Bai Thu Vien', artists: 'Ca Si A' },
      { title: 'Bai La', artists: 'Ca Si Z' },
    ];
    const result = verdict(scan('block', tracks));
    expect(result.kind).toBe('blocked');
    expect(result.tracks.map(({ libraryTrack }) => Boolean(libraryTrack))).toEqual([true, false]);
  });

  it('bản remix của bài trong thư viện chỉ gần khớp, phải có người duyệt', () => {
    expect(verdict(scan('block', [{ title: 'Bai Thu Vien (Remix)', artists: 'Ca Si A' }])).kind).toBe('review');
  });

  it('trùng tên bài nhưng khác nghệ sĩ thì phải có người duyệt, không cho qua', () => {
    const result = verdict(scan('block', [{ title: 'Bai Thu Vien', artists: 'Ca Si Z' }]));
    expect(result.kind).toBe('review');
    expect(result.detail).toContain('gần khớp');
    expect(result.tracks[0].libraryTrack).toBeUndefined();
    expect(result.tracks[0].nearTrack?.artist).toBe('Ca Si A');
  });

  it('khớp theo album thì được dùng', () => {
    expect(verdict(scan('block', [{ title: 'Bai Thu Vien', artists: 'Tac Gia', album: 'Ca Si A' }])).kind).toBe('allowed');
  });

  it('bài gần khớp đi cùng bài không trùng tên vẫn bị chặn', () => {
    const tracks = [
      { title: 'Bai Thu Vien', artists: 'Ca Si Z' },
      { title: 'Bai La', artists: 'Ca Si Z' },
    ];
    expect(verdict(scan('block', tracks)).kind).toBe('blocked');
  });

  it('không nhận ra bài thì cần người duyệt, không tự cho qua', () => {
    expect(verdict(scan('hold')).kind).toBe('review');
    expect(verdict(scan('pass_no_music')).kind).toBe('review');
    expect(verdict(scan('block')).kind).toBe('review');
  });

  it('quyết định lạ vẫn đi theo danh sách thư viện', () => {
    expect(verdict(scan('gi_do_moi', [{ title: 'Bai La', artists: 'Ca Si Z' }])).kind).toBe('blocked');
  });

  it('lỗi quét hoặc chưa quét xong là chưa có kết luận, kể cả có bài trong thư viện', () => {
    const tracks = [{ title: 'Bai Thu Vien', artists: 'Ca Si A' }];
    expect(verdict(scan('error')).kind).toBe('error');
    expect(verdict(scan('block', tracks, 'error')).kind).toBe('error');
    expect(verdict(scan('block', tracks, 'processing')).kind).toBe('error');
  });
});

describe('getVideoVerdict theo bằng chứng', () => {
  const library = { title: 'Bai Thu Vien', artists: 'Ca Si A' };
  const outside = { title: 'Bai La', artists: 'Ca Si Z' };
  const another = { title: 'Bai Khac', artists: 'Ca Si Y' };
  const near = { title: 'Bai Thu Vien', artists: 'Ca Si Z' };
  const toTimecode = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  /** Mỗi đoạn liệt kê vị trí bài ứng viên. Bài trong noisy có vị trí nhảy lung tung, bài khác tiến đều. */
  const segmented = (tracks: VideoTrack[], candidates: number[][], noisy: number[] = []): IdentifyResult => ({
    ...scan('block', tracks),
    segments: candidates.map((positions, order) => ({
      offset: toTimecode(order * 12),
      tracks: positions,
      timecodes: positions.map((position) => toTimecode(noisy.includes(position) ? 300 - order * 40 : 30 + order * 12)),
    })),
    duration_seconds: candidates.length * 12,
  });

  it('video lời nói bị AudD nhận nhầm thì chuyển người duyệt, không chặn', () => {
    const result = verdict(segmented([outside, another], [[0, 1], [0, 1]], [0, 1]));
    expect(result.kind).toBe('review');
    expect(result.detail).toContain('nhận nhầm');
    expect(result.tracks.every(({ isDoubtful }) => isDoubtful)).toBe(true);
  });

  it('bài ngoài thư viện có bằng chứng thì chặn', () => {
    expect(verdict(segmented([outside], [[0], [0]])).kind).toBe('blocked');
  });

  it('bài ngoài thư viện có bằng chứng vẫn chặn dù đi cùng bài trong thư viện', () => {
    expect(verdict(segmented([library, outside], [[0, 1], [0, 1]])).kind).toBe('blocked');
  });

  it('bỏ qua bài không có bằng chứng nằm cùng đoạn với bài thư viện có bằng chứng', () => {
    const result = verdict(segmented([library, outside], [[0], [0, 1], [0]]));
    expect(result.kind).toBe('allowed');
    expect(result.tracks[1].isIgnored).toBe(true);
  });

  it('bài không có bằng chứng ở đoạn riêng thì chuyển người duyệt', () => {
    const result = verdict(segmented([library, outside], [[0], [0], [1]]));
    expect(result.kind).toBe('review');
    expect(result.tracks[1].isDoubtful).toBe(true);
  });

  it('bài thư viện không có bằng chứng thì không bỏ qua được bài khác', () => {
    expect(verdict(segmented([library, outside], [[0, 1]])).kind).toBe('review');
  });

  it('không có vị trí trong bài thì không có bằng chứng', () => {
    const result: IdentifyResult = {
      ...scan('block', [outside]),
      segments: [{ offset: '00:00', tracks: [0] }, { offset: '00:12', tracks: [0] }],
    };
    expect(verdict(result).kind).toBe('review');
  });

  it('gần khớp đi cùng bài có bằng chứng ngoài thư viện thì chặn', () => {
    expect(verdict(segmented([near, outside], [[0, 1], [0, 1]])).kind).toBe('blocked');
  });

  it('mọi đoạn đều là bài trong thư viện thì được dùng', () => {
    expect(verdict(segmented([library], [[0], [0]])).kind).toBe('allowed');
  });

  it('bỏ qua bài nhận nhầm không làm bài chưa đủ độ phủ được cho qua', () => {
    const result = { ...segmented([library, outside], [[0], [0, 1], [0]]), duration_seconds: 600 };
    expect(verdict(result).kind).toBe('review');
  });
});

describe('parseTimecode', () => {
  it('đọc mm:ss và h:mm:ss', () => {
    expect(parseTimecode('01:47')).toBe(107);
    expect(parseTimecode('1:02:03')).toBe(3723);
  });

  it('giá trị lạ là không đọc được', () => {
    for (const value of [undefined, '', 'abc', '12']) {
      expect(parseTimecode(value)).toBeUndefined();
    }
  });
});

describe('hasSteadyTimecodes', () => {
  const segmentsOf = (timecodes: string[]) =>
    timecodes.map((timecode, order) => ({ offset: `00:${String(order * 12).padStart(2, '0')}`, tracks: [0], timecodes: [timecode] }));

  it('vị trí tiến đều là có bằng chứng, lệch 2 giây vẫn được', () => {
    expect(hasSteadyTimecodes(0, segmentsOf(['00:11', '00:23']))).toBe(true);
    expect(hasSteadyTimecodes(0, segmentsOf(['00:11', '00:25']))).toBe(true);
  });

  it('dữ liệu thật của video lời nói không có bằng chứng', () => {
    expect(hasSteadyTimecodes(0, segmentsOf(['01:47', '00:17']))).toBe(false);
    expect(hasSteadyTimecodes(0, segmentsOf(['00:09', '00:17']))).toBe(false);
  });

  it('một lần khớp không đủ làm bằng chứng', () => {
    expect(hasSteadyTimecodes(0, segmentsOf(['00:11']))).toBe(false);
  });

  it('hai lần khớp cách nhau vẫn tính nếu vị trí tiến đều', () => {
    const segments = [
      { offset: '00:00', tracks: [0], timecodes: ['00:11'] },
      { offset: '00:36', tracks: [0], timecodes: ['00:47'] },
    ];
    expect(hasSteadyTimecodes(0, segments)).toBe(true);
  });
});

describe('getVideoVerdict theo độ phủ', () => {
  const tracks = [{ title: 'Bai Thu Vien', artists: 'Ca Si A' }];
  const withDuration = (duration_seconds: number | undefined, segmentCount = 1): IdentifyResult => ({
    ...scan('block', tracks),
    segments: Array.from({ length: segmentCount }, (_, order) => ({ offset: String(order), tracks: [0] })),
    duration_seconds,
  });

  it('chưa biết độ dài thì không cho qua', () => {
    for (const duration of [undefined, 0]) {
      const result = verdict(withDuration(duration));
      expect(result.kind).toBe('review');
      expect(result.detail).toContain('Chưa biết độ dài');
    }
  });

  it('nhận ra quá ít thời lượng thì không cho qua', () => {
    const result = verdict(withDuration(600, 5));
    expect(result.kind).toBe('review');
    expect(result.detail).toContain('10%');
  });

  it('nội dung dài hơn giới hạn quét thì không cho qua', () => {
    const result = verdict({ ...withDuration(4000, 300), max_seconds: 3600 });
    expect(result.kind).toBe('review');
    expect(result.detail).toContain('giới hạn quét');
  });

  it('độ phủ thấp không làm bài ngoài thư viện thoát chặn', () => {
    const result = getVideoVerdict({ ...scan('block', [{ title: 'Bai La', artists: 'Ca Si Z' }]), duration_seconds: 600 }, index);
    expect(result.kind).toBe('blocked');
  });
});

describe('getScanCoverage', () => {
  it('đủ từ 80% thời lượng', () => {
    expect(getScanCoverage(8, 120, 3600)).toEqual({ kind: 'enough' });
    expect(getScanCoverage(7, 120, 3600)).toEqual({ kind: 'low', percent: 70 });
  });

  it('đoạn cuối ngắn hơn 12 giây vẫn tính đủ', () => {
    expect(getScanCoverage(1, 8, 3600)).toEqual({ kind: 'enough' });
  });

  it('thiếu độ dài là chưa biết', () => {
    expect(getScanCoverage(5)).toEqual({ kind: 'unknown' });
  });

  it('dài hơn giới hạn là chưa quét hết', () => {
    expect(getScanCoverage(300, 3601, 3600)).toEqual({ kind: 'cut_off' });
  });
});

describe('parseUploadName', () => {
  it('nhận file âm thanh và video, giữ tên tiếng Việt', () => {
    expect(parseUploadName(encodeURIComponent('Bài dựng.MP4'))).toBe('Bài dựng.MP4');
  });

  it('bỏ mọi đường dẫn trong tên', () => {
    expect(parseUploadName(encodeURIComponent('../../etc/bai.mp3'))).toBe('bai.mp3');
    expect(parseUploadName(encodeURIComponent('..\\..\\windows\\bai.wav'))).toBe('bai.wav');
  });

  it('từ chối loại file khác và tên hỏng', () => {
    expect(parseUploadName(encodeURIComponent('virus.exe'))).toBe('');
    expect(parseUploadName(undefined)).toBe('');
    expect(parseUploadName('%E0%A4%A')).toBe('');
  });
});

describe('isSameOriginUpload', () => {
  it('chỉ nhận file gửi từ chính app', () => {
    expect(isSameOriginUpload('application/octet-stream', 'http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(isSameOriginUpload('application/octet-stream', 'https://evil.example', 'localhost:5173')).toBe(false);
    expect(isSameOriginUpload('multipart/form-data', 'http://localhost:5173', 'localhost:5173')).toBe(false);
  });
});

describe('isSameOriginJson', () => {
  it('nhận yêu cầu JSON từ chính app', () => {
    expect(isSameOriginJson('application/json', 'http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(isSameOriginJson('application/json', undefined, 'localhost:5173')).toBe(true);
  });

  it('từ chối trang khác và kiểu nội dung khác', () => {
    expect(isSameOriginJson('application/json', 'https://evil.example', 'localhost:5173')).toBe(false);
    expect(isSameOriginJson('text/plain', 'http://localhost:5173', 'localhost:5173')).toBe(false);
    expect(isSameOriginJson(undefined, undefined, 'localhost:5173')).toBe(false);
    expect(isSameOriginJson('application/json', 'khong-hop-le', 'localhost:5173')).toBe(false);
  });
});

describe('needsStudioLookup', () => {
  const libraryTrack = { title: 'Bai', artist: 'Ca Si', attribution: false };

  it('bài khớp chắc thì không cần tra', () => {
    expect(needsStudioLookup({ libraryTrack })).toBe(false);
  });

  it('bài ngoài danh sách và bài chưa xác nhận lại thì cần tra', () => {
    expect(needsStudioLookup({})).toBe(true);
    expect(needsStudioLookup({ libraryTrack: { ...libraryTrack, unconfirmed: true } })).toBe(true);
  });

  it('bài đã bỏ qua vì có thể nhận nhầm thì không cần tra', () => {
    expect(needsStudioLookup({ isIgnored: true })).toBe(false);
  });
});
