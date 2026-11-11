import { describe, expect, it } from 'vitest';
import {
  budgetPercent,
  budgetRefusal,
  budgetDaysLeft,
  budgetResetDay,
  budgetState,
  extraCost,
  includedLeft,
  monthCost,
  remainingMoney,
  formatBudgetRange,
  formatMoney,
  remainingBudgetRequests,
  requestsForSeconds,
  spentRequests,
} from './budget';
import type { BudgetView } from './budget';

const view = (charged: number, held = 0): BudgetView => ({
  month: '2026-11',
  monthEnd: '2026-11-30',
  currency: 'USD',
  amount: 100,
  planFee: 0,
  planRequests: 0,
  pricePer1000: 5,
  warnPercent: 80,
  budgetRequests: 20_000,
  chargedRequests: charged,
  heldRequests: held,
  byUser: [],
  byKind: [],
});

describe('requestsForSeconds', () => {
  it('làm tròn lên theo đoạn 12 giây', () => {
    expect(requestsForSeconds(12, 3600)).toBe(1);
    expect(requestsForSeconds(13, 3600)).toBe(2);
    expect(requestsForSeconds(1080, 3600)).toBe(90);
  });

  it('không vượt trần mỗi lần quét, chưa biết độ dài thì tính trần', () => {
    expect(requestsForSeconds(7200, 3600)).toBe(300);
    expect(requestsForSeconds(0, 3600)).toBe(300);
  });

  it('trần sai (0 hay âm) thì tính theo 60 phút, không ghi thiếu', () => {
    expect(requestsForSeconds(600, 0)).toBe(50);
    expect(requestsForSeconds(0, -12)).toBe(300);
  });

  it('nội dung rất ngắn vẫn tốn ít nhất 1 yêu cầu', () => {
    expect(requestsForSeconds(0.5, 3600)).toBe(1);
  });
});

// Gói 5 USD gồm 1.000 yêu cầu, vượt gói 5 USD cho 1.000, ngân sách 20 USD là 4.000 yêu cầu.
const plan = (charged: number, held = 0): BudgetView => ({ ...view(charged, held), amount: 20, planFee: 5, planRequests: 1000, budgetRequests: 4000 });

describe('tính tiền theo gói', () => {
  it('phí gói tính cả khi chưa quét, phần trong gói không tốn thêm', () => {
    expect(monthCost(0, plan(0))).toBe(5);
    expect(monthCost(1000, plan(0))).toBe(5);
    expect(monthCost(1850, plan(0))).toBeCloseTo(9.25);
    expect(monthCost(4000, plan(0))).toBeCloseTo(20);
  });

  it('không có gói thì tính đều theo giá', () => {
    expect(monthCost(1260, view(0))).toBeCloseTo(6.3);
  });

  it('chi phí thêm của một lượt quét tính từ số đã dùng', () => {
    expect(extraCost(90, plan(500))).toBe(0);
    expect(extraCost(90, plan(950))).toBeCloseTo(0.2);
    expect(extraCost(90, plan(1850))).toBeCloseTo(0.45);
  });

  it('tiền còn lại và số yêu cầu còn trong gói', () => {
    expect(remainingMoney(plan(0))).toBe(15);
    expect(remainingMoney(plan(1850))).toBeCloseTo(10.75);
    expect(includedLeft(plan(300))).toBe(700);
    expect(includedLeft(plan(1850))).toBe(0);
  });
});

describe('formatMoney', () => {

  it('viết tiền theo kiểu Việt Nam, hai chữ số lẻ', () => {
    expect(formatMoney(6.3, 'USD')).toBe('6,30 USD');
    expect(formatMoney(1234.5, 'USD')).toBe('1.234,50 USD');
  });
});

describe('budgetState', () => {
  it('chưa tới ngưỡng cảnh báo là còn đủ', () => {
    expect(budgetState(view(8_400))).toBe('ok');
  });

  it('từ ngưỡng cảnh báo trở lên là sắp chạm trần', () => {
    expect(budgetState(view(16_000))).toBe('warn');
  });

  it('hết yêu cầu là đã chạm trần', () => {
    expect(budgetState(view(20_000))).toBe('full');
  });

  it('sổ chi hỏng là đã chạm trần, không còn yêu cầu nào', () => {
    expect(budgetState({ ...view(0), isBroken: true })).toBe('full');
    expect(remainingBudgetRequests({ ...view(0), isBroken: true })).toBe(0);
  });

  it('ngân sách 0 vì cấu hình sai là đã chạm trần', () => {
    expect(budgetState({ ...view(0), budgetRequests: 0 })).toBe('full');
  });
});

describe('số còn lại và đã chi', () => {
  it('phần giữ chỗ tính vào số đã dùng nhưng chưa tính là đã chi', () => {
    const current = view(9_000, 600);
    expect(remainingBudgetRequests(current)).toBe(11_000);
    expect(spentRequests(current)).toBe(8_400);
  });

  it('không ra số âm khi đã tính vượt trần', () => {
    expect(remainingBudgetRequests(view(21_000))).toBe(0);
  });

  it('phần trăm nằm trong 0 đến 100', () => {
    expect(budgetPercent(8_400, view(0))).toBe(42);
    expect(budgetPercent(30_000, view(0))).toBe(100);
  });
});

describe('ngày của tháng ngân sách', () => {
  it('viết khoảng ngày của tháng', () => {
    expect(formatBudgetRange(view(0))).toBe('01/11 đến 30/11/2026');
  });

  it('đếm ngày còn lại theo giờ Việt Nam, tính cả hôm nay', () => {
    expect(budgetDaysLeft(view(0), new Date('2026-11-10T03:00:00Z'))).toBe(21);
    expect(budgetDaysLeft(view(0), new Date('2026-11-30T16:00:00Z'))).toBe(1);
    expect(budgetDaysLeft(view(0), new Date('2026-12-01T01:00:00Z'))).toBe(0);
  });

  it('ngày làm mới là đầu tháng sau, tháng 12 thì sang năm mới', () => {
    expect(budgetResetDay(view(0))).toBe('01/12');
    expect(budgetResetDay({ ...view(0), month: '2026-12', monthEnd: '2026-12-31' })).toBe('01/01/2027');
  });
});

describe('budgetRefusal', () => {
  it('nói rõ cần bao nhiêu, còn bao nhiêu và cách xử lý', () => {
    const text = budgetRefusal(1260, view(19_000));
    expect(text).toContain('1260 yêu cầu AudD (6,30 USD)');
    expect(text).toContain('còn 1000 yêu cầu (5,00 USD)');
    expect(budgetRefusal(90, plan(3960))).toContain('90 yêu cầu AudD (0,45 USD), nhưng ngân sách tháng chỉ còn 40 yêu cầu (0,20 USD)');
    expect(text).toContain('AUDD_MONTHLY_BUDGET');
  });
});
