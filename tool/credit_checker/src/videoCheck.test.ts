import { describe, expect, it } from 'vitest';
import { isSameOriginJson, isSameOriginUpload, parseUploadName } from '../server/identifyPlugin.ts';
import { buildCatalogIndex } from './analyzer';
import { importCatalogRows, parseCsv } from './catalogImport.ts';
import { getVideoVerdict } from './videoCheck';
import type { IdentifyResult, VideoTrack } from './videoCheck';
import { getVideoUrl, parseYoutubeVideoId } from './youtubeLink';

const TODAY = '2026-11-06';
const VIDEO_ID = 'dQw4w9WgXcQ';
const HEADER = 'title,artist,status,license_type,allowed_use,expires_on,source,verified_by,attribution';

const index = buildCatalogIndex(
  importCatalogRows(
    parseCsv(
      [
        HEADER,
        'Bai Phep,Ca Si A,LICENSED,HD 1,all,2030-01-01,HD 1,Duc,',
        'Bai Youtube,Ca Si B,LICENSED,HD 2,youtube,2030-01-01,HD 2,Duc,',
        'Bai Het Han,Ca Si C,LICENSED,HD 3,all,2020-01-01,HD 3,Duc,',
        'Fur Elise,Beethoven,SAFE,Public Domain,,,Link,Duc,',
      ].join('\n'),
    ),
    TODAY,
  ).entries,
);

const scan = (decision: string, tracks: VideoTrack[] = [], status: IdentifyResult['status'] = 'done'): IdentifyResult => ({
  url: 'u',
  video_id: VIDEO_ID,
  status,
  decision,
  note: 'ghi chú từ máy',
  tracks,
});
const verdict = (result: IdentifyResult, useCase: 'youtube_monetized' | 'paid_ads' = 'youtube_monetized') =>
  getVideoVerdict(result, useCase, index, TODAY);

describe('parseYoutubeVideoId', () => {
  it('nhận các dạng link của một video', () => {
    const links = [
      `https://www.youtube.com/watch?v=${VIDEO_ID}&t=42s`,
      `http://m.youtube.com/watch?feature=share&v=${VIDEO_ID}`,
      `https://music.youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtu.be/${VIDEO_ID}?si=abc`,
      `https://www.youtube.com/shorts/${VIDEO_ID}`,
      `https://www.youtube.com/live/${VIDEO_ID}`,
      `  youtube.com/watch?v=${VIDEO_ID}  `,
    ];
    links.forEach((link) => expect(parseYoutubeVideoId(link)).toBe(VIDEO_ID));
  });

  it('link trong playlist chỉ giữ lại video', () => {
    const link = `https://www.youtube.com/watch?v=${VIDEO_ID}&list=PL123&index=2`;
    expect(getVideoUrl(parseYoutubeVideoId(link))).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  });

  it('từ chối mọi link khác', () => {
    const links = [
      '',
      'khong-phai-link',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/@kenh-a',
      'https://www.youtube.com/channel/UC1234567890123456789012',
      'https://www.youtube.com/embed/videoseries?list=PL123',
      'https://www.youtube.com/watch?v=ngan',
      `https://evil.example/youtube.com/watch?v=${VIDEO_ID}`,
      `https://youtube.com.evil.example/watch?v=${VIDEO_ID}`,
      `ftp://youtube.com/watch?v=${VIDEO_ID}`,
    ];
    links.forEach((link) => expect(parseYoutubeVideoId(link)).toBe(''));
  });
});

