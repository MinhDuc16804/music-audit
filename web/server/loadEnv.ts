/**
 * Nạp file .env của music-audit vào biến môi trường của Node khi chạy ngoài Docker (npm run dev, preview, start).
 * Python tự đọc .env nên vẫn có khóa AudD; nếu Node không đọc thì ngân sách tháng, danh sách kênh và Access đều tắt mà vẫn gửi AudD thật.
 * Trong Docker, compose.yml đã đưa .env vào qua env_file và image không có file .env, nên hàm này không làm gì.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Thư mục music-audit chứa .env, audit.py và out/. */
export function getAuditRoot(env: Record<string, string | undefined> = process.env): string {
  return env.MUSIC_AUDIT_ROOT ?? resolve(import.meta.dirname, '..', '..');
}

/**
 * Đọc file .env và đặt các biến chưa có. Không ghi đè biến đã đặt sẵn, để biến của Docker hay của người chạy luôn thắng.
 * Trả về tên các biến đã nạp, không bao giờ trả giá trị vì có khóa.
 */
export function loadAuditEnv(path: string, env: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const values = parseEnv(readFileSync(path, 'utf8'));
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (env[name] === undefined) {
      env[name] = value;
      loaded.push(name);
    }
  }
  return loaded;
}
