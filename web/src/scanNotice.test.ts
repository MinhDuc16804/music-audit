import { describe, expect, it } from 'vitest';
import type { Batch, BatchItem } from './batchScan.ts';
import type { ChannelScanView } from './channelScan.ts';
import { describeBatchChange, describeChannelChange } from './scanNotice.ts';

const item = (status: BatchItem['status']): BatchItem => ({ videoId: 'v', url: 'u', status, cached: false });
const batch = (status: Batch['status'], items: BatchItem[] = [], pauseReason?: string): Batch => ({
  id: 'lo-1',
  user: 'a',
  createdAt: '2026-11-10T00:00:00Z',
  status,
  items,
  ...(pauseReason ? { pauseReason } : {}),
});

describe('describeBatchChange', () => {
  it('báo khi lô vừa chạy xong, kèm số video có kết quả và lỗi', () => {
    const notice = describeBatchChange({ id: 'lo-1', status: 'running' }, batch('done', [item('done'), item('done'), item('error'), item('cancelled')]));
    expect(notice).toEqual({ title: 'Đã quét xong lô 3 video', body: '2 video có kết quả, 1 video lỗi. Mở app để xem kết luận.', tabLabel: '(Xong)' });
  });

  it('báo khi lô tạm dừng, kèm lý do', () => {
    expect(describeBatchChange({ id: 'lo-1', status: 'running' }, batch('paused', [], 'YouTube đang chặn'))?.body).toBe('YouTube đang chặn');
  });

  it('không báo khi mới mở tab, lô vẫn chạy, hay là lô khác', () => {
    expect(describeBatchChange(null, batch('done'))).toBeNull();
    expect(describeBatchChange({ id: 'lo-1', status: 'running' }, batch('running'))).toBeNull();
    expect(describeBatchChange({ id: 'lo-1', status: 'done' }, batch('done'))).toBeNull();
    expect(describeBatchChange({ id: 'lo-khac', status: 'running' }, batch('done'))).toBeNull();
  });
});

const scan = (overrides: Partial<ChannelScanView>): ChannelScanView => ({
  id: 'quet-1',
  user: 'a',
  channelUrl: 'https://www.youtube.com/@kenh',
  channelKey: '@kenh',
  channelTitle: 'Kênh mẫu',
  createdAt: '2026-11-10T00:00:00Z',
  status: 'done',
  maxSeconds: 3600,
  totalVideos: 10,
  totalSeconds: 600,
  progress: { done: 0, total: 0 },
  failed: 0,
  stoppedEarly: false,
  ...overrides,
});

describe('describeChannelChange', () => {
  it('báo khi chờ xác nhận chi phí, kèm số yêu cầu', () => {
    const notice = describeChannelChange(
      { id: 'quet-1', status: 'filtering' },
      scan({ status: 'awaiting', gate: { videos: 4, requests: 1200, withMusic: 4, noMusic: 6, noAudio: 0 } }),
    );
    expect(notice?.title).toBe('Quét kênh đang chờ bạn xác nhận chi phí');
    expect(notice?.body).toBe('Kênh mẫu. Sẽ gửi 4 video, khoảng 1.200 yêu cầu AudD. Chưa có yêu cầu AudD nào được gửi.');
    expect(notice?.tabLabel).toBe('(Chờ xác nhận)');
  });

  it('báo khi quét xong hoặc dừng sớm', () => {
    expect(describeChannelChange({ id: 'quet-1', status: 'identifying' }, scan({ failed: 2 }))?.body).toBe('Kênh mẫu, 2 video lỗi. Mở app để xem báo cáo.');
    expect(describeChannelChange({ id: 'quet-1', status: 'identifying' }, scan({ stoppedEarly: true }))?.title).toBe('Đã dừng quét kênh');
  });

  it('báo khi tạm dừng vì lỗi', () => {
    expect(describeChannelChange({ id: 'quet-1', status: 'identifying' }, scan({ status: 'paused', pauseReason: 'AudD báo lỗi tài khoản.' }))?.body).toBe(
      'Kênh mẫu. AudD báo lỗi tài khoản.',
    );
  });

  it('không báo khi chuyển giữa các bước đang chạy, khi mới mở tab, hay khi người dùng tự bấm', () => {
    expect(describeChannelChange({ id: 'quet-1', status: 'downloading' }, scan({ status: 'filtering' }))).toBeNull();
    expect(describeChannelChange(null, scan({}))).toBeNull();
    expect(describeChannelChange({ id: 'quet-1', status: 'awaiting' }, scan({}))).toBeNull();
    expect(describeChannelChange({ id: 'quet-khac', status: 'identifying' }, scan({}))).toBeNull();
  });
});
