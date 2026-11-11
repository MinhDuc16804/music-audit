/** Chạy lệnh audit.py và công cụ audd trong tiến trình con, đọc kết quả JSON. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AuddCommandError } from './quota.ts';

/**
 * Lưới an toàn cho lệnh treo, phải dài hơn tổng thời gian chờ của chính lệnh Python: đọc độ dài trên YouTube (60 giây),
 * tách âm thanh (TIMEOUT_SECONDS trong extract.py) rồi chờ AudD (REQUEST_TIMEOUT_SECONDS trong audd.py).
 * Nếu Node dừng lệnh trong lúc AudD đang xử lý thì AudD vẫn tính phí mà kết quả chưa kịp lưu, lần sau phải trả lại lần nữa.
 * Để Python tự dừng trước và báo lỗi. Kiểm thử timeouts.test.ts đọc các hằng số bên Python để giữ đúng điều này.
 */
export const PROCESS_TIMEOUT_MS = 30 * 60_000;
const AUDD_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_LENGTH = 300;

function getPythonCommand(): string {
  const installed = join(process.env.LOCALAPPDATA ?? '', 'Python', 'bin', 'python.exe');
  return process.env.MUSIC_AUDIT_PYTHON ?? (existsSync(installed) ? installed : 'python');
}

export interface AuditRun {
  /** Thư mục data/ và out/ riêng, mặc định theo MUSIC_AUDIT_WORKDIR. */
  workdir?: string;
  /** Tiến trình dài như tải cả kênh thì không đặt giới hạn thời gian. */
  noTimeout?: boolean;
  onLine?: (line: string) => void;
}

/** Quét cả kênh luôn dùng AudD như các màn hình khác, kể cả khi .env có khóa ACRCloud. */
export const CHANNEL_ENV = { MUSIC_SERVICE: 'audd' };

export function startAudit(auditRoot: string, commandArgs: string[], run: AuditRun = {}, extraEnv: Record<string, string> = {}) {
  const workdir = run.workdir ?? process.env.MUSIC_AUDIT_WORKDIR;
  const args = ['audit.py', ...(workdir ? ['--workdir', workdir] : []), ...commandArgs];
  const child = spawn(getPythonCommand(), args, {
    cwd: auditRoot,
    windowsHide: true,
    timeout: run.noTimeout ? undefined : PROCESS_TIMEOUT_MS,
    env: { ...process.env, PYTHONUTF8: '1', ...extraEnv },
  });

  const done = new Promise<string>((resolveResult, reject) => {
    let output = '';
    let partial = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
      if (run.onLine) {
        const lines = `${partial}${chunk}`.split('\n');
        partial = lines.pop() ?? '';
        lines.forEach(run.onLine);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errorOutput += chunk));
    child.on('error', () => reject(new Error('Không chạy được Python. Hãy kiểm tra Python đã được cài.')));
    child.on('close', (code) => {
      if (code !== 0) {
        const lastLine = errorOutput.trim().split('\n').at(-1) ?? '';
        reject(new Error(lastLine.slice(0, MAX_MESSAGE_LENGTH) || 'Lệnh quét không chạy xong.'));
        return;
      }
      resolveResult(output);
    });
  });
  return { done, stop: () => child.kill() };
}

/** Không đưa nguyên văn lỗi của công cụ ra ngoài, chỉ phân loại để tab báo đúng việc cần làm. */
export function runAuddCommand(args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.env.AUDD_CLI ?? 'audd', args, {
      windowsHide: true,
      timeout: AUDD_TIMEOUT_MS,
      env: { ...process.env, CI: '1', AUDD_NO_UPDATE_CHECK: '1' },
    });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errorOutput += chunk));
    child.on('error', () => reject(new AuddCommandError('missing')));
    child.on('close', (code) => {
      if (code === 0) {
        resolveResult(output);
      } else {
        reject(new AuddCommandError(/log\s?in|sign.?in|unauthenticated/i.test(`${errorOutput}${output}`) ? 'login' : 'error'));
      }
    });
  });
}

export function parseAuditOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Không đọc được kết quả của lệnh quét.');
  }
}

export function runAudit(auditRoot: string, commandArgs: string[]): Promise<unknown> {
  return startAudit(auditRoot, commandArgs).done.then(parseAuditOutput);
}
