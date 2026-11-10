import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { LoaderCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { BudgetPanel } from './BudgetPanel';
import { costOfRequests, formatMoney, remainingBudgetRequests } from './budget';
import { Figure, Panel } from './components';
import { formatNumber as number } from './ui';
import { audioLeftText, daysLeft, formatQuotaDate, isQuotaLow, percentUsed } from './quota';
import type { QuotaAccount, QuotaResponse, QuotaStatus } from './quota';

const API = '/api/quota';
const REFRESH_MS = 5 * 60_000;

const PROBLEMS: Record<Exclude<QuotaStatus, 'ok'>, string> = {
  login: 'Máy chủ chưa đăng nhập tài khoản AudD nên chưa có số liệu. Người quản trị cần chạy audd login, xem README. Việc quét vẫn chạy bình thường.',
  missing: 'Máy chủ này chưa có công cụ audd nên chưa có số liệu. Bản chạy bằng Docker đã có sẵn. Việc quét vẫn chạy bình thường.',
  error: 'Chưa đọc được số liệu từ AudD. Việc quét vẫn chạy bình thường.',
};

function statePill(account: QuotaAccount | undefined): { className: string; label: string } {
  if (!account) {
    return { className: 'bg-rose-50 text-rose-800 ring-rose-200', label: 'Không có số liệu' };
  }
  if (account.remaining === 0) {
    return { className: 'bg-rose-50 text-rose-800 ring-rose-200', label: 'Đã hết' };
  }
  return isQuotaLow(account)
    ? { className: 'bg-amber-50 text-amber-800 ring-amber-200', label: 'Sắp hết' }
    : { className: 'bg-emerald-50 text-emerald-800 ring-emerald-200', label: 'Còn đủ' };
}

function cycleText(account: QuotaAccount): string {
  const start = formatQuotaDate(account.cycleStart);
  const end = formatQuotaDate(account.cycleEnd);
  const left = daysLeft(account.cycleEnd, new Date());
  const range = start && end ? `Chu kỳ ${start} đến ${end}` : end ? `Hết chu kỳ ngày ${end}` : '';
  return left === null || !range ? range : `${range} · còn ${left} ngày`;
}

function LimitRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2.5 text-sm first:pt-0 last:pb-0">
      <span className="min-w-0 flex-[1_1_16rem] text-slate-600">{label}</span>
      <b className="font-semibold text-slate-900 tabular-nums">{children}</b>
    </div>
  );
}

export function QuotaTab() {
  const [data, setData] = useState<QuotaResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');

  const load = (refresh: boolean) => {
    setIsLoading(true);
    return fetch(`${API}${refresh ? '?refresh=1' : ''}`)
      .then((response) => (response.ok ? (response.json() as Promise<QuotaResponse>) : Promise.reject(new Error())))
      .then((next) => {
        setData(next);
        setMessage('');
      })
      .catch(() => setMessage('Không gọi được máy chủ.'))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    void load(false);
    const timer = setInterval(() => void load(false), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const account = data?.status === 'ok' ? data.account : undefined;
  const percent = account ? percentUsed(account) : 0;
  const pill = statePill(account);
  const problem = data && data.status !== 'ok' ? PROBLEMS[data.status] : '';
  const fetchedAt = data ? new Date(data.fetchedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="grid gap-6">
      {data?.budget && <BudgetPanel view={data.budget} />}
      <Panel className="space-y-5 p-5" aria-live="polite">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-[1_1_16rem]">
            <p className="text-xs font-medium text-slate-500">Gói đang dùng</p>
            <p className="text-[22px] font-bold text-slate-900">{account ? account.planName || 'Chưa có gói trả phí' : data ? 'Chưa đọc được' : 'Đang đọc'}</p>
            {account && cycleText(account) && <p className="text-sm text-slate-500 tabular-nums">{cycleText(account)}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data && <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${pill.className}`}>{pill.label}</span>}
            <button
              type="button"
              disabled={isLoading}
              onClick={() => void load(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-800 hover:bg-brand-50 disabled:opacity-60"
            >
              {isLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Cập nhật
            </button>
          </div>
        </div>

        {(problem || message) && (
          <p className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {message || problem}
          </p>
        )}
        {account && account.remaining > 0 && isQuotaLow(account) && (
          <p className="rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">Sắp hết yêu cầu AudD. Quét cả kênh hoặc video dài có thể không đủ lượt.</p>
        )}

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <Figure label="Tổng gói" value={account ? number(account.total) : '—'} hint={account?.cycleEnd ? 'yêu cầu mỗi chu kỳ' : 'yêu cầu được cấp'} />
          <Figure label="Đã dùng" value={account ? number(account.used) : '—'} hint={account ? `${percent}% của gói` : ''} />
          <Figure label="Còn lại" value={account ? number(account.remaining) : '—'} hint={account ? audioLeftText(account.remaining) : ''} isMain />
        </div>

        <div className="grid gap-1.5">
          <div className="h-2.5 overflow-hidden rounded-full bg-brand-50" role="img" aria-label={account ? `Đã dùng ${percent}% gói` : 'Chưa có số liệu'}>
            <div
              className={`h-full rounded-full transition-all ${account && isQuotaLow(account) ? 'bg-amber-600' : 'bg-linear-to-r from-brand-400 to-brand-600'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex flex-wrap justify-between gap-x-3 text-xs text-slate-500 tabular-nums">
            <span>{account ? `Đã dùng ${percent}%` : ''}</span>
            <span>{fetchedAt && `Cập nhật lúc ${fetchedAt}`}</span>
          </div>
        </div>

        <p className="text-xs text-slate-500">AudD tính 1 yêu cầu cho mỗi 12 giây âm thanh. Số liệu tính cho cả tài khoản, gồm mọi người dùng chung khóa.</p>
      </Panel>

      {data && (
        <Panel className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-slate-900">Giới hạn trong app</h2>
          <div className="divide-y divide-slate-200">
            {data.budget && (
              <LimitRow label="Ngân sách còn lại tháng này (chung cả app)">
                {formatMoney(costOfRequests(remainingBudgetRequests(data.budget), data.budget.pricePer1000), data.budget.currency)} /{' '}
                {formatMoney(data.budget.amount, data.budget.currency)}
              </LimitRow>
            )}
            <LimitRow label="Lượt quét còn lại hôm nay của bạn">
              {number(data.remainingScans)} / {number(data.dailyLimit)}
            </LimitRow>
            <LimitRow label="Trần mỗi lần quét cả kênh">{number(data.maxChannelRequests)} yêu cầu</LimitRow>
            <LimitRow label="Yêu cầu quét kênh còn lại hôm nay của bạn">
              {number(data.remainingChannelRequests)} / {number(data.dailyChannelRequests)}
            </LimitRow>
          </div>
        </Panel>
      )}
    </div>
  );
}
