import { describe, expect, it } from 'vitest';
import { buildHistoryCsv, filterHistory, historyTitle, parseUsageLog } from './history';

const A = 'aaaaaaaaaaa';
const line = (row: Record<string, unknown>) => JSON.stringify({ time: '2026-11-10T01:00:00.000Z', user: 'nv@example.com', outcome: 'done', ...row });

describe('parseUsageLog', () => {
  const log = [
    line({ kind: 'link', target: `https://www.youtube.com/watch?v=${A}` }),
    line({ kind: 'file', target: 'clip.mp4', resultId: '0123456789a' }),
    line({ kind: 'file', target: 'cu.mp4' }),
    line({ kind: 'batch', target: `https://youtu.be/${A}`, outcome: 'error' }),
    line({ kind: 'channel', target: 'https://www.youtube.com/@kenh (20 video, 180 yêu cầu)' }),
    line({ kind: 'link', target: 'x', outcome: 'limited' }),
    'khong-phai-json',
    '',
  ].join('\n');
  const entries = parseUsageLog(log);

  it('mới nhất trước, bỏ dòng lỗi và lượt bị từ chối', () => {
    expect(entries.map(({ kind }) => kind)).toEqual(['channel', 'batch', 'file', 'file', 'link']);
  });

  it('tìm được mã kết quả của video và file', () => {
    expect(entries.find(({ kind }) => kind === 'link')?.resultKey).toBe(A);
    expect(entries.find(({ kind }) => kind === 'batch')?.resultKey).toBe(A);
    expect(entries.find(({ target }) => target === 'clip.mp4')?.resultKey).toBe('0123456789a');
    expect(entries.find(({ target }) => target === 'cu.mp4')?.resultKey).toBeUndefined();
  });

  it('đọc số video và yêu cầu của lần quét kênh', () => {
    expect(entries[0].channel).toEqual({ url: 'https://www.youtube.com/@kenh', videos: 20, requests: 180 });
  });

  it('không nhận mã kết quả có thể thoát khỏi thư mục', () => {
    expect(parseUsageLog(line({ kind: 'file', target: 'f', resultId: '../../.env' }))[0].resultKey).toBeUndefined();
  });

  it('thiếu người dùng thì ghi là không rõ', () => {
    expect(parseUsageLog(line({ kind: 'link', target: 'x', user: '' }))[0].user).toBe('khong-ro');
  });
});

describe('filterHistory', () => {
  const entries = parseUsageLog(
    [
      line({ kind: 'link', target: `https://www.youtube.com/watch?v=${A}`, user: 'a@x.vn' }),
      line({ kind: 'file', target: 'Máy cưa gỗ.mp4', user: 'b@x.vn' }),
    ].join('\n'),
  );

  it('lọc theo loại, người quét và tìm không cần gõ dấu', () => {
    expect(filterHistory(entries, { kind: 'file', query: '' })).toHaveLength(1);
    expect(filterHistory(entries, { kind: 'all', query: '', onlyUser: 'a@x.vn' })).toHaveLength(1);
    expect(filterHistory(entries, { kind: 'all', query: 'may cua' }).map(({ target }) => target)).toEqual(['Máy cưa gỗ.mp4']);
  });

  it('ưu tiên tên video khi có kết quả', () => {
    const [entry] = entries;
    expect(historyTitle(entry)).toBe(entry.target);
    expect(historyTitle({ ...entry, result: { url: '', video_id: A, status: 'done', note: '', title: 'Tên thật' } })).toBe('Tên thật');
  });
});

describe('buildHistoryCsv', () => {
  it('chặn công thức Excel', () => {
    const csv = buildHistoryCsv([{ time: 't', user: 'u', kind: 'k', title: '=CMD()', target: 'x', verdict: 'v', tracks: ['A', 'B'] }]);
    expect(csv).toContain(`"'=CMD()"`);
    expect(csv).toContain('"A; B"');
  });
});
