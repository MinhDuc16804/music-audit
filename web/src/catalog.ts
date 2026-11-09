/** Danh sách nguồn nhạc tham khảo cho tab Nguồn nhạc. */

export interface MusicResource {
  name: string;
  url: string;
  note: string;
}

const PUBLIC_DOMAIN_SOURCES: MusicResource[] = [
  { name: 'Musopen', url: 'https://musopen.org', note: 'Bản thu và bản phổ nhạc cổ điển. Xem giấy phép của từng bản thu.' },
  { name: 'IMSLP', url: 'https://imslp.org', note: 'Thư viện bản phổ, phù hợp khi muốn tự thu âm lại.' },
];

const FREE_SOURCES: MusicResource[] = [
  { name: 'YouTube Audio Library', url: 'https://studio.youtube.com', note: 'Trong YouTube Studio. Chỉ chắc chắn dùng được trên YouTube.' },
  { name: 'Pixabay Music', url: 'https://pixabay.com/music/', note: 'Miễn phí. Đọc điều khoản trước khi dùng cho quảng cáo.' },
  { name: 'Incompetech', url: 'https://incompetech.com', note: 'Nhạc CC BY, bắt buộc ghi nguồn hoặc mua giấy phép không ghi nguồn.' },
];

const PAID_SOURCES: MusicResource[] = [
  { name: 'Epidemic Sound', url: 'https://www.epidemicsound.com', note: 'Thuê bao. Kiểm tra gói có gồm quảng cáo trả phí không.' },
  { name: 'Artlist', url: 'https://artlist.io', note: 'Thuê bao. Lưu lại giấy phép của từng dự án.' },
  { name: 'Soundstripe', url: 'https://www.soundstripe.com', note: 'Thuê bao, có gói dành cho doanh nghiệp.' },
];

export const RESOURCE_GROUPS = [
  { title: 'Miễn phí', resources: FREE_SOURCES },
  { title: 'Nhạc cổ điển và Public Domain', resources: PUBLIC_DOMAIN_SOURCES },
  { title: 'Trả phí', resources: PAID_SOURCES },
];
