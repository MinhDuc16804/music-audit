/** Cloudflare gói miễn phí chặn yêu cầu trên 100 MB, nên giới hạn thấp hơn một chút để báo lỗi rõ ràng. */
export const MAX_UPLOAD_MB = 95;

export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export const UPLOAD_TOO_LARGE_MESSAGE = `File lớn hơn ${MAX_UPLOAD_MB} MB. Hãy xuất riêng phần âm thanh rồi tải lên.`;
