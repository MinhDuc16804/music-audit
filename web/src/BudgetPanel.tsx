import { ShieldAlert } from 'lucide-react';
import {
  BUDGET_KIND_LABELS,
  budgetDaysLeft,
  budgetPercent,
  budgetResetDay,
  budgetState,
  formatBudgetRange,
  formatMoney,
  includedLeft,
  monthCost,
  remainingBudgetRequests,
  remainingMoney,
  spentRequests,
} from './budget';
import type { BudgetState, BudgetView } from './budget';
import { Figure, Panel } from './components';
import { audioLeftText } from './quota';
import { formatNumber as number } from './ui';

const PILLS: Record<BudgetState, { className: string; label: string }> = {
  ok: { className: 'bg-emerald-50 text-emerald-800 ring-emerald-200', label: 'Còn đủ' },
  warn: { className: 'bg-amber-50 text-amber-800 ring-amber-200', label: 'Sắp chạm trần' },
  full: { className: 'bg-rose-50 text-rose-800 ring-rose-200', label: 'Đã chạm trần' },
};

const BAR_COLORS: Record<BudgetState, string> = {
  ok: 'bg-linear-to-r from-brand-400 to-brand-600',
  warn: 'bg-amber-600',
  full: 'bg-rose-600',
};

/** Danh sách tên kèm số yêu cầu, phần trăm và thanh tỉ lệ nhỏ. Không quy ra tiền vì phí gói là chung cả công ty. */
function ShareList({ title, rows }: { title: string; rows: { label: string; requests: number }[] }) {
  const total = rows.reduce((sum, { requests }) => sum + requests, 0);
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">Chưa có lượt quét nào trong tháng.</p>
      ) : (
        <ul className="divide-y divide-slate-200">
          {rows.map(({ label, requests }) => (
            <li key={label} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 py-1.5 text-sm">
              <span className="min-w-0 break-all text-slate-700">{label}</span>
              <span className="text-xs text-slate-500 tabular-nums">{total ? Math.round((requests / total) * 100) : 0}%</span>
              <b className="min-w-16 text-right font-semibold text-slate-900 tabular-nums">{number(requests)} yc</b>
              <span className="col-span-3 h-1 overflow-hidden rounded-full bg-brand-50">
                <span className="block h-full rounded-full bg-brand-600" style={{ width: `${total ? Math.round((requests / total) * 100) : 0}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ngân sách AudD tháng này của cả app, nằm đầu tab Theo dõi hạn mức. */
export function BudgetPanel({ view, now = new Date() }: { view: BudgetView; now?: Date }) {
  const state = budgetState(view);
  const pill = PILLS[state];
  const money = (amount: number) => formatMoney(amount, view.currency);
  const spent = spentRequests(view);
  const left = remainingBudgetRequests(view);
  const spentMoney = monthCost(spent, view);
  const heldMoney = monthCost(view.chargedRequests, view) - spentMoney;
  const included = includedLeft(view);
  const spentPercent = budgetPercent(spent, view);
  const heldPercent = budgetPercent(view.heldRequests, view);
  const usedPercent = Math.floor(budgetPercent(view.chargedRequests, view));

  return (
    <Panel className="space-y-5 p-5" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_16rem]">
          <p className="text-xs font-medium text-slate-500">Ngân sách AudD tháng {view.month.slice(5)}/{view.month.slice(0, 4)}</p>
          <p className="text-[22px] font-bold text-slate-900 tabular-nums">
            {money(spentMoney)} / {money(view.amount)}
          </p>
          <p className="text-sm text-slate-500 tabular-nums">
            Tính theo giờ Việt Nam, từ {formatBudgetRange(view)} · còn {budgetDaysLeft(view, now)} ngày
          </p>
        </div>
        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${pill.className}`}>{pill.label}</span>
      </div>

      {state !== 'ok' && (
        <p className={`flex gap-2 rounded-xl px-3 py-2.5 text-sm ${state === 'full' ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-800'}`}>
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {view.isBroken
            ? `Sổ chi AudD tháng này (out/budget/${view.month}.json) không đọc được nên app tạm chặn mọi lượt quét. Nhờ người quản trị sửa hoặc khôi phục file.`
            : state === 'full'
            ? `Ngân sách tháng đã hết. Lượt quét mới bị từ chối tới ${budgetResetDay(view)}, hoặc tới khi người quản trị tăng AUDD_MONTHLY_BUDGET.`
            : `Đã dùng ${usedPercent}% ngân sách tháng. Còn ${money(remainingMoney(view))}, ${audioLeftText(left)}. Quét cả kênh lớn có thể bị từ chối.`}
        </p>
      )}

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <Figure label="Ngân sách tháng" value={number(view.amount)} hint={`${view.currency} · ${number(view.budgetRequests)} yêu cầu`} />
        <Figure
          label="Đã chi"
          value={money(spentMoney).replace(` ${view.currency}`, '')}
          hint={`${number(spent)} yêu cầu · ${view.planRequests > 0 ? (included > 0 ? `còn ${number(included)} trong gói` : 'đã hết phần trong gói') : `${Math.floor(spentPercent)}%`}`}
        />
        <Figure label="Còn lại" value={money(remainingMoney(view)).replace(` ${view.currency}`, '')} hint={`${number(left)} yêu cầu · ${audioLeftText(left)}`} isMain />
      </div>

      <div className="grid gap-1.5">
        <div className="relative h-2.5 rounded-full bg-brand-50" role="img" aria-label={`Đã chi ${Math.floor(spentPercent)}%, đang giữ chỗ ${Math.floor(heldPercent)}% ngân sách tháng`}>
          <div className={`absolute inset-y-0 left-0 rounded-full ${BAR_COLORS[state]}`} style={{ width: `${spentPercent}%` }} />
          {heldPercent > 0 && (
            <div
              className="absolute inset-y-0 rounded-r-full bg-[repeating-linear-gradient(45deg,var(--color-brand-200)_0_5px,white_5px_9px)]"
              style={{ left: `${spentPercent}%`, width: `${Math.min(heldPercent, 100 - spentPercent)}%` }}
            />
          )}
          <div className="absolute -inset-y-1 w-0.5 bg-amber-600" style={{ left: `${view.warnPercent}%` }} title={`Ngưỡng cảnh báo ${view.warnPercent}%`} />
        </div>
        <p className="flex flex-wrap justify-between gap-x-3 text-xs text-slate-500 tabular-nums">
          <span>
            Đã dùng {Math.floor(spentPercent)}% số yêu cầu{view.heldRequests > 0 && ` · đang giữ chỗ ${number(view.heldRequests)} yêu cầu (${money(heldMoney)}) cho lượt quét chưa xong`}
          </span>
          <span>Vạch cam: cảnh báo ở {view.warnPercent}%</span>
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <ShareList title="Theo người dùng" rows={view.byUser.map(({ user, requests }) => ({ label: user, requests }))} />
        <ShareList title="Theo kiểu quét" rows={view.byKind.map(({ kind, requests }) => ({ label: BUDGET_KIND_LABELS[kind], requests }))} />
      </div>

      <p className="text-xs text-slate-500">
        {view.planRequests > 0
          ? `Gói ${money(view.planFee)} mỗi tháng gồm ${number(view.planRequests)} yêu cầu, vượt gói ${money(view.pricePer1000)} cho 1.000 yêu cầu. Phí gói tính cả khi chưa quét. `
          : `Giá ${money(view.pricePer1000)} cho 1.000 yêu cầu. `}
        Kết quả đã lưu mở lại không tính tiền, Quét lại thì tính như lượt mới. Lượt quét lỗi giữ nguyên phần đã tính vì không biết AudD đã nhận bao nhiêu.
      </p>
    </Panel>
  );
}
