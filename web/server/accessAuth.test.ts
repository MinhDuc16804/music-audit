import { generateKeyPairSync, sign } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { AccessError, createAccessGuard, createKeyStore, parseAccessConfig, verifyAccessToken } from './accessAuth.ts';

const CONFIG = { issuer: 'https://cong-ty.cloudflareaccess.com', audience: 'app-aud' };
const NOW = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'khoa-1' };
const getKey = async (kid: string) => (kid === 'khoa-1' ? JWK : undefined);

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function makeToken(payload: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const head = part({ alg: 'RS256', kid: 'khoa-1', ...header });
  const body = part({ iss: CONFIG.issuer, aud: [CONFIG.audience], exp: NOW + 600, email: 'An@Cong-Ty.vn', ...payload });
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

describe('parseAccessConfig', () => {
  it('bật khi có đủ hai biến, bỏ https và dấu / thừa', () => {
    expect(parseAccessConfig('https://cong-ty.cloudflareaccess.com/', ' app-aud ')).toEqual(CONFIG);
  });

  it('thiếu một biến thì tắt', () => {
    expect(parseAccessConfig('cong-ty.cloudflareaccess.com', '')).toBeNull();
    expect(parseAccessConfig(undefined, 'app-aud')).toBeNull();
  });
});

describe('verifyAccessToken', () => {
  it('token hợp lệ thì trả về email đã chuẩn hóa', async () => {
    await expect(verifyAccessToken(makeToken(), CONFIG, getKey, NOW)).resolves.toBe('an@cong-ty.vn');
  });

  it('nhận aud dạng chuỗi', async () => {
    await expect(verifyAccessToken(makeToken({ aud: CONFIG.audience }), CONFIG, getKey, NOW)).resolves.toBe('an@cong-ty.vn');
  });

  it('từ chối token bị sửa email sau khi ký', async () => {
    const [head, , signature] = makeToken().split('.');
    const forged = `${head}.${part({ iss: CONFIG.issuer, aud: [CONFIG.audience], exp: NOW + 600, email: 'sep@cong-ty.vn' })}.${signature}`;
    await expect(verifyAccessToken(forged, CONFIG, getKey, NOW)).rejects.toThrow('Chữ ký');
  });

  it('từ chối token của ứng dụng khác, người phát hành khác, hết hạn hoặc chưa tới hạn', async () => {
    for (const payload of [{ aud: ['app-khac'] }, { iss: 'https://ke-gia.example' }, { exp: NOW - 120 }, { nbf: NOW + 600 }, { email: '' }]) {
      await expect(verifyAccessToken(makeToken(payload), CONFIG, getKey, NOW)).rejects.toBeInstanceOf(AccessError);
    }
  });

  it('từ chối kiểu chữ ký khác, khóa lạ và chuỗi rác', async () => {
    await expect(verifyAccessToken(makeToken({}, { alg: 'none' }), CONFIG, getKey, NOW)).rejects.toThrow('kiểu chữ ký');
    await expect(verifyAccessToken(makeToken({}, { kid: 'khoa-la' }), CONFIG, getKey, NOW)).rejects.toThrow('khóa');
    await expect(verifyAccessToken('abc', CONFIG, getKey, NOW)).rejects.toBeInstanceOf(AccessError);
    await expect(verifyAccessToken('a.b.c', CONFIG, getKey, NOW)).rejects.toBeInstanceOf(AccessError);
  });
});

describe('createKeyStore', () => {
  it('tải khóa một lần rồi dùng lại', async () => {
    const fetchJson = vi.fn(async () => ({ keys: [JWK] }));
    const findKey = createKeyStore(CONFIG.issuer, fetchJson);
    expect(await findKey('khoa-1')).toEqual(JWK);
    expect(await findKey('khoa-1')).toEqual(JWK);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith('https://cong-ty.cloudflareaccess.com/cdn-cgi/access/certs');
  });

  it('không tải được thì không có khóa, không làm hỏng server', async () => {
    const findKey = createKeyStore(CONFIG.issuer, async () => {
      throw new Error('mạng');
    });
    expect(await findKey('khoa-1')).toBeUndefined();
  });
});

describe('createAccessGuard', () => {
  const request = (headers: Record<string, string>) => ({ headers: { ...headers } }) as unknown as IncomingMessage;

  it('tắt xác minh thì cho qua và giữ nguyên header', async () => {
    const incoming = request({ 'cf-access-authenticated-user-email': 'ai-do@x.vn' });
    expect(await createAccessGuard(null)(incoming)).toBe(true);
    expect(incoming.headers['cf-access-authenticated-user-email']).toBe('ai-do@x.vn');
  });

  it('bật xác minh thì thay email trong header bằng email trong token', async () => {
    const guard = createAccessGuard(CONFIG, getKey);
    const incoming = request({ 'cf-access-jwt-assertion': makeToken({ exp: Date.now() / 1000 + 600 }), 'cf-access-authenticated-user-email': 'sep@cong-ty.vn' });
    expect(await guard(incoming)).toBe(true);
    expect(incoming.headers['cf-access-authenticated-user-email']).toBe('an@cong-ty.vn');
  });

  it('bật xác minh mà thiếu hoặc sai token thì từ chối', async () => {
    const guard = createAccessGuard(CONFIG, getKey);
    expect(await guard(request({ 'cf-access-authenticated-user-email': 'sep@cong-ty.vn' }))).toBe(false);
    expect(await guard(request({ 'cf-access-jwt-assertion': 'abc' }))).toBe(false);
  });
});