describe('getVideoVerdict', () => {
  it('có giấy phép khi mọi bài đều có giấy phép đúng mục đích', () => {
    const result = verdict(scan('block', [{ title: 'Bai Phep', artists: 'Ca Si X, Ca Si A' }]));
    expect(result.kind).toBe('cleared');
    expect(result.detail).toContain('bỏ sót');
  });

  it('một bài chưa có giấy phép là cần giấy phép cho cả video', () => {
    const tracks = [
      { title: 'Bai Phep', artists: 'Ca Si A' },
      { title: 'Bai La', artists: 'Ca Si Z' },
    ];
    const result = verdict(scan('block', tracks));
    expect(result.kind).toBe('needs_license');
    expect(result.tracks.map(({ analysis }) => analysis.status)).toEqual(['LICENSED', 'RESTRICTED']);
  });

  it('giấy phép sai mục đích hoặc hết hạn không được tính', () => {
    const youtubeOnly = scan('block', [{ title: 'Bai Youtube', artists: 'Ca Si B' }]);
    expect(verdict(youtubeOnly).kind).toBe('cleared');
    expect(verdict(youtubeOnly, 'paid_ads').kind).toBe('needs_license');
    expect(verdict(scan('block', [{ title: 'Bai Het Han', artists: 'Ca Si C' }])).kind).toBe('needs_license');
  });

  it('nhãn Public Domain không làm video có giấy phép, vì máy nhận ra bản thu cụ thể', () => {
    expect(verdict(scan('block', [{ title: 'Fur Elise', artists: 'Beethoven' }])).kind).toBe('needs_license');
  });

  it('bản remix của bài có giấy phép không được tính', () => {
    expect(verdict(scan('block', [{ title: 'Bai Phep (Remix)', artists: 'Ca Si A' }])).kind).toBe('needs_license');
  });

  it('nhận ra bài nhưng không có danh sách vẫn là cần giấy phép', () => {
    expect(verdict(scan('block')).kind).toBe('needs_license');
  });

  it('không rõ hoặc quyết định lạ đều là chưa biết', () => {
    expect(verdict(scan('hold')).kind).toBe('unknown');
    expect(verdict(scan('pass_licensed')).kind).toBe('unknown');
    expect(verdict(scan('gi_do_moi')).kind).toBe('unknown');
  });

  it('không thấy nhạc không được báo là có giấy phép', () => {
    const result = verdict(scan('pass_no_music'));
    expect(result.kind).toBe('no_music');
    expect(result.detail).toBe('ghi chú từ máy');
  });

  it('lỗi quét là chưa có kết luận', () => {
    expect(verdict(scan('error')).kind).toBe('error');
    expect(verdict(scan('block', [{ title: 'Bai Phep', artists: 'Ca Si A' }], 'error')).kind).toBe('error');
  });
});

describe('tên nghệ sĩ từ dịch vụ nhận diện', () => {
  it('tách được dấu &, feat. và ft.', () => {
    for (const artists of ['Ca Si Z & Ca Si A', 'Ca Si Z feat. Ca Si A', 'Ca Si Z ft. Ca Si A']) {
      expect(verdict(scan('block', [{ title: 'Bai Phep', artists }])).kind).toBe('cleared');
    }
  });
});

describe('parseUploadName', () => {
  it('nhận file âm thanh và video, giữ tên tiếng Việt', () => {
    expect(parseUploadName(encodeURIComponent('Bài dựng.MP4'))).toBe('Bài dựng.MP4');
  });

  it('bỏ mọi đường dẫn trong tên', () => {
    expect(parseUploadName(encodeURIComponent('../../etc/bai.mp3'))).toBe('bai.mp3');
    expect(parseUploadName(encodeURIComponent('..\\..\\windows\\bai.wav'))).toBe('bai.wav');
  });

  it('từ chối loại file khác và tên hỏng', () => {
    expect(parseUploadName(encodeURIComponent('virus.exe'))).toBe('');
    expect(parseUploadName(undefined)).toBe('');
    expect(parseUploadName('%E0%A4%A')).toBe('');
  });
});

describe('isSameOriginUpload', () => {
  it('chỉ nhận file gửi từ chính app', () => {
    expect(isSameOriginUpload('application/octet-stream', 'http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(isSameOriginUpload('application/octet-stream', 'https://evil.example', 'localhost:5173')).toBe(false);
    expect(isSameOriginUpload('multipart/form-data', 'http://localhost:5173', 'localhost:5173')).toBe(false);
  });
});

describe('isSameOriginJson', () => {
  it('nhận yêu cầu JSON từ chính app', () => {
    expect(isSameOriginJson('application/json', 'http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(isSameOriginJson('application/json', undefined, 'localhost:5173')).toBe(true);
  });

  it('từ chối trang khác và kiểu nội dung khác', () => {
    expect(isSameOriginJson('application/json', 'https://evil.example', 'localhost:5173')).toBe(false);
    expect(isSameOriginJson('text/plain', 'http://localhost:5173', 'localhost:5173')).toBe(false);
    expect(isSameOriginJson(undefined, undefined, 'localhost:5173')).toBe(false);
    expect(isSameOriginJson('application/json', 'khong-hop-le', 'localhost:5173')).toBe(false);
  });
});
