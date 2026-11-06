import { describe, expect, it } from 'vitest';
import { analyzeMusic, buildCatalogIndex, findCatalogEntry } from './analyzer';
import type { UseCase } from './analyzer';
import { importCatalogRows, parseCsv } from './catalogImport.ts';

const TODAY = '2026-11-06';
const HEADER = 'title,artist,status,license_type,allowed_use,expires_on,source,verified_by,attribution';
const importText = (...lines: string[]) => importCatalogRows(parseCsv([HEADER, ...lines].join('\n')), TODAY);
const LICENSED_ROW = 'Bai Hop Dong,Ca Si A,LICENSED,HD 123,youtube|film,2027-12-31,HD 123,Duc,';

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

describe('importCatalogRows', () => {
  it('nhận dòng hợp lệ và đổi allowed_use', () => {
    const { entries, errors } = importText(LICENSED_ROW);
    expect(errors).toEqual([]);
    expect(entries[0].allowedUses).toEqual(['youtube_monetized', 'corporate_film']);
    expect(entries[0].sourceNote).toContain('Duc');
  });

  it('báo thiếu cột bắt buộc', () => {
    const { errors } = importCatalogRows(parseCsv('title,artist\nA,B'), TODAY);
    expect(errors[0].line).toBe(1);
    expect(errors[0].message).toContain('status');
  });

  it('từ chối dòng SAFE không có nguồn hoặc người xác nhận', () => {
    expect(importText('A,B,SAFE,Public Domain,,,,Duc,').errors[0].message).toContain('source');
    expect(importText('A,B,SAFE,Public Domain,,,Link,,').errors[0].message).toContain('verified_by');
  });

  it('từ chối status lạ, ngày sai và thừa cột, kèm đúng số dòng', () => {
    expect(importText('A,B,OK,X,,,Link,Duc,').errors[0].line).toBe(2);
    expect(importText('A,B,SAFE,X,,31/12/2027,Link,Duc,').errors[0].message).toContain('YYYY-MM-DD');
    expect(importText('A,B,SAFE,X,,2027-02-30,Link,Duc,').errors.length).toBe(1);
    expect(importText('A,B,SAFE,X,,,Link,Duc,,thua').errors[0].message).toContain('Thừa cột');
  });

  it('LICENSED bắt buộc có allowed_use hợp lệ', () => {
    expect(importText('A,B,LICENSED,HD,,,Link,Duc,').errors.length).toBe(1);
    expect(importText('A,B,LICENSED,HD,tv,,Link,Duc,').errors[0].message).toContain('allowed_use');
  });

  it('phát hiện trùng bài dù khác dấu và tên phụ', () => {
    const { errors } = importText('Lạc Trôi,Sơn Tùng,SAFE,X,,,Link,Duc,', 'Khac|LAC TROI,Son Tung,SAFE,X,,,Link,Duc,');
    expect(errors[0].line).toBe(3);
    expect(errors[0].message).toContain('dòng 2');
  });

  it('từ chối ký tự lỗi mã hóa', () => {
    expect(importText('L�c,B,SAFE,X,,,Link,Duc,').errors[0].message).toContain('UTF-8');
  });

  it('bỏ qua dòng trống và cảnh báo giấy phép hết hạn', () => {
    const { entries, errors, warnings } = importText('', 'A,B,LICENSED,HD,all,2020-01-01,Link,Duc,');
    expect(errors).toEqual([]);
    expect(entries.length).toBe(1);
    expect(warnings[0].line).toBe(3);
  });
});

describe('analyzeMusic với dữ liệu nhập', () => {
  const index = buildCatalogIndex(importText(LICENSED_ROW).entries);
  const analyze = (useCase: UseCase, today = TODAY) =>
    analyzeMusic({ title: 'Bài Hợp Đồng', artist: 'Ca Sĩ A', useCase, today }, index);

  it('cho nhãn đã có giấy phép khi đúng mục đích', () => {
    const result = analyze('youtube_monetized');
    expect(result.status).toBe('LICENSED');
    expect(result.matchKind).toBe('catalog');
  });

  it('chặn mục đích ngoài giấy phép', () => {
    const result = analyze('paid_ads');
    expect(result.status).toBe('RESTRICTED');
    expect(result.matchKind).toBe('use_not_allowed');
  });

  it('chặn khi giấy phép hết hạn, nhưng vẫn dùng được trong ngày hết hạn', () => {
    expect(analyze('youtube_monetized', '2027-12-31').status).toBe('LICENSED');
    const result = analyze('youtube_monetized', '2028-01-01');
    expect(result.status).toBe('RESTRICTED');
    expect(result.matchKind).toBe('expired');
  });

  it('tên có chữ live vẫn khớp nếu đúng tên đã ghi, còn bản remix thì không', () => {
    const live = buildCatalogIndex(importText('Live Forever,Ca Si A,LICENSED,HD,all,,Link,Duc,').entries);
    const check = (title: string) => analyzeMusic({ title, artist: 'Ca Si A', useCase: 'paid_ads', today: TODAY }, live);
    expect(check('Live Forever').status).toBe('LICENSED');
    expect(check('Live Forever (Remix)').matchKind).toBe('derivative');
  });

  it('tra được bài cuối cùng trong 5.000 bài', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `Bai ${i},Ca si ${i},SAFE,X,,,Link,Duc,`);
    const { entries, errors } = importText(...lines);
    expect(errors).toEqual([]);
    expect(findCatalogEntry('Bai 4999', 'Ca si 4999', buildCatalogIndex(entries))?.status).toBe('SAFE');
  });
});
