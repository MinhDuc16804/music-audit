/**
 * Phần chờ kết quả của màn hình quét một video. Server nhận yêu cầu rồi quét nền, trình duyệt hỏi lại định kỳ,
 * để không yêu cầu nào kéo dài quá giới hạn thời gian của Cloudflare.
 */

import type { IdentifyResult } from './videoCheck.ts';

export const SCAN_JOB_API = '/api/scan-jobs';
const POLL_INTERVAL_MS = 3000;
/** Số lần hỏi hỏng liên tiếp được bỏ qua, để mạng chập chờn không làm mất lần quét đang chạy. */
const MAX_MISSES = 5;

export type ScanJobView = { status: 'running' } | { status: 'done'; result: IdentifyResult } | { status: 'error'; error: string };

export interface ScanJobStarted {
  jobId: string;
}

export class ScanStoppedError extends Error {}

const defaultWait = (ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms));

/**
 * Hỏi cho tới khi lần quét xong. readJob trả về null khi tạm thời không hỏi được.
 * Người dùng bấm Dừng chờ thì ngừng hỏi, lần quét trên server vẫn chạy nốt và kết quả được lưu.
 */
export async function waitForScanJob(
  readJob: () => Promise<ScanJobView | null>,
  isCurrent: () => boolean,
  wait: (ms: number) => Promise<void> = defaultWait,
): Promise<IdentifyResult> {
  let misses = 0;
  for (;;) {
    if (!isCurrent()) {
      throw new ScanStoppedError();
    }
    const job = await readJob().catch(() => null);
    if (job?.status === 'done') {
      return job.result;
    }
    if (job?.status === 'error') {
      throw new Error(job.error);
    }
    misses = job ? 0 : misses + 1;
    if (misses > MAX_MISSES) {
      throw new Error('Mất kết nối với máy chủ. Lần quét có thể vẫn đang chạy, hãy xem tab Lịch sử quét sau ít phút.');
    }
    await wait(POLL_INTERVAL_MS);
  }
}

/** Server nhận yêu cầu rồi quét nền, nên hỏi lại định kỳ cho tới khi có kết quả. */
async function readIdentifyResponse(response: Response, isCurrent: () => boolean): Promise<IdentifyResult> {
  const payload: unknown = await response.json().catch(() => null);
  const jobId = (payload as Partial<ScanJobStarted> | null)?.jobId;
  if (!response.ok || !jobId) {
    const message = (payload as { error?: string } | null)?.error;
    throw new Error(message ?? 'Không gọi được phần quét. Hãy chạy app bằng npm.cmd run dev.');
  }
  return waitForScanJob(async () => {
    const jobResponse = await fetch(`${SCAN_JOB_API}/${jobId}`);
    return jobResponse.ok ? ((await jobResponse.json()) as ScanJobView) : null;
  }, isCurrent);
}

/** Gọi quét một video. Không bật rescan thì video đã quét chỉ lấy lại kết quả cũ, không gửi AudD. */
export async function requestIdentify(url: string, isCurrent: () => boolean, rescan = false): Promise<IdentifyResult> {
  const response = await fetch('/api/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rescan ? { url, rescan: true } : { url }),
  });
  return readIdentifyResponse(response, isCurrent);
}

export async function requestIdentifyFile(file: File, isCurrent: () => boolean, rescan = false): Promise<IdentifyResult> {
  const response = await fetch('/api/identify-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), ...(rescan ? { 'X-Rescan': '1' } : {}) },
    body: file,
  });
  return readIdentifyResponse(response, isCurrent);
}
