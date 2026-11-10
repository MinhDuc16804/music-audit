import { describe, expect, it } from 'vitest';
import {
  applyLibraryAdditions,
  buildAudioLibraryIndex,
  describeLibrary,
  findAudioLibraryTrack,
  findNearAudioLibraryTrack,
  getArtistCandidates,
  isAudioLibraryFile,
  isSameArtistName,
  mergeAudioLibraryTracks,
  parseAudioLibrarySource,
  parseLibraryAdditions,
  parseStudioExport,
} from './audioLibrary.ts';

const index = buildAudioLibraryIndex([
  { title: 'Glen Canyon', artist: 'Dan Lebowitz', attribution: false },
  { title: 'Bodélé Depression (Mega-Chad Mix)', artist: 'Doug Maxwell, Jimmy Fontanez', attribution: true },
  { title: 'Universal', artist: 'Vibe Tracks', attribution: false },
  { title: 'Hai Ten', artist: 'The Grey Room / Density & Time', attribution: false },
  { title: 'Ten Dem', artist: 'Patrick Jordan Patrikios', attribution: false },
]);

describe('findAudioLibraryTrack', () => {
  it('khớp không phân biệt hoa thường và dấu', () => {
    expect(findAudioLibraryTrack('GLEN CANYON', 'dan lebowitz', index)?.title).toBe('Glen Canyon');
    expect(findAudioLibraryTrack('Bodele Depression (Mega-Chad Mix)', 'Doug Maxwell, Jimmy Fontanez', index)).toBeDefined();
  });

  it('tìm được khi dịch vụ nhận diện gộp thêm nghệ sĩ khác', () => {
    expect(findAudioLibraryTrack('Glen Canyon', 'Ca Si X feat. Dan Lebowitz', index)).toBeDefined();
  });

  it('cùng tên bài nhưng khác nghệ sĩ không được tính', () => {
    expect(findAudioLibraryTrack('Glen Canyon', 'Ca Si X', index)).toBeUndefined();
  });

  it('bản remix của bài trong thư viện không được tính', () => {
    expect(findAudioLibraryTrack('Glen Canyon (Remix)', 'Dan Lebowitz', index)).toBeUndefined();
  });

  it('thiếu phần trong ngoặc của tên bài không được tính', () => {
    expect(findAudioLibraryTrack('Bodele Depression', 'Doug Maxwell, Jimmy Fontanez', index)).toBeUndefined();
  });

  it('khớp theo album khi AudD ghi tác giả ở nghệ sĩ', () => {
    expect(findAudioLibraryTrack('Universal', 'Daniele Matracia', index, 'Vibe Tracks')?.artist).toBe('Vibe Tracks');
    expect(findAudioLibraryTrack('Universal', 'Daniele Matracia', index, 'Album Khac')).toBeUndefined();
  });

  it('khớp khi thư viện ghi nhiều tên trong một chuỗi', () => {
    expect(findAudioLibraryTrack('Hai Ten', 'Density & Time', index)).toBeDefined();
    expect(findAudioLibraryTrack('Hai Ten', 'The Grey Room', index)).toBeDefined();
  });

  it('khớp khi nghệ sĩ thiếu tên đệm', () => {
    expect(findAudioLibraryTrack('Ten Dem', 'Patrick Patrikios', index)).toBeDefined();
  });

  it('danh sách rỗng không khớp bài nào', () => {
    expect(findAudioLibraryTrack('Glen Canyon', 'Dan Lebowitz', buildAudioLibraryIndex([]))).toBeUndefined();
  });
});

describe('findNearAudioLibraryTrack', () => {
  it('chỉ cần trùng tên bài, không xét nghệ sĩ', () => {
    expect(findNearAudioLibraryTrack('universal', index)?.artist).toBe('Vibe Tracks');
  });

  it('bỏ qua phần trong ngoặc', () => {
    expect(findNearAudioLibraryTrack('Glen Canyon (Remix)', index)?.title).toBe('Glen Canyon');
    expect(findNearAudioLibraryTrack('Bodele Depression', index)).toBeDefined();
  });

  it('không có bài trùng tên hoặc tên rỗng thì không có kết quả', () => {
    expect(findNearAudioLibraryTrack('Bai La', index)).toBeUndefined();
    expect(findNearAudioLibraryTrack('(Remix)', index)).toBeUndefined();
  });
});

