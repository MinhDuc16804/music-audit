/**
 * Đọc gói và số yêu cầu của tài khoản AudD bằng công cụ audd, vì API của AudD không có chỗ nào trả các số này.
 * Công cụ cần được đăng nhập một lần trên máy chủ (audd login). Lỗi ở đây không được ảnh hưởng tới việc quét.
 */

import type { QuotaAccount, QuotaReading, QuotaStatus } from '../src/quota.ts';

export const QUOTA_ROUTE = '/api/quota';
const CACHE_MS = 60_000;
const MIN_REFRESH_MS = 10_000;

/** Công cụ có thể bọc kết quả trong một trường, nên mở các lớp này ra trước khi đọc. */
const WRAPPER_KEYS = ['result', 'data', 'usage', 'account', 'status'];

type Fields = Record<string, unknown>;

export class AuddCommandError extends Error {
  readonly status: QuotaStatus;

  constructor(status: QuotaStatus, message = '') {
    super(message);
    this.status = status;
  }
}

function asFields(value: unknown): Fields {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};
}

function parseFields(text: string, wanted: string): Fields {
  let fields: Fields;
  try {
    fields = asFields(JSON.parse(text));
  } catch {
    throw new AuddCommandError('error');
  }
  for (let depth = 0; depth < 3 && !(wanted in fields); depth += 1) {
    const inner = WRAPPER_KEYS.map((key) => fields[key]).find((value) => asFields(value)[wanted] !== undefined);
    if (inner === undefined) {
      break;
    }
    fields = asFields(inner);
  }
  return fields;
}

function toNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

const toText = (value: unknown) => (typeof value === 'string' ? value : '');

export function parsePlanName(text: string): string {
  const { plan, plan_name: planName } = parseFields(text, 'plan');
  return toText(asFields(plan).name) || toText(plan) || toText(planName);
}

/** Thiếu số đã dùng hoặc không suy ra được số còn lại thì báo lỗi, không hiện số đoán. */
export function parseUsage(text: string, planName: string): QuotaAccount {
  const fields = parseFields(text, 'used_this_cycle');
  const used = toNumber(fields.used_this_cycle);
  const allowance = toNumber(fields.allowance);
  const remaining = toNumber(fields.remaining) ?? (allowance !== null && used !== null ? allowance - used : null);
  if (used === null || remaining === null) {
    throw new AuddCommandError('error');
  }
  return {
    planName,
    total: allowance ?? used + remaining,
    used,
    remaining: Math.max(0, remaining),
    cycleStart: toText(fields.cycle_start),
    cycleEnd: toText(fields.cycle_end),
  };
}

export interface QuotaReaderDeps {
  /** Chạy công cụ audd, trả về chữ in ra. Lỗi nên là AuddCommandError. */
  run: (args: string[]) => Promise<string>;
  now?: () => number;
}

export function createQuotaReader({ run, now = Date.now }: QuotaReaderDeps) {
  let cached: { at: number; reading: QuotaReading } | null = null;
  let pending: Promise<QuotaReading> | null = null;

  const fetchReading = async (): Promise<QuotaReading> => {
    const fetchedAt = new Date(now()).toISOString();
    try {
      const [accountText, usageText] = await Promise.all([run(['account', '--format', 'json']), run(['usage', '--format', 'json'])]);
      return { status: 'ok', fetchedAt, account: parseUsage(usageText, parsePlanName(accountText)) };
    } catch (error) {
      return { status: error instanceof AuddCommandError ? error.status : 'error', fetchedAt };
    }
  };

  return {
    /** Có bộ nhớ đệm để nhiều người mở tab cùng lúc không làm công cụ chạy liên tục. */
    read(refresh: boolean): Promise<QuotaReading> {
      const age = cached ? now() - cached.at : Number.POSITIVE_INFINITY;
      if (cached && age < (refresh ? MIN_REFRESH_MS : CACHE_MS)) {
        return Promise.resolve(cached.reading);
      }
      pending ??= fetchReading()
        .then((reading) => {
          cached = { at: now(), reading };
          return reading;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
