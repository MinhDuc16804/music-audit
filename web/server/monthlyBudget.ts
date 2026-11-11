/**
 * Trần chi phí AudD mỗi tháng cho cả app, vì mọi người dùng chung một khóa và AudD tính tiền theo tháng.
 * Mỗi lượt quét giữ chỗ số yêu cầu ước tính trước khi gửi, không đủ thì bị từ chối. Quét xong thì tính theo số thật và trả lại phần thừa.
 * Sổ chi lưu ra file theo tháng, nên khởi động lại app không mất. Phần đang giữ chỗ chỉ nằm trong bộ nhớ:
 * app dừng giữa lượt quét thì phần đó coi như đã chi, thừa còn hơn thiếu.
 *
 * Bật bằng AUDD_MONTHLY_BUDGET và AUDD_PRICE_PER_1000. Để trống AUDD_MONTHLY_BUDGET thì tắt.
 * Gói AudD có phí cố định kèm số yêu cầu được cấp (AUDD_PLAN_FEE, AUDD_PLAN_REQUESTS), phần vượt tính theo AUDD_PRICE_PER_1000.
 */

import type { BudgetKind, BudgetView } from '../src/budget.ts';

export interface BudgetConfig {
  amount: number;
  /** Phí gói mỗi tháng, trả cả khi chưa quét gì. */
  planFee: number;
  /** Số yêu cầu đã gồm trong phí gói. */
  planRequests: number;
  /** Giá cho 1.000 yêu cầu vượt gói. */
  pricePer1000: number;
  currency: string;
  warnPercent: number;
}

export interface BudgetLedger {
  month: string;
  charged: number;
  byUser: Record<string, number>;
  byKind: Partial<Record<BudgetKind, number>>;
}

export interface BudgetStore {
  /** Chưa có sổ thì trả về null. Sổ có mà hỏng hay không đọc được thì báo lỗi. */
  readSync(month: string): BudgetLedger | null;
  write(ledger: BudgetLedger): unknown;
}

/** Giấy giữ chỗ, đưa lại cho settle khi lượt quét xong. */
export interface BudgetHold {
  month: string;
  user: string;
  kind: BudgetKind;
  requests: number;
  isSettled: boolean;
}

const DEFAULT_CURRENCY = 'USD';
const DEFAULT_WARN_PERCENT = 80;

const positiveNumber = (value: string | undefined) => {
  const number = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
};

