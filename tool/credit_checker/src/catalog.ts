/**
 * Dữ liệu mẫu, không phải cơ sở dữ liệu bản quyền.
 * Muốn thêm nhãn SAFE hoặc WARNING thì phải có nguồn xác minh và ghi vào sourceNote.
 */

export type CopyrightStatus = 'SAFE' | 'WARNING' | 'RESTRICTED';

export interface MusicResource {
  name: string;
  url: string;
  note: string;
}

export interface CatalogEntry {
  titles: string[];
  artists: string[];
  status: CopyrightStatus;
  licenseType: string;
  compositionRights: string;
  masterRights: string;
  sourceNote: string;
  attribution?: string;
}

const PUBLIC_DOMAIN_LICENSE = 'Public Domain (chỉ phần bản phổ)';
const PUBLIC_DOMAIN_COMPOSITION = 'Bản phổ đã hết thời hạn bảo hộ vì tác giả mất hơn 70 năm.';
const PUBLIC_DOMAIN_MASTER =
  'Bản thu do dàn nhạc hoặc nghệ sĩ hiện đại biểu diễn vẫn có thể có bản quyền riêng, kể cả khi bản phổ đã tự do.';
const COMPOSER_DIED_NOTE = 'Năm mất của nhà soạn nhạc, không xét bản thu cụ thể.';

const COMMERCIAL_LICENSE = 'Bản phát hành thương mại';
const COMMERCIAL_COMPOSITION = 'Phần sáng tác còn được bảo hộ và thuộc tác giả hoặc nhà xuất bản âm nhạc.';
const COMMERCIAL_MASTER = 'Bản thu thuộc hãng đĩa hoặc đơn vị phát hành.';

export const CATALOG: CatalogEntry[] = [
  {
    titles: ['Fur Elise', 'Bagatelle No. 25'],
    artists: ['Beethoven', 'Ludwig van Beethoven'],
    status: 'SAFE',
    licenseType: PUBLIC_DOMAIN_LICENSE,
    compositionRights: PUBLIC_DOMAIN_COMPOSITION,
    masterRights: PUBLIC_DOMAIN_MASTER,
    sourceNote: `Beethoven mất năm 1827. ${COMPOSER_DIED_NOTE}`,
  },
  {
    titles: ['Moonlight Sonata', 'Piano Sonata No. 14'],
    artists: ['Beethoven', 'Ludwig van Beethoven'],
    status: 'SAFE',
    licenseType: PUBLIC_DOMAIN_LICENSE,
    compositionRights: PUBLIC_DOMAIN_COMPOSITION,
    masterRights: PUBLIC_DOMAIN_MASTER,
    sourceNote: `Beethoven mất năm 1827. ${COMPOSER_DIED_NOTE}`,
  },
  {
    titles: ['Eine kleine Nachtmusik'],
    artists: ['Mozart', 'Wolfgang Amadeus Mozart'],
    status: 'SAFE',
    licenseType: PUBLIC_DOMAIN_LICENSE,
    compositionRights: PUBLIC_DOMAIN_COMPOSITION,
    masterRights: PUBLIC_DOMAIN_MASTER,
    sourceNote: `Mozart mất năm 1791. ${COMPOSER_DIED_NOTE}`,
  },
  {
    titles: ['Clair de Lune'],
    artists: ['Debussy', 'Claude Debussy'],
    status: 'SAFE',
    licenseType: PUBLIC_DOMAIN_LICENSE,
    compositionRights: PUBLIC_DOMAIN_COMPOSITION,
    masterRights: PUBLIC_DOMAIN_MASTER,
    sourceNote: `Debussy mất năm 1918. ${COMPOSER_DIED_NOTE}`,
  },
  {
    titles: ['Carefree'],
    artists: ['Kevin MacLeod'],
    status: 'WARNING',
    licenseType: 'Creative Commons (CC BY 4.0)',
    compositionRights: 'Tác giả giữ bản quyền và cho phép dùng theo CC BY 4.0, gồm cả mục đích thương mại.',
    masterRights: 'Cùng giấy phép CC BY 4.0, với điều kiện ghi nguồn đúng cách.',
    sourceNote: 'Giấy phép công bố trên incompetech.com. Hãy kiểm tra lại trang của bài trước khi dùng.',
    attribution: [
      '"Carefree" Kevin MacLeod (incompetech.com)',
      'Licensed under Creative Commons: By Attribution 4.0 License',
      'http://creativecommons.org/licenses/by/4.0/',
    ].join('\n'),
  },
  {
    titles: ['Shape of You'],
    artists: ['Ed Sheeran'],
    status: 'RESTRICTED',
    licenseType: COMMERCIAL_LICENSE,
    compositionRights: COMMERCIAL_COMPOSITION,
    masterRights: COMMERCIAL_MASTER,
    sourceNote: 'Bài phát hành thương mại.',
  },
  {
    titles: ['Faded'],
    artists: ['Alan Walker'],
    status: 'RESTRICTED',
    licenseType: COMMERCIAL_LICENSE,
    compositionRights: COMMERCIAL_COMPOSITION,
    masterRights: COMMERCIAL_MASTER,
    sourceNote: 'Bài phát hành thương mại. Không nhầm với các bản do NoCopyrightSounds phát hành.',
  },
  {
    titles: ['Lac Troi'],
    artists: ['Son Tung M-TP'],
    status: 'RESTRICTED',
    licenseType: COMMERCIAL_LICENSE,
    compositionRights: COMMERCIAL_COMPOSITION,
    masterRights: COMMERCIAL_MASTER,
    sourceNote: 'Bài phát hành thương mại.',
  },
];

export const PUBLIC_DOMAIN_SOURCES: MusicResource[] = [
  { name: 'Musopen', url: 'https://musopen.org', note: 'Bản thu và bản phổ nhạc cổ điển. Xem giấy phép của từng bản thu.' },
  { name: 'IMSLP', url: 'https://imslp.org', note: 'Thư viện bản phổ, phù hợp khi muốn tự thu âm lại.' },
];

export const FREE_SOURCES: MusicResource[] = [
  { name: 'YouTube Audio Library', url: 'https://studio.youtube.com', note: 'Trong YouTube Studio. Chỉ chắc chắn dùng được trên YouTube.' },
  { name: 'Pixabay Music', url: 'https://pixabay.com/music/', note: 'Miễn phí. Đọc điều khoản trước khi dùng cho quảng cáo.' },
  { name: 'Incompetech', url: 'https://incompetech.com', note: 'Nhạc CC BY, bắt buộc ghi nguồn hoặc mua giấy phép không ghi nguồn.' },
];

export const PAID_SOURCES: MusicResource[] = [
  { name: 'Epidemic Sound', url: 'https://www.epidemicsound.com', note: 'Thuê bao. Kiểm tra gói có gồm quảng cáo trả phí không.' },
  { name: 'Artlist', url: 'https://artlist.io', note: 'Thuê bao. Lưu lại giấy phép của từng dự án.' },
  { name: 'Soundstripe', url: 'https://www.soundstripe.com', note: 'Thuê bao, có gói dành cho doanh nghiệp.' },
];

export const RESOURCE_GROUPS = [
  { title: 'Miễn phí', resources: FREE_SOURCES },
  { title: 'Nhạc cổ điển và Public Domain', resources: PUBLIC_DOMAIN_SOURCES },
  { title: 'Trả phí', resources: PAID_SOURCES },
];