describe('isSameArtistName', () => {
  it('nhận cách viết khác nhau của cùng tên', () => {
    expect(isSameArtistName('Patrick Patrikios', 'Patrick Jordan Patrikios')).toBe(true);
    expect(isSameArtistName('U.S. Army Band', 'The U.S. Army Band')).toBe(true);
  });

  it('một từ chung không đủ để coi là cùng người', () => {
    expect(isSameArtistName('Patrick', 'Patrick Jordan Patrikios')).toBe(false);
    expect(isSameArtistName('Ca Si A', 'Ca Si B')).toBe(false);
    expect(isSameArtistName('', 'A')).toBe(false);
  });
});

describe('getArtistCandidates', () => {
  it('giữ chuỗi đầy đủ và tách từng tên', () => {
    expect(getArtistCandidates('A, B & C ft. D')).toEqual(['A, B & C ft. D', 'A', 'B', 'C', 'D']);
    expect(getArtistCandidates('A / B and C')).toEqual(['A / B and C', 'A', 'B', 'C']);
  });

  it('bỏ tên rỗng', () => {
    expect(getArtistCandidates('')).toEqual([]);
  });
});

describe('parseAudioLibrarySource', () => {
  it('đánh dấu bài Creative Commons cần ghi nguồn', () => {
    const tracks = parseAudioLibrarySource({
      tracks: [
        { title: 'A', artist: 'X', license_type: 0 },
        { title: 'B', artist: 'X', license_type: 1 },
        { title: 'C', artist: 'X', license_type: 6 },
      ],
    });
    expect(tracks.map((track) => track.attribution)).toEqual([false, false, true]);
  });

  it('loại giấy phép lạ thì coi là cần ghi nguồn', () => {
    expect(parseAudioLibrarySource({ tracks: [{ title: 'A', artist: 'X' }] })[0].attribution).toBe(true);
  });

  it('gộp bài trùng và giữ yêu cầu ghi nguồn', () => {
    const tracks = parseAudioLibrarySource({
      tracks: [
        { title: 'A', artist: 'X', license_type: 6 },
        { title: 'a', artist: 'x', license_type: 1 },
      ],
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].attribution).toBe(true);
  });

  it('báo lỗi khi dữ liệu sai', () => {
    expect(() => parseAudioLibrarySource({ tracks: [] })).toThrow();
    expect(() => parseAudioLibrarySource(null)).toThrow();
    expect(() => parseAudioLibrarySource({ tracks: [{ title: 'A' }] })).toThrow('Bài thứ 1');
  });
});

describe('parseStudioExport', () => {
  it('chỉ giấy phép tiêu chuẩn mới không cần ghi nguồn', () => {
    const tracks = parseStudioExport([
      { title: 'A', artist: 'X', license: 'yt-audio-library' },
      { title: 'B', artist: 'X', license: 'cc-by' },
      { title: 'C', artist: 'X', license: 'lạ' },
    ]);
    expect(tracks.map((track) => track.attribution)).toEqual([false, true, true]);
  });

  it('gộp bài trùng và giữ yêu cầu ghi nguồn', () => {
    const tracks = parseStudioExport([
      { title: 'A', artist: 'X', license: 'cc-by' },
      { title: 'a', artist: 'x', license: 'yt-audio-library' },
    ]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].attribution).toBe(true);
  });

  it('báo lỗi khi dữ liệu sai', () => {
    expect(() => parseStudioExport([])).toThrow();
    expect(() => parseStudioExport({ tracks: [] })).toThrow();
    expect(() => parseStudioExport([{ title: 'A' }])).toThrow('Bài thứ 1');
  });
});