/** Để trống là 0, sai thì null. */
const optionalNumber = (value: string | undefined, isInteger = false) => {
  if (!value?.trim()) {
    return 0;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && (!isInteger || Number.isInteger(number)) ? number : null;
};

/**
 * Để trống AUDD_MONTHLY_BUDGET thì tắt. Đã đặt mà sai, hoặc thiếu giá, thì ngân sách là 0 để chặn hết,
 * vì lỗi cấu hình không được thành không giới hạn.
 */
export function parseBudgetConfig(env: Record<string, string | undefined>): BudgetConfig | null {
  if (!env.AUDD_MONTHLY_BUDGET?.trim()) {
    return null;
  }
  const amount = positiveNumber(env.AUDD_MONTHLY_BUDGET);
  const pricePer1000 = positiveNumber(env.AUDD_PRICE_PER_1000);
  const planFee = optionalNumber(env.AUDD_PLAN_FEE);
  const planRequests = optionalNumber(env.AUDD_PLAN_REQUESTS, true);
  const warn = Number(env.AUDD_BUDGET_WARN_PERCENT);
  const currency = env.AUDD_BUDGET_CURRENCY?.trim().slice(0, 8) || DEFAULT_CURRENCY;
  // Ngân sách thấp hơn phí gói thì không trả nổi gói, coi như cấu hình sai.
  const isValid = amount !== null && pricePer1000 !== null && planFee !== null && planRequests !== null && amount >= planFee;
  if (!isValid) {
    console.error('Cấu hình ngân sách AudD không hợp lệ (AUDD_MONTHLY_BUDGET, AUDD_PRICE_PER_1000, AUDD_PLAN_FEE, AUDD_PLAN_REQUESTS), app chặn mọi lượt quét tới khi sửa .env.');
  }
  return {
    amount: isValid ? amount : 0,
    planFee: isValid ? planFee : 0,
    planRequests: isValid ? planRequests : 0,
    pricePer1000: pricePer1000 ?? 1,
    currency,
    warnPercent: Number.isFinite(warn) && warn > 0 && warn <= 100 ? warn : DEFAULT_WARN_PERCENT,
  };
}

const MONTH_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit' });

/** Tháng theo giờ Việt Nam, dạng YYYY-MM. */
export function getBudgetMonth(now: Date = new Date()): string {
  return MONTH_FORMAT.format(now).slice(0, 7);
}

/** Ngày cuối của tháng YYYY-MM, dạng YYYY-MM-DD. */
export function getMonthEnd(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, '0')}`;
}

/** Số yêu cầu mà trần chi phí mua được: phần trong gói cộng phần vượt gói, làm tròn xuống. */
export function getBudgetRequests(config: BudgetConfig): number {
  if (config.amount <= 0 || config.amount < config.planFee) {
    return 0;
  }
  return config.planRequests + Math.floor(((config.amount - config.planFee) / config.pricePer1000) * 1000 + 1e-9);
}

const emptyLedger = (month: string): BudgetLedger => ({ month, charged: 0, byUser: {}, byKind: {} });

const isCountMap = (value: unknown) =>
  typeof value === 'object' && value !== null && Object.values(value).every((count) => typeof count === 'number' && Number.isFinite(count));

/** Sổ đúng định dạng của đúng tháng. Sai thì coi là hỏng, không bao giờ coi là sổ trống. */
const readLedger = (saved: BudgetLedger | null, month: string): BudgetLedger => {
  if (saved === null) {
    return emptyLedger(month);
  }
  if (saved.month !== month || typeof saved.charged !== 'number' || !Number.isFinite(saved.charged) || !isCountMap(saved.byUser) || !isCountMap(saved.byKind)) {
    throw new Error('Sổ chi sai định dạng');
  }
  return { month, charged: Math.max(0, saved.charged), byUser: { ...saved.byUser }, byKind: { ...saved.byKind } };
};

export function createMonthlyBudget(config: BudgetConfig, store: BudgetStore, getMonth: () => string = getBudgetMonth) {
  const budgetRequests = getBudgetRequests(config);
  let ledger: BudgetLedger | null = null;
  let held = 0;
  /** Tháng có sổ chi hỏng. Khi đó chặn mọi lượt quét và không ghi đè sổ, tới khi người quản trị sửa file. */
  let brokenMonth: string | null = null;

  const current = () => {
    const month = getMonth();
    // Sổ hỏng thì đọc lại mỗi lần, để sửa file xong là dùng được ngay, không cần khởi động lại.
    if (ledger?.month !== month || brokenMonth === month) {
      try {
        ledger = readLedger(store.readSync(month), month);
        brokenMonth = null;
      } catch {
        if (brokenMonth !== month) {
          console.error(`Sổ chi AudD tháng ${month} không đọc được, app chặn mọi lượt quét tới khi sửa file.`);
        }
        ledger = emptyLedger(month);
        brokenMonth = month;
      }
      held = 0;
    }
    return ledger;
  };

  const isBroken = () => current().month === brokenMonth;

  const add = (book: BudgetLedger, user: string, kind: BudgetKind, requests: number) => {
    if (book.month === brokenMonth) {
      return;
    }
    book.charged = Math.max(0, book.charged + requests);
    book.byUser[user] = Math.max(0, (book.byUser[user] ?? 0) + requests);
    book.byKind[kind] = Math.max(0, (book.byKind[kind] ?? 0) + requests);
    void store.write(book);
  };

  return {
    /** Giữ chỗ từng ấy yêu cầu. Không đủ thì trả về null và không giữ gì. */
    isBroken,

    reserve(user: string, kind: BudgetKind, requests: number): BudgetHold | null {
      const book = current();
      const count = Math.max(0, Math.ceil(requests));
      if (isBroken() || book.charged + count > budgetRequests) {
        return null;
      }
      add(book, user, kind, count);
      held += count;
      return { month: book.month, user, kind, requests: count, isSettled: false };
    },

    /** Lượt quét xong: tính theo số yêu cầu đã gửi thật, trả lại phần thừa. Gọi lần hai không làm gì. */
    settle(hold: BudgetHold | null, usedRequests: number): void {
      if (!hold || hold.isSettled) {
        return;
      }
      hold.isSettled = true;
      const book = current();
      // Qua tháng mới thì sổ tháng cũ đã đóng, phần giữ chỗ coi như đã chi.
      if (book.month !== hold.month) {
        return;
      }
      held = Math.max(0, held - hold.requests);
      const refund = hold.requests - Math.min(hold.requests, Math.max(0, Math.ceil(usedRequests)));
      if (refund > 0) {
        add(book, hold.user, hold.kind, -refund);
      }
    },

    remaining(): number {
      return isBroken() ? 0 : Math.max(0, budgetRequests - current().charged);
    },

    view(): BudgetView {
      const book = current();
      const sorted = <K extends string>(entries: [K, number | undefined][]) =>
        entries.filter(([, requests]) => (requests ?? 0) > 0).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0)) as [K, number][];
      return {
        month: book.month,
        monthEnd: getMonthEnd(book.month),
        currency: config.currency,
        amount: config.amount,
        planFee: config.planFee,
        planRequests: config.planRequests,
        pricePer1000: config.pricePer1000,
        warnPercent: config.warnPercent,
        budgetRequests,
        chargedRequests: book.charged,
        heldRequests: Math.min(held, book.charged),
        byUser: sorted(Object.entries(book.byUser)).map(([user, requests]) => ({ user, requests })),
        byKind: sorted(Object.entries(book.byKind) as [BudgetKind, number][]).map(([kind, requests]) => ({ kind, requests })),
        ...(isBroken() ? { isBroken: true } : {}),
      };
    },
  };
}

export type MonthlyBudget = ReturnType<typeof createMonthlyBudget>;
