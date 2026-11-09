import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('đọc BOM, dấu chấm phẩy và xuống dòng Windows', () => {
    expect(parseCsv('﻿a;b\r\n1;2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('đọc ô có dấu phẩy, ngoặc kép và xuống dòng', () => {
    expect(parseCsv('a,b\n"x, y","nói ""hi""\nz"')).toEqual([
      ['a', 'b'],
      ['x, y', 'nói "hi"\nz'],
    ]);
  });
});
