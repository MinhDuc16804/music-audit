/**
 * Xác minh người dùng qua Cloudflare Access. Access gắn vào mỗi yêu cầu một token JWT có chữ ký,
 * nên app tin email trong token đã xác minh chứ không tin header email, vì header đó ai gọi thẳng vào app cũng giả được.
 *
 * Bật bằng hai biến môi trường: CF_ACCESS_TEAM_DOMAIN (ví dụ quocduy.cloudflareaccess.com) và CF_ACCESS_AUD
 * (Application Audience Tag của ứng dụng trong Cloudflare Access). Thiếu một trong hai thì tắt, app chạy như trước.
 */

import { createPublicKey, verify } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const ACCESS_TOKEN_HEADER = 'cf-access-jwt-assertion';
/** Header email mà phần còn lại của app đọc, xem usageLimit.ts. Được ghi đè bằng email đã xác minh. */
const ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email';
/** Cho phép đồng hồ hai máy lệch nhau một chút. */
const CLOCK_SKEW_SECONDS = 60;
const KEYS_TTL_MS = 60 * 60_000;
/** Gặp mã khóa lạ thì tải lại danh sách khóa, nhưng không quá một lần mỗi phút. */
const KEYS_RETRY_MS = 60_000;

export class AccessError extends Error {}

export interface AccessConfig {
  issuer: string;
  audience: string;
}

/** Khóa công khai dạng JWK như Cloudflare trả về, có thêm mã khóa kid. */
type AccessKey = { kid?: string; kty?: string; n?: string; e?: string; [field: string]: unknown };

/** Đọc cấu hình từ biến môi trường. Thiếu một trong hai biến thì trả về null, tức tắt xác minh. */
export function parseAccessConfig(teamDomain: string | undefined, audience: string | undefined): AccessConfig | null {
  const domain = teamDomain?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') ?? '';
  const aud = audience?.trim() ?? '';
  return domain && aud ? { issuer: `https://${domain}`, audience: aud } : null;
}

function decodePart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new AccessError('Token không đọc được.');
  }
}

/** Kiểm chữ ký RS256, người phát hành, ứng dụng và thời hạn. Hợp lệ thì trả về email trong token. */
export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  getKey: (kid: string) => Promise<AccessKey | undefined>,
  nowSeconds: number = Date.now() / 1000,
): Promise<string> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new AccessError('Token sai định dạng.');
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodePart(headerPart) as { alg?: unknown; kid?: unknown };
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new AccessError('Token dùng kiểu chữ ký không được nhận.');
  }
  const jwk = await getKey(header.kid);
  if (!jwk) {
    throw new AccessError('Không tìm thấy khóa đã ký token.');
  }
  const isSigned = verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key: jwk as Parameters<typeof createPublicKey>[0] extends { key: infer Key } ? Extract<Key, object> : never, format: 'jwk' }), Buffer.from(signaturePart, 'base64url'));
  if (!isSigned) {
    throw new AccessError('Chữ ký token không đúng.');
  }

  const payload = decodePart(payloadPart) as { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; email?: unknown };
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== config.issuer || !audiences.includes(config.audience)) {
    throw new AccessError('Token không dành cho app này.');
  }
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new AccessError('Token đã hết hạn.');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new AccessError('Token chưa tới thời điểm dùng.');
  }
  if (typeof payload.email !== 'string' || !payload.email.trim()) {
    throw new AccessError('Token không có email.');
  }
  return payload.email.trim().toLowerCase();
}

/** Tải và giữ tạm các khóa công khai của Cloudflare Access. */
export function createKeyStore(issuer: string, fetchJson: (url: string) => Promise<unknown> = (url) => fetch(url).then((response) => response.json())) {
  let keys: AccessKey[] = [];
  let loadedAt = 0;
  let loading: Promise<void> | null = null;

  const load = () => {
    loading ??= fetchJson(`${issuer}/cdn-cgi/access/certs`)
      .then((body) => {
        const fresh = (body as { keys?: unknown } | null)?.keys;
        if (Array.isArray(fresh)) {
          keys = fresh as AccessKey[];
        }
        loadedAt = Date.now();
      })
      .catch(() => undefined)
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  return async (kid: string): Promise<AccessKey | undefined> => {
    const age = Date.now() - loadedAt;
    const known = keys.find((key) => key.kid === kid);
    if (age > KEYS_TTL_MS || (!known && age > KEYS_RETRY_MS)) {
      await load();
    }
    return keys.find((key) => key.kid === kid);
  };
}

/**
 * Bật xác minh thì yêu cầu không có token hợp lệ bị từ chối, còn email đã xác minh được ghi đè vào header email.
 * Tắt xác minh thì cho qua như trước.
 */
export function createAccessGuard(config: AccessConfig | null, getKey?: (kid: string) => Promise<AccessKey | undefined>) {
  if (!config) {
    return async (_request: IncomingMessage) => true;
  }
  const findKey = getKey ?? createKeyStore(config.issuer);
  return async (request: IncomingMessage): Promise<boolean> => {
    const value = request.headers[ACCESS_TOKEN_HEADER];
    const token = Array.isArray(value) ? value[0] : value;
    try {
      if (!token) {
        throw new AccessError('Thiếu token.');
      }
      request.headers[ACCESS_EMAIL_HEADER] = await verifyAccessToken(token, config, findKey);
      return true;
    } catch {
      return false;
    }
  };
}
