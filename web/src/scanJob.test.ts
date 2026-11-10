import { describe, expect, it } from 'vitest';
import { ScanStoppedError, waitForScanJob } from './scanJob.ts';
import type { ScanJobView } from './scanJob.ts';
import type { IdentifyResult } from './videoCheck.ts';

const RESULT: IdentifyResult = { url: 'u', video_id: 'v', status: 'done', note: '' };
const noWait = () => Promise.resolve();

function reader(answers: (ScanJobView | null | Error)[]) {
  let calls = 0;
  const read = () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return Object.assign(read, { getCalls: () => calls });
}

describe('waitForScanJob', () => {
  it('hỏi lại cho tới khi quét xong', async () => {
    const read = reader([{ status: 'running' }, { status: 'running' }, { status: 'done', result: RESULT }]);
    await expect(waitForScanJob(read, () => true, noWait)).resolves.toBe(RESULT);
    expect(read.getCalls()).toBe(3);
  });

  it('quét lỗi thì báo đúng câu của server', async () => {
    const read = reader([{ status: 'error', error: 'YouTube đang chặn' }]);
    await expect(waitForScanJob(read, () => true, noWait)).rejects.toThrow('YouTube đang chặn');
  });

  it('bỏ qua vài lần hỏi hỏng rồi vẫn lấy được kết quả', async () => {
    const read = reader([null, new Error('mạng'), { status: 'done', result: RESULT }]);
    await expect(waitForScanJob(read, () => true, noWait)).resolves.toBe(RESULT);
  });

  it('hỏi hỏng liên tiếp quá nhiều thì dừng', async () => {
    const read = reader([null]);
    await expect(waitForScanJob(read, () => true, noWait)).rejects.toThrow('Mất kết nối');
    expect(read.getCalls()).toBe(6);
  });

  it('lần hỏi được thì đếm lại số lần hỏng', async () => {
    const read = reader([null, null, null, null, null, { status: 'running' }, null, null, null, null, null, { status: 'done', result: RESULT }]);
    await expect(waitForScanJob(read, () => true, noWait)).resolves.toBe(RESULT);
  });

  it('người dùng dừng chờ thì ngừng hỏi', async () => {
    let isCurrent = true;
    const read = reader([{ status: 'running' }]);
    const stopAfterFirst = () => {
      isCurrent = false;
      return Promise.resolve();
    };
    await expect(waitForScanJob(read, () => isCurrent, stopAfterFirst)).rejects.toBeInstanceOf(ScanStoppedError);
    expect(read.getCalls()).toBe(1);
  });
});
