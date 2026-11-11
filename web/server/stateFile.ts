/**
 * Lưu trạng thái chạy nền vào một file JSON, để app khởi động lại vẫn biết việc đang dở.
 * Ghi qua file tạm rồi đổi tên, nên app dừng giữa lúc ghi cũng không làm hỏng file cũ. Các lần ghi đi lần lượt.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** label là tên nội dung để báo lỗi, như "hàng đợi quét". Lỗi đọc ghi chỉ được ghi ra log, không làm hỏng việc đang chạy. */
export function createStateFile<T>(getPath: () => string, label: string) {
  let writes: Promise<unknown> = Promise.resolve();

  return {
    /** Nội dung đã lưu, hoặc null nếu chưa có file hay file hỏng. */
    async read(): Promise<T | null> {
      const path = getPath();
      if (!existsSync(path)) {
        return null;
      }
      try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
      } catch (error) {
        console.error(`Không đọc được ${label}: ${errorText(error)}`);
        return null;
      }
    },

    /** Như read nhưng đọc ngay, cho bộ đếm cần biết số đã dùng trước khi trả lời yêu cầu. */
    readSync(): T | null {
      const path = getPath();
      if (!existsSync(path)) {
        return null;
      }
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
      } catch (error) {
        console.error(`Không đọc được ${label}: ${errorText(error)}`);
        return null;
      }
    },

    /** Như readSync nhưng file có mà hỏng hay không đọc được thì báo lỗi, để nơi gọi chặn thay vì coi như chưa có gì. */
    readSyncStrict(): T | null {
      const path = getPath();
      if (!existsSync(path)) {
        return null;
      }
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    },

    /** Chụp lại giá trị ngay lúc gọi rồi ghi sau các lần ghi trước. */
    write(value: T): Promise<unknown> {
      const snapshot = JSON.stringify(value);
      writes = writes
        .then(async () => {
          const path = getPath();
          await mkdir(dirname(path), { recursive: true });
          await writeFile(`${path}.tmp`, snapshot, 'utf8');
          await rename(`${path}.tmp`, path);
        })
        .catch((error: unknown) => {
          console.error(`Không lưu được ${label}: ${errorText(error)}`);
        });
      return writes;
    },
  };
}
