import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStateFile } from './stateFile.ts';

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'state-file-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('createStateFile', () => {
  it('chưa có file thì đọc ra null', async () => {
    expect(await createStateFile<number[]>(() => join(folder, 'khong-co.json'), 'thử').read()).toBeNull();
  });

  it('tạo thư mục, ghi rồi đọc lại đúng giá trị lúc gọi ghi', async () => {
    const path = join(folder, 'out', 'state.json');
    const state = createStateFile<number[]>(() => path, 'thử');
    const value = [1, 2];
    const written = state.write(value);
    value.push(3);
    await written;
    expect(await state.read()).toEqual([1, 2]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([1, 2]);
  });

  it('readSync đọc ngay giá trị đã ghi, chưa có file thì ra null', async () => {
    const state = createStateFile<number[]>(() => join(folder, 'dong-bo.json'), 'thử');
    expect(state.readSync()).toBeNull();
    await state.write([4, 5]);
    expect(state.readSync()).toEqual([4, 5]);
  });

  it('readSyncStrict: chưa có file là null, file hỏng thì báo lỗi', async () => {
    const path = join(folder, 'hong.json');
    const state = createStateFile<number[]>(() => path, 'thử');
    expect(state.readSyncStrict()).toBeNull();
    await writeFile(path, '{hỏng', 'utf8');
    expect(() => state.readSyncStrict()).toThrow();
  });

  it('các lần ghi đi lần lượt, lần sau cùng thắng', async () => {
    const state = createStateFile<string>(() => join(folder, 'state.json'), 'thử');
    void state.write('a');
    void state.write('b');
    await state.write('c');
    expect(await state.read()).toBe('c');
  });

  it('file hỏng thì đọc ra null và ghi log, không ném lỗi', async () => {
    const path = join(folder, 'state.json');
    await writeFile(path, '{hỏng', 'utf8');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await createStateFile(() => path, 'hàng đợi quét').read()).toBeNull();
    expect(log.mock.calls[0][0]).toContain('Không đọc được hàng đợi quét');
    log.mockRestore();
  });
});
