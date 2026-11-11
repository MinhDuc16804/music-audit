import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createGuard, getHostname, isAllowedHost, parseAllowedHosts } from './http.ts';

function fakeExchange(host: string) {
  const request = { headers: { host }, method: 'POST', url: '/api/identify', resume: vi.fn() } as unknown as IncomingMessage;
  const sent: { status?: number; body?: string } = {};
  const response = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      sent.status = response.statusCode;
      sent.body = body;
    }),
  };
  return { request, response: response as unknown as ServerResponse, sent };
}

describe('getHostname', () => {
  it('bỏ cổng và viết thường, cả địa chỉ IPv6', () => {
    expect(getHostname('LocalHost:8080')).toBe('localhost');
    expect(getHostname('127.0.0.1:8080')).toBe('127.0.0.1');
    expect(getHostname('[::1]:8080')).toBe('::1');
    expect(getHostname(undefined)).toBe('');
  });
});

describe('isAllowedHost', () => {
  const allowed = parseAllowedHosts('https://KiemTraNhac.vi-du.vn/, app.vi-du.vn:443');

  it('nhận chính máy này và tên miền đã khai', () => {
    for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'kiemtranhac.vi-du.vn', 'app.vi-du.vn']) {
      expect(isAllowedHost(host, allowed), host).toBe(true);
    }
  });

  it('chặn tên miền lạ trỏ về máy này (DNS rebinding) và Host trống', () => {
    for (const host of ['trang-doc.example:8080', 'kiemtranhac.vi-du.vn.trang-doc.example', '127.0.0.1.nip.io', '', undefined]) {
      expect(isAllowedHost(host, allowed), String(host)).toBe(false);
    }
  });

  it('không khai APP_HOSTNAMES thì chỉ nhận chính máy này', () => {
    expect([...parseAllowedHosts(undefined)]).toEqual(['localhost', '127.0.0.1', '::1']);
  });
});

describe('createGuard', () => {
  const allowed = parseAllowedHosts(undefined);

  it('tên máy lạ bị từ chối trước khi chạy handler', async () => {
    const handler = vi.fn();
    const { request, response, sent } = fakeExchange('trang-doc.example:8080');
    await createGuard(allowed, async () => true)(handler)(request, response);
    expect(handler).not.toHaveBeenCalled();
    expect(sent.status).toBe(403);
  });

  it('chưa đăng nhập Access thì từ chối', async () => {
    const handler = vi.fn();
    const { request, response, sent } = fakeExchange('localhost:8080');
    await createGuard(allowed, async () => false)(handler)(request, response);
    expect(handler).not.toHaveBeenCalled();
    expect(sent.status).toBe(401);
  });

  it('handler lỗi bất ngờ thì trả lỗi 500, không ném ra ngoài làm sập server', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { request, response, sent } = fakeExchange('127.0.0.1:8080');
    const failing = async () => {
      throw new Error('ENOSPC: đĩa đầy');
    };
    await expect(createGuard(allowed, async () => true)(failing)(request, response)).resolves.toBeUndefined();
    expect(sent.status).toBe(500);
    expect(sent.body).not.toContain('ENOSPC');
    error.mockRestore();
  });
});

