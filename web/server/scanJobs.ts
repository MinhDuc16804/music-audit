/**
 * Các lần quét một video đang chạy nền. Server trả lời ngay khi nhận yêu cầu rồi trình duyệt hỏi lại kết quả,
 * vì Cloudflare cắt yêu cầu chờ quá khoảng 100 giây trong khi một lần quét có thể mất nhiều phút.
 * Chỉ giữ trong bộ nhớ: app khởi động lại thì mất, nhưng kết quả AudD đã lưu nên quét lại không tốn thêm.
 */

import { randomUUID } from 'node:crypto';
import type { ScanJobView } from '../src/scanJob.ts';
import type { IdentifyResult } from '../src/videoCheck.ts';

export const JOB_ROUTE = '/api/scan-jobs';
/** Giữ kết quả từng này lâu sau khi quét xong, đủ để tab đang chờ lấy về. */
const DEFAULT_KEEP_MS = 60 * 60_000;
const JOB_ID = /^[0-9a-f-]{36}$/;

interface ScanJob {
  user: string;
  view: ScanJobView;
  finishedAt?: number;
}

/** Lấy mã lần quét từ đường dẫn /api/scan-jobs/<mã>, không hợp lệ thì trả về chuỗi rỗng. */
export function parseJobId(pathname: string): string {
  const id = pathname.startsWith(`${JOB_ROUTE}/`) ? pathname.slice(JOB_ROUTE.length + 1) : '';
  return JOB_ID.test(id) ? id : '';
}

export function createScanJobs(keepMs: number = DEFAULT_KEEP_MS, getNow: () => number = Date.now) {
  const jobs = new Map<string, ScanJob>();

  const prune = () => {
    const now = getNow();
    for (const [id, job] of jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt > keepMs) {
        jobs.delete(id);
      }
    }
  };

  return {
    /** Chạy việc quét ở nền và trả về mã để hỏi kết quả. Lỗi của việc quét được giữ lại, không ném ra ngoài. */
    start(user: string, work: () => Promise<IdentifyResult>): string {
      prune();
      const id = randomUUID();
      const job: ScanJob = { user, view: { status: 'running' } };
      jobs.set(id, job);
      void Promise.resolve()
        .then(work)
        .then(
          (result) => {
            job.view = { status: 'done', result };
          },
          (error: unknown) => {
            job.view = { status: 'error', error: error instanceof Error ? error.message : 'Lỗi không xác định' };
          },
        )
        .then(() => {
          job.finishedAt = getNow();
        });
      return id;
    },

    /** Chỉ người đã gửi mới hỏi được kết quả. Không thấy thì trả về null. */
    get(user: string, id: string): ScanJobView | null {
      prune();
      const job = jobs.get(id);
      return job && job.user === user ? job.view : null;
    },
  };
}
