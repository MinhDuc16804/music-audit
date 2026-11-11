import { describe, expect, it, vi } from 'vitest';
import { createMonthlyBudget, getBudgetMonth, getBudgetRequests, getMonthEnd, parseBudgetConfig } from './monthlyBudget.ts';
import type { BudgetConfig, BudgetLedger } from './monthlyBudget.ts';

const CONFIG: BudgetConfig = { amount: 1, planFee: 0, planRequests: 0, pricePer1000: 5, currency: 'USD', warnPercent: 80 }; // 200 yêu cầu

function memoryStore(saved: BudgetLedger | null = null) {
  const files = new Map<string, BudgetLedger>(saved ? [[saved.month, saved]] : []);
  return {
    files,
    readSync: vi.fn((month: string) => files.get(month) ?? null),
    write: vi.fn((ledger: BudgetLedger) => {
      files.set(ledger.month, JSON.parse(JSON.stringify(ledger)) as BudgetLedger);
    }),
  };
}

describe('parseBudgetConfig', () => {
  it('để trống ngân sách thì tắt', () => {
    expect(parseBudgetConfig({})).toBeNull();
    expect(parseBudgetConfig({ AUDD_MONTHLY_BUDGET: '  ', AUDD_PRICE_PER_1000: '5' })).toBeNull();
  });

  it('đọc đủ các biến, có mặc định cho đơn vị tiền và ngưỡng cảnh báo', () => {
    expect(parseBudgetConfig({ AUDD_MONTHLY_BUDGET: '100', AUDD_PRICE_PER_1000: '5' })).toEqual({
      amount: 100,
      planFee: 0,
      planRequests: 0,
      pricePer1000: 5,
      currency: 'USD',
      warnPercent: 80,
    });
    expect(
      parseBudgetConfig({ AUDD_MONTHLY_BUDGET: '2500000', AUDD_PRICE_PER_1000: '125000', AUDD_BUDGET_CURRENCY: 'VND', AUDD_BUDGET_WARN_PERCENT: '90' }),
    ).toMatchObject({ currency: 'VND', warnPercent: 90 });
  });

  it('đặt ngân sách mà sai hoặc thiếu giá thì ngân sách là 0 để chặn hết', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseBudgetConfig({ AUDD_MONTHLY_BUDGET: 'abc', AUDD_PRICE_PER_1000: '5' })?.amount).toBe(0);
    expect(parseBudgetConfig({ AUDD_MONTHLY_BUDGET: '100' })?.amount).toBe(0);
    expect(parseBudgetConfig({ AUDD_MONTHLY_BUDGET: '20', AUDD_PRICE_PER_1000: '5', AUDD_PLAN_REQUESTS: '1000.5' })?.amount).toBe(0);
    // Ngân sách thấp hơn phí gói thì không trả nổi gói.
    expect(parseBudgetConfig({ AUDD_MONTHLY_BUDGET: '3', AUDD_PRICE_PER_1000: '5', AUDD_PLAN_FEE: '5' })?.amount).toBe(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('ngày tháng', () => {
  it('tháng tính theo giờ Việt Nam', () => {
    expect(getBudgetMonth(new Date('2026-11-30T17:30:00Z'))).toBe('2026-12');
    expect(getBudgetMonth(new Date('2026-11-30T16:30:00Z'))).toBe('2026-11');
  });

  it('ngày cuối tháng, kể cả tháng 2 năm nhuận', () => {
    expect(getMonthEnd('2026-11')).toBe('2026-11-30');
    expect(getMonthEnd('2028-02')).toBe('2028-02-29');
  });

  it('số yêu cầu mua được làm tròn xuống', () => {
    expect(getBudgetRequests({ ...CONFIG, amount: 100 })).toBe(20_000);
    expect(getBudgetRequests({ ...CONFIG, amount: 0.012 })).toBe(2);
  });

  it('đọc gói AudD: phí gói, số yêu cầu được cấp, giá phần vượt', () => {
    const config = parseBudgetConfig({ AUDD_MONTHLY_BUDGET: '20', AUDD_PLAN_FEE: '5', AUDD_PLAN_REQUESTS: '1000', AUDD_PRICE_PER_1000: '5' });
    expect(config).toMatchObject({ amount: 20, planFee: 5, planRequests: 1000, pricePer1000: 5 });
  });

  it('ngân sách theo gói: phần trong gói cộng phần vượt gói', () => {
    const plan = { ...CONFIG, planFee: 5, planRequests: 1000 };
    expect(getBudgetRequests({ ...plan, amount: 20 })).toBe(4_000);
    expect(getBudgetRequests({ ...plan, amount: 5 })).toBe(1_000);
    expect(getBudgetRequests({ ...plan, amount: 200 })).toBe(40_000);
    expect(getBudgetRequests({ ...CONFIG, amount: 450, planFee: 450, planRequests: 100_000, pricePer1000: 4.5 })).toBe(100_000);
    expect(getBudgetRequests({ ...CONFIG, amount: 900, planFee: 850, planRequests: 200_000, pricePer1000: 4.25 })).toBe(211_764);
  });
});

describe('createMonthlyBudget', () => {
  it('giữ chỗ được thì trừ vào số còn lại và lưu sổ', () => {
    const store = memoryStore();
    const budget = createMonthlyBudget(CONFIG, store, () => '2026-11');
    expect(budget.reserve('a@vi-du.vn', 'link', 90)).not.toBeNull();
    expect(budget.remaining()).toBe(110);
    expect(store.files.get('2026-11')).toMatchObject({ charged: 90, byUser: { 'a@vi-du.vn': 90 }, byKind: { link: 90 } });
  });

  it('không đủ thì từ chối và không giữ gì', () => {
    const budget = createMonthlyBudget(CONFIG, memoryStore(), () => '2026-11');
    budget.reserve('a', 'channel', 150);
    expect(budget.reserve('b', 'link', 51)).toBeNull();
    expect(budget.remaining()).toBe(50);
    expect(budget.reserve('b', 'link', 50)).not.toBeNull();
  });

  it('quét xong trả lại phần thừa, phần giữ chỗ về 0', () => {
    const budget = createMonthlyBudget(CONFIG, memoryStore(), () => '2026-11');
    const hold = budget.reserve('a', 'file', 100);
    expect(budget.view().heldRequests).toBe(100);
    budget.settle(hold, 30);
    expect(budget.view()).toMatchObject({ chargedRequests: 30, heldRequests: 0, byUser: [{ user: 'a', requests: 30 }] });
  });

  it('gọi settle hai lần không trả lại hai lần', () => {
    const budget = createMonthlyBudget(CONFIG, memoryStore(), () => '2026-11');
    const hold = budget.reserve('a', 'link', 100);
    budget.settle(hold, 0);
    budget.settle(hold, 0);
    expect(budget.view().chargedRequests).toBe(0);
  });

  it('dùng nhiều hơn số giữ chỗ thì không tính thêm', () => {
    const budget = createMonthlyBudget(CONFIG, memoryStore(), () => '2026-11');
    budget.settle(budget.reserve('a', 'link', 10), 50);
    expect(budget.view().chargedRequests).toBe(10);
  });

  it('khởi động lại thì đọc sổ đã lưu của tháng này', () => {
    const store = memoryStore({ month: '2026-11', charged: 120, byUser: { a: 120 }, byKind: { channel: 120 } });
    const budget = createMonthlyBudget(CONFIG, store, () => '2026-11');
    expect(budget.remaining()).toBe(80);
    expect(budget.view().byKind).toEqual([{ kind: 'channel', requests: 120 }]);
  });

  it('sang tháng mới thì sổ mới, giữ chỗ của tháng cũ không trả vào tháng mới', () => {
    let month = '2026-11';
    const budget = createMonthlyBudget(CONFIG, memoryStore(), () => month);
    const hold = budget.reserve('a', 'link', 150);
    month = '2026-12';
    expect(budget.remaining()).toBe(200);
    budget.settle(hold, 0);
    expect(budget.view()).toMatchObject({ month: '2026-12', chargedRequests: 0, heldRequests: 0 });
  });

  it('xếp người dùng và kiểu quét theo số yêu cầu giảm dần', () => {
    const budget = createMonthlyBudget(CONFIG, memoryStore(), () => '2026-11');
    budget.reserve('a', 'link', 10);
    budget.reserve('b', 'channel', 60);
    budget.reserve('c', 'batch', 30);
    const { byUser, byKind } = budget.view();
    expect(byUser.map(({ user }) => user)).toEqual(['b', 'c', 'a']);
    expect(byKind.map(({ kind }) => kind)).toEqual(['channel', 'batch', 'link']);
  });

  it('ngân sách 0 thì chặn mọi lượt quét', () => {
    const budget = createMonthlyBudget({ ...CONFIG, amount: 0 }, memoryStore(), () => '2026-11');
    expect(budget.reserve('a', 'link', 1)).toBeNull();
  });
});
