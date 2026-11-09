import { describe, expect, it } from 'vitest';
import { buildBatchCsv, estimateAuddRequests, formatDuration, isValidVideoId, parseBatchLinks } from './batchScan';

describe('parseBatchLinks', () => {
  it('giữ thứ tự, bỏ link trùng và đếm dòng sai', () => {
    const text = [
      'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      '',
      'https://youtu.be/bbbbbbbbbbb',
      'https://youtu.be/aaaaaaaaaaa',
      'không phải link',
      'https://www.youtube.com/@kenh',
    ].join('\n');
    expect(parseBatchLinks(text)).toEqual({ videoIds: ['aaaaaaaaaaa', 'bbbbbbbbbbb'], invalid: 2, duplicates: 1 });
  });

  it('đọc được xuống dòng kiểu Windows', () => {
    expect(parseBatchLinks('https://youtu.be/aaaaaaaaaaa\r\nhttps://youtu.be/bbbbbbbbbbb\r\n').videoIds).toHaveLength(2);
  });
});

describe('estimateAuddRequests', () => {
  it('làm tròn lên theo đoạn 12 giây', () => {
    expect(estimateAuddRequests(600)).toBe(50);
    expect(estimateAuddRequests(601)).toBe(51);
  });

  it('không vượt giới hạn quét', () => {
    expect(estimateAuddRequests(7200)).toBe(300);
    expect(estimateAuddRequests(7200, 1200)).toBe(100);
  });

  it('chưa biết độ dài thì tính mức tối đa', () => {
    expect(estimateAuddRequests(0)).toBe(300);
  });
});

describe('isValidVideoId', () => {
  it('chỉ nhận mã video 11 ký tự', () => {
    expect(isValidVideoId('aaaaaaaaaaa')).toBe(true);
    expect(isValidVideoId('videoseries')).toBe(false);
    expect(isValidVideoId('../../etc/x')).toBe(false);
    expect(isValidVideoId(42)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('hiện giờ khi cần', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});

describe('buildBatchCsv', () => {
  it('bọc ô có dấu phẩy và ngoặc kép', () => {
    const csv = buildBatchCsv([{ url: 'u', verdict: 'Được dùng', detail: 'a, "b"', durationSeconds: 65, tracks: ['X', 'Y'] }]);
    expect(csv.split('\r\n')[1]).toBe('"u","Được dùng","a, ""b""","1:05","X; Y"');
  });

  it('vô hiệu ô bắt đầu bằng công thức', () => {
    const csv = buildBatchCsv([{ url: 'u', verdict: 'v', detail: '=HYPERLINK("x")', durationSeconds: 0, tracks: [] }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
