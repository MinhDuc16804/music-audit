import { describe, expect, it } from 'vitest';
import {
  buildChannelGate,
  buildChannelSongsCsv,
  buildChannelVideosCsv,
  parseChannelInput,
  parseChannelOptions,
  parseProgress,
  pickToSend,
  worstCaseRequests,
} from './channelScan';
import type { ChannelOptions, ChannelVideo } from './channelScan';

const UC_ID = 'UCabcdefghijklmnopqrstuv';

function video(videoId: string, overrides: Partial<ChannelVideo> = {}): ChannelVideo {
  return { videoId, seconds: 120, group: 'co-nhac', hasAudio: true, scanned: false, requests: 10, clipRequests: 3, ...overrides };
}

const ALL: ChannelOptions = { filter: false, musicOnly: false, clips: 0, limit: 0 };
const MUSIC_ONLY: ChannelOptions = { ...ALL, filter: true, musicOnly: true };

describe('parseChannelInput', () => {
  it('nhận link @handle, link mã kênh và tên trần', () => {
    expect(parseChannelInput('https://www.youtube.com/@KenhA/videos')).toEqual({ url: 'https://www.youtube.com/@KenhA', key: '@kenha' });
    expect(parseChannelInput('@kenh.a')).toEqual({ url: 'https://www.youtube.com/@kenh.a', key: '@kenh.a' });
    expect(parseChannelInput(`youtube.com/channel/${UC_ID}/`)).toEqual({ url: `https://www.youtube.com/channel/${UC_ID}`, key: UC_ID });
    expect(parseChannelInput(UC_ID)?.key).toBe(UC_ID);
  });

  it('nhận handle có dấu tiếng Việt', () => {
    expect(parseChannelInput('https://www.youtube.com/@Qu%E1%BB%91cDuy')?.key).toBe('@quốcduy');
  });

  it('từ chối link video, trang khác và tên có thể thoát khỏi thư mục', () => {
    expect(parseChannelInput('https://www.youtube.com/watch?v=aaaaaaaaaaa')).toBeNull();
    expect(parseChannelInput('https://example.com/@kenh')).toBeNull();
    expect(parseChannelInput('@..')).toBeNull();
    expect(parseChannelInput('@a/../../b')).toBeNull();
    expect(parseChannelInput('https://www.youtube.com/@a%2F..%2Fb')).toBeNull();
    expect(parseChannelInput('')).toBeNull();
  });
});

describe('parseChannelOptions', () => {
  it('nhận tùy chọn hợp lệ', () => {
    expect(parseChannelOptions({ filter: true, musicOnly: true, clips: 8, limit: 20 })).toEqual({ filter: true, musicOnly: true, clips: 8, limit: 20 });
  });

  it('không cho chỉ gửi video có nhạc hay gửi đoạn ngắn khi không lọc', () => {
    expect(parseChannelOptions({ filter: false, musicOnly: true, clips: 0, limit: 0 })).toBeNull();
    expect(parseChannelOptions({ filter: false, musicOnly: false, clips: 8, limit: 0 })).toBeNull();
  });

  it('từ chối giá trị lạ', () => {
    expect(parseChannelOptions(null)).toBeNull();
    expect(parseChannelOptions({ filter: true, musicOnly: false, clips: 1, limit: 0 })).toBeNull();
    expect(parseChannelOptions({ filter: true, musicOnly: false, clips: 21, limit: 0 })).toBeNull();
    expect(parseChannelOptions({ filter: true, musicOnly: false, clips: 0, limit: -1 })).toBeNull();
  });
});

describe('parseProgress', () => {
  it('đọc dòng tiến độ', () => {
    expect(parseProgress('[3/40] Đang tải https://x')).toEqual({ done: 3, total: 40 });
    expect(parseProgress('Đã tải 3/40')).toBeNull();
  });
});

describe('pickToSend', () => {
  const videos = [video('a'), video('b', { group: 'khong-nhac' }), video('c', { scanned: true }), video('d', { hasAudio: false })];

  it('bỏ video đã quét và video chưa có file', () => {
    expect(pickToSend(videos, ALL).map(({ videoId }) => videoId)).toEqual(['a', 'b']);
  });

  it('chỉ gửi video có nhạc khi được chọn', () => {
    expect(pickToSend(videos, MUSIC_ONLY).map(({ videoId }) => videoId)).toEqual(['a']);
  });

  it('chỉ xét N video đầu', () => {
    expect(pickToSend(videos, { ...ALL, limit: 1 }).map(({ videoId }) => videoId)).toEqual(['a']);
  });
});

describe('chi phí', () => {
  const videos = [video('a'), video('b', { group: 'khong-nhac', clipRequests: 0 }), video('c', { scanned: true })];

  it('mức tối đa trước khi lọc không tính video đã quét', () => {
    expect(worstCaseRequests(videos, ALL, 3600)).toBe(20);
  });

  it('mức tối đa của đoạn ngắn theo độ dài video', () => {
    expect(worstCaseRequests([video('a', { seconds: 90 })], { ...MUSIC_ONLY, clips: 8 }, 3600)).toBe(2);
    expect(worstCaseRequests([video('a', { seconds: 3000 })], { ...MUSIC_ONLY, clips: 8 }, 3600)).toBe(8);
  });

  it('số chính xác sau khi lọc', () => {
    expect(buildChannelGate(videos, MUSIC_ONLY)).toEqual({ videos: 1, requests: 10, withMusic: 1, noMusic: 1, noAudio: 0 });
    expect(buildChannelGate(videos, { ...MUSIC_ONLY, clips: 8 }).requests).toBe(3);
  });
});

describe('CSV', () => {
  it('chặn công thức Excel trong tên bài', () => {
    const csv = buildChannelSongsCsv([{ title: '=HYPERLINK("x")', artist: 'A', label: '', library: 'chua-tra', videoCount: 1, seconds: 65 }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"Chưa tra"');
    expect(csv).toContain('"1:05"');
  });

  it('mỗi video một dòng', () => {
    const csv = buildChannelVideosCsv([
      { videoId: 'a', title: 'T', url: 'u', seconds: 0, group: 'can-nghe-lai', reason: 'r', detection: '', musicSeconds: '', policy: '', tracks: [] },
    ]);
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain('"Cần nghe lại"');
  });
});