describe('mergeAudioLibraryTracks', () => {
  const oldTrack = { title: 'Cu', artist: 'X', attribution: true };
  const keptTrack = { title: 'Giu', artist: 'X', attribution: false };
  const newTrack = { title: 'Moi', artist: 'Y', attribution: false };

  it('thêm bài mới và giữ bài cũ, đánh dấu bài không còn thấy', () => {
    expect(mergeAudioLibraryTracks([oldTrack, keptTrack], [keptTrack, newTrack])).toEqual([
      keptTrack,
      newTrack,
      { ...oldTrack, unconfirmed: true },
    ]);
  });

  it('khớp không phân biệt hoa thường và dấu', () => {
    const merged = mergeAudioLibraryTracks([keptTrack], [{ ...keptTrack, title: 'GIÚ' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].unconfirmed).toBeUndefined();
  });

  it('bài chưa xác nhận xuất hiện lại thì hết đánh dấu', () => {
    expect(mergeAudioLibraryTracks([{ ...oldTrack, unconfirmed: true }], [oldTrack])).toEqual([oldTrack]);
  });

  it('gộp lại lần nữa cho cùng kết quả', () => {
    const once = mergeAudioLibraryTracks([oldTrack, keptTrack], [keptTrack, newTrack]);
    expect(mergeAudioLibraryTracks(once, [keptTrack, newTrack])).toEqual(once);
  });
});

describe('parseLibraryAdditions', () => {
  const header = ['title', 'artist', 'attribution', 'checkedBy', 'checkedOn'];

  it('chỉ có dòng tiêu đề thì không có bài nào', () => {
    expect(parseLibraryAdditions([header])).toEqual([]);
  });

  it('đọc bài, bỏ dòng trống, chấp nhận TRUE của Excel', () => {
    expect(parseLibraryAdditions([header, ['Bai A', 'Ca si', 'TRUE', 'Duc', '2026-11-07'], [''], ['Bai B', 'Ca si', 'false', 'Duc', '2026-11-07']])).toEqual([
      { title: 'Bai A', artist: 'Ca si', attribution: true },
      { title: 'Bai B', artist: 'Ca si', attribution: false },
    ]);
  });

  it('đọc theo tên cột, không theo thứ tự', () => {
    expect(parseLibraryAdditions([['artist', 'title', 'checkedOn', 'checkedBy', 'attribution'], ['Ca si', 'Bai A', '2026-11-07', 'Duc', 'false']])).toEqual([
      { title: 'Bai A', artist: 'Ca si', attribution: false },
    ]);
  });

  it('gộp dòng trùng và giữ yêu cầu ghi nguồn', () => {
    const rows = [header, ['Bai A', 'Ca si', 'true', 'Duc', '2026-11-07'], ['BÀI A', 'Ca si', 'false', 'Duc', '2026-11-07']];
    expect(parseLibraryAdditions(rows)).toEqual([{ title: 'BÀI A', artist: 'Ca si', attribution: true }]);
  });

  it('báo lỗi khi thiếu cột', () => {
    expect(() => parseLibraryAdditions([['title', 'artist']])).toThrow('attribution, checkedBy, checkedOn');
    expect(() => parseLibraryAdditions([])).toThrow('thiếu cột');
  });

  it('báo số dòng sai và không bỏ qua dòng nào', () => {
    const rows = [
      header,
      ['Bai A', 'Ca si', 'true', 'Duc', '2026-11-07'],
      ['Bai B', '', 'co', '', '07/11/2026'],
    ];
    expect(() => parseLibraryAdditions(rows)).toThrow(/Dòng 3: .*nghệ sĩ.*attribution.*người kiểm tra.*checkedOn/);
  });

  it('không tự coi là không cần ghi nguồn khi bỏ trống', () => {
    expect(() => parseLibraryAdditions([header, ['Bai A', 'Ca si', '', 'Duc', '2026-11-07']])).toThrow('attribution');
  });
});

describe('applyLibraryAdditions', () => {
  const studioTrack = { title: 'Studio', artist: 'X', attribution: false };
  const addition = { title: 'Them', artist: 'Y', attribution: true };

  it('thêm bài mới và đánh dấu thêm tay', () => {
    expect(applyLibraryAdditions([studioTrack], [addition])).toEqual([studioTrack, { ...addition, manual: true }]);
  });

  it('áp lại lần nữa cho cùng kết quả', () => {
    const once = applyLibraryAdditions([studioTrack], [addition]);
    expect(applyLibraryAdditions(once, [addition])).toEqual(once);
  });

  it('bài đã xóa khỏi file thì rời danh sách', () => {
    const once = applyLibraryAdditions([studioTrack], [addition]);
    expect(applyLibraryAdditions(once, [])).toEqual([studioTrack]);
  });

  it('bài chưa xác nhận được người duyệt xác nhận thì hết đánh dấu', () => {
    const old = { title: 'Them', artist: 'Y', attribution: false, unconfirmed: true };
    expect(applyLibraryAdditions([old], [addition])).toEqual([{ ...addition, manual: true }]);
  });

  it('không nới yêu cầu ghi nguồn của bài có sẵn', () => {
    const creativeCommons = { ...studioTrack, attribution: true };
    expect(applyLibraryAdditions([creativeCommons], [{ ...studioTrack }])).toEqual([creativeCommons]);
  });

  it('sửa được attribution của dòng thêm tay', () => {
    const once = applyLibraryAdditions([], [addition]);
    expect(applyLibraryAdditions(once, [{ ...addition, attribution: false }])).toEqual([{ ...addition, attribution: false, manual: true }]);
  });

  it('bài thêm tay vẫn được xác nhận sau lần xuất Studio không có bài đó', () => {
    const withAddition = applyLibraryAdditions([studioTrack], [addition]);
    const merged = mergeAudioLibraryTracks(withAddition, [studioTrack]);
    expect(applyLibraryAdditions(merged, [addition])).toEqual([studioTrack, { ...addition, manual: true }]);
  });

  it('bài thêm tay có trong lần xuất Studio thì thành bài Studio', () => {
    const withAddition = applyLibraryAdditions([studioTrack], [addition]);
    const merged = mergeAudioLibraryTracks(withAddition, [studioTrack, addition]);
    const applied = applyLibraryAdditions(merged, [addition]);
    expect(applied).toEqual([studioTrack, addition]);
    expect(applyLibraryAdditions(applied, [])).toEqual([studioTrack, addition]);
  });
});

describe('isAudioLibraryFile', () => {
  it('danh sách rỗng hoặc sai dạng không hợp lệ', () => {
    expect(isAudioLibraryFile({ tracks: [{ title: 'A', artist: 'X', attribution: false }] })).toBe(true);
    expect(isAudioLibraryFile({ tracks: [] })).toBe(false);
    expect(isAudioLibraryFile(null)).toBe(false);
  });
});

describe('describeLibrary', () => {
  const tracks = [{ title: 'A', artist: 'X', attribution: false }];
  const today = new Date(2026, 10, 10);

  it('danh sách còn mới thì hiện ngày và số bài', () => {
    expect(describeLibrary({ sourceUpdatedOn: '2026-11-07', tracks }, today)).toEqual({ label: 'Thư viện cập nhật 07/11/2026 · 1 bài', isStale: false });
    expect(describeLibrary({ sourceUpdatedOn: '2026-10-11', tracks }, today).isStale).toBe(false);
  });

  it('quá 30 ngày thì báo cần cập nhật', () => {
    expect(describeLibrary({ sourceUpdatedOn: '2026-10-10', tracks }, today)).toEqual({ label: 'Thư viện cập nhật 10/10/2026 · đã 31 ngày, cần cập nhật', isStale: true });
  });

  it('không đọc được ngày thì coi là cũ', () => {
    for (const sourceUpdatedOn of ['', 'hôm qua', undefined as unknown as string]) {
      expect(describeLibrary({ sourceUpdatedOn, tracks }, today)).toEqual({ label: 'Thư viện chưa rõ ngày cập nhật · 1 bài', isStale: true });
    }
  });
});
