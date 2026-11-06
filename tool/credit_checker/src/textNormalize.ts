/** Chuẩn hóa để so sánh: bỏ dấu, viết thường, chỉ giữ chữ và số, kể cả chữ không phải Latin. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Chuẩn hóa tên bài và bỏ phần trong ngoặc. */
export function normalizeTitle(value: string): string {
  return normalizeText(value.replace(/\(.*?\)|\[.*?\]/g, ' '));
}

/** Khóa tra cứu của một cặp tên bài và tác giả. */
export function getCatalogKey(title: string, artist: string): string {
  return `${normalizeTitle(title)}\u0000${normalizeText(artist)}`;
}
