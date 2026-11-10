/**
 * Báo khi lô hoặc kênh quét xong, tạm dừng, hoặc đang chờ xác nhận chi phí.
 * Phần này chỉ quyết định có báo hay không và báo câu gì, để kiểm thử được. Phần hiện thông báo nằm ở NotifySwitch.tsx.
 */

import type { Batch } from './batchScan.ts';
import type { ChannelScanView, ChannelStatus } from './channelScan.ts';

export interface ScanNotice {
  title: string;
  body: string;
  /** Chữ thêm vào đầu tiêu đề tab, như "(Xong)". */
  tabLabel: string;
}

/** Trạng thái lần trước app thấy, để chỉ báo khi trạng thái vừa đổi chứ không báo lại mỗi lần mở tab. */
export interface SeenStatus<Status> {
  id: string;
  status: Status;
}

const number = (value: number) => value.toLocaleString('vi-VN');
const RUNNING_CHANNEL: ChannelStatus[] = ['downloading', 'filtering', 'identifying'];

export function describeBatchChange(previous: SeenStatus<Batch['status']> | null, batch: Batch | null): ScanNotice | null {
  if (!previous || !batch || previous.id !== batch.id || previous.status !== 'running' || batch.status === 'running') {
    return null;
  }
  if (batch.status === 'paused') {
    return { title: 'Lô quét đang tạm dừng', body: batch.pauseReason ?? 'Mở app để xem lý do và bấm Chạy tiếp.', tabLabel: '(Tạm dừng)' };
  }
  const done = batch.items.filter(({ status }) => status === 'done').length;
  const failed = batch.items.filter(({ status }) => status === 'error').length;
  const total = batch.items.filter(({ status }) => status !== 'cancelled').length;
  return {
    title: `Đã quét xong lô ${number(total)} video`,
    body: `${number(done)} video có kết quả${failed ? `, ${number(failed)} video lỗi` : ''}. Mở app để xem kết luận.`,
    tabLabel: '(Xong)',
  };
}

export function describeChannelChange(previous: SeenStatus<ChannelStatus> | null, scan: ChannelScanView | null): ScanNotice | null {
  if (!previous || !scan || previous.id !== scan.id || !RUNNING_CHANNEL.includes(previous.status) || previous.status === scan.status) {
    return null;
  }
  const name = scan.channelTitle || scan.channelUrl;
  if (scan.status === 'awaiting') {
    const cost = scan.gate ? `Sẽ gửi ${number(scan.gate.videos)} video, khoảng ${number(scan.gate.requests)} yêu cầu AudD.` : '';
    return { title: 'Quét kênh đang chờ bạn xác nhận chi phí', body: `${name}. ${cost} Chưa có yêu cầu AudD nào được gửi.`.replace(/\s+/g, ' ').trim(), tabLabel: '(Chờ xác nhận)' };
  }
  if (scan.status === 'paused') {
    return { title: 'Quét kênh đang tạm dừng', body: `${name}. ${scan.pauseReason ?? 'Mở app để xem lý do.'}`, tabLabel: '(Tạm dừng)' };
  }
  if (scan.status === 'done') {
    return {
      title: scan.stoppedEarly ? 'Đã dừng quét kênh' : 'Đã quét xong kênh',
      body: `${name}${scan.failed ? `, ${number(scan.failed)} video lỗi` : ''}. Mở app để xem báo cáo.`,
      tabLabel: '(Xong)',
    };
  }
  return null;
}
