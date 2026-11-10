import { useEffect, useMemo, useState } from 'react';
import { Download, Info, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { AudioLibraryIndex } from './audioLibrary';
import { formatDuration } from './batchScan';
import { Panel, TrackList } from './components';
import { buildHistoryCsv, filterHistory, historyTitle, UNKNOWN_USER } from './history';
import type { HistoryEntry, HistoryKind, HistoryResponse } from './history';
import { getVideoVerdict } from './videoCheck';
import type { VideoVerdict, VideoVerdictKind } from './videoCheck';

const API = '/api/history';
const PAGE_SIZE = 10;
const KIND_LABELS: Record<HistoryKind | 'all', string> = { all: 'Tất cả', link: 'Một video', file: 'File', batch: 'Hàng loạt', channel: 'Cả kênh' };
const PILL = 'inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset';
const SMALL_BUTTON = 'rounded-xl border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-800 hover:bg-brand-50 disabled:opacity-60';
const VERDICT_STYLE: Record<VideoVerdictKind, { label: string; pill: string }> = {
  allowed: { label: 'Được dùng', pill: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  review: { label: 'Cần người duyệt', pill: 'bg-amber-50 text-amber-800 ring-amber-200' },
  blocked: { label: 'Không được dùng', pill: 'bg-rose-50 text-rose-800 ring-rose-200' },
  error: { label: 'Chưa có kết luận', pill: 'bg-slate-100 text-slate-600 ring-slate-200' },
};
const GREY = 'bg-slate-100 text-slate-600 ring-slate-200';
const TILE_KINDS: VideoVerdictKind[] = ['allowed', 'review', 'blocked'];

const number = (value: number) => value.toLocaleString('vi-VN');

function timeParts(value: string): { day: string; clock: string; full: string } {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  const day = days === 0 ? 'Hôm nay' : days === 1 ? 'Hôm qua' : `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return { day, clock, full: `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${clock}` };
}

function statusOf(entry: HistoryEntry, verdict: VideoVerdict | undefined): { label: string; pill: string } {
  if (entry.kind === 'channel') {
    return { label: 'Quét kênh', pill: 'bg-brand-50 text-brand-800 ring-brand-200' };
  }
  if (verdict) {
    return VERDICT_STYLE[verdict.kind];
  }
  return entry.outcome === 'error' ? { label: 'Quét lỗi', pill: GREY } : { label: 'Không còn kết quả', pill: GREY };
}

function personLabel(user: string, me: string): string {
  if (user === UNKNOWN_USER) {
    return 'Không rõ người quét';
  }
  return user === me ? 'Bạn' : user;
}

function HistoryRow({ entry, verdict, me }: { entry: HistoryEntry; verdict?: VideoVerdict; me: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const time = timeParts(entry.time);
  const status = statusOf(entry, verdict);
  const duration = entry.result?.duration_seconds ?? 0;
  const meta = [
    duration > 0 ? formatDuration(duration) : '',
    entry.channel ? `${number(entry.channel.videos)} video đã gửi · ${number(entry.channel.requests)} yêu cầu AudD` : '',
    verdict?.tracks.length ? `${verdict.tracks.length} bài nhận ra` : '',
  ].filter(Boolean).join(' · ');
  const link = entry.kind === 'file' ? '' : entry.channel?.url ?? entry.result?.url ?? entry.target;

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="w-24 shrink-0 text-xs leading-snug text-slate-500 tabular-nums" title={time.full}>
          <b className="block text-[13px] font-semibold text-slate-700">{time.day}</b>
          {time.clock}
        </div>
        <div className="min-w-0 flex-[1_1_16rem] text-sm">
          <p className="font-medium wrap-anywhere text-slate-800">{historyTitle(entry)}</p>
          {meta && <p className="text-xs text-slate-500 tabular-nums">{meta}</p>}
          <p className="text-xs text-slate-500">{personLabel(entry.user, me)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-800">{KIND_LABELS[entry.kind]}</span>
          <span className={`${PILL} ${status.pill}`}>{status.label}</span>
          <button type="button" aria-expanded={isOpen} onClick={() => setIsOpen(!isOpen)} className={SMALL_BUTTON}>
            {isOpen ? 'Thu gọn' : 'Chi tiết'}
          </button>
        </div>
      </div>
      {isOpen && (
        <div className="mt-2.5 grid gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-600 sm:ml-28">
          <p>
            {verdict
              ? verdict.detail
              : entry.kind === 'channel'
                ? 'Lần quét kênh này đã được xác nhận chi phí. Báo cáo chi tiết xem trong tab Quét cả kênh khi mở lại kênh.'
                : entry.outcome === 'error'
                  ? 'Lần quét này bị lỗi nên không có kết quả. Quét lại ở tab Kiểm tra nhạc.'
                  : 'Không còn tìm thấy kết quả đã lưu của lần quét này.'}
          </p>
          {verdict && verdict.tracks.length > 0 && <TrackList tracks={verdict.tracks} />}
          {link && (
            <a href={link} target="_blank" rel="noreferrer" className="w-fit text-xs font-medium text-brand-700 hover:underline">
              {entry.kind === 'channel' ? 'Mở kênh' : 'Mở video'}
            </a>
          )}
        </div>
      )}
    </li>
  );
}

function downloadCsv(rows: { entry: HistoryEntry; verdict?: VideoVerdict }[], me: string) {
  const csv = buildHistoryCsv(
    rows.map(({ entry, verdict }) => ({
      time: timeParts(entry.time).full,
      user: personLabel(entry.user, me),
      kind: KIND_LABELS[entry.kind],
      title: historyTitle(entry),
      target: entry.target,
      verdict: statusOf(entry, verdict).label,
      tracks: verdict?.tracks.map(({ track }) => `${track.title} - ${track.artists}`) ?? [],
    })),
  );
  // BOM để Excel đọc đúng tiếng Việt.
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `lich-su-quet-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function HistoryTab({ libraryIndex, isActive }: { libraryIndex: AudioLibraryIndex; isActive: boolean }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<HistoryKind | 'all'>('all');
  const [verdictFilter, setVerdictFilter] = useState<VideoVerdictKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [page, setPage] = useState(0);

  const load = () => {
    setIsLoading(true);
    fetch(API)
      .then((response) => (response.ok ? (response.json() as Promise<HistoryResponse>) : Promise.reject(new Error())))
      .then((next) => {
        setData(next);
        setMessage('');
      })
      .catch(() => setMessage('Không đọc được lịch sử quét. Hãy thử Cập nhật.'))
      .finally(() => setIsLoading(false));
  };

  // Đọc lại mỗi lần mở tab để thấy các lượt vừa quét ở tab khác.
  useEffect(() => {
    if (isActive) {
      load();
    }
  }, [isActive]);

  const me = data?.user ?? UNKNOWN_USER;
  const canFilterMine = me !== UNKNOWN_USER;
  const withVerdicts = useMemo(
    () => (data?.entries ?? []).map((entry) => ({ entry, verdict: entry.result?.status === 'done' ? getVideoVerdict(entry.result, libraryIndex) : undefined })),
    [data, libraryIndex],
  );
  const filtered = useMemo(() => {
    const kept = new Set(filterHistory(data?.entries ?? [], { kind, query, onlyUser: onlyMine && canFilterMine ? me : undefined }));
    return withVerdicts.filter(({ entry }) => kept.has(entry));
  }, [withVerdicts, data, kind, query, onlyMine, canFilterMine, me]);
  const shown = filtered.filter(({ verdict }) => verdictFilter === 'all' || verdict?.kind === verdictFilter);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const shownPage = Math.min(page, pages - 1);
  const start = shownPage * PAGE_SIZE;

  const resetPage = () => setPage(0);

  return (
    <Panel className="overflow-hidden">
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <button
            type="button"
            aria-pressed={verdictFilter === 'all'}
            onClick={() => {
              setVerdictFilter('all');
              resetPage();
            }}
            className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left ${verdictFilter === 'all' ? 'border-brand-700 bg-brand-50' : 'border-brand-100 bg-white hover:border-brand-300'}`}
          >
            <strong className="text-xl font-bold text-slate-900 tabular-nums">{number(filtered.length)}</strong>
            <span className="text-xs font-medium text-slate-600">Lần quét</span>
          </button>
          {TILE_KINDS.map((tile) => (
            <button
              key={tile}
              type="button"
              aria-pressed={verdictFilter === tile}
              onClick={() => {
                setVerdictFilter(verdictFilter === tile ? 'all' : tile);
                resetPage();
              }}
              className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left ${verdictFilter === tile ? 'border-brand-700 bg-brand-50' : 'border-brand-100 bg-white hover:border-brand-300'}`}
            >
              <strong className="text-xl font-bold text-slate-900 tabular-nums">{number(filtered.filter(({ verdict }) => verdict?.kind === tile).length)}</strong>
              <span className="text-xs font-medium text-slate-600">{VERDICT_STYLE[tile].label}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1 rounded-xl bg-brand-50 p-1" role="group" aria-label="Loại quét">
            {(Object.keys(KIND_LABELS) as (HistoryKind | 'all')[]).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={kind === id}
                onClick={() => {
                  setKind(id);
                  resetPage();
                }}
                className={`rounded-lg px-3 py-1 text-xs whitespace-nowrap text-brand-800 ${kind === id ? 'bg-white font-semibold shadow-sm' : 'font-medium'}`}
              >
                {KIND_LABELS[id]}
              </button>
            ))}
          </div>
          <label className="relative min-w-0 flex-[1_1_14rem]">
            <span className="sr-only">Tìm trong lịch sử</span>
            <Search className="absolute top-2 left-2.5 h-4 w-4 text-slate-400" />
            <input
              id="history-search"
              value={query}
              placeholder="Tìm tên video, tên file, link hoặc người quét"
              onChange={(event) => {
                setQuery(event.target.value);
                resetPage();
              }}
              className="w-full rounded-xl border border-brand-200 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100"
            />
          </label>
          <label className={`inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-slate-600 ${canFilterMine ? '' : 'opacity-55'}`} title={canFilterMine ? '' : 'Cần đặt app sau Cloudflare Access để biết ai quét'}>
            <input
              id="history-mine"
              type="checkbox"
              className="accent-brand-700"
              disabled={!canFilterMine}
              checked={onlyMine && canFilterMine}
              onChange={(event) => {
                setOnlyMine(event.target.checked);
                resetPage();
              }}
            />
            Chỉ lần quét của tôi
          </label>
          <button type="button" disabled={isLoading} onClick={load} className={`${SMALL_BUTTON} inline-flex items-center gap-1.5`}>
            {isLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Cập nhật
          </button>
        </div>
        {message && <p className="text-xs text-rose-700">{message}</p>}
      </div>

      <ul className="divide-y divide-slate-100 border-y border-slate-100">
        {shown.slice(start, start + PAGE_SIZE).map(({ entry, verdict }) => (
          <HistoryRow key={entry.id} entry={entry} verdict={verdict} me={me} />
        ))}
        {shown.length === 0 && (
          <li className="px-5 py-8 text-center text-sm text-slate-500">
            {!data ? 'Đang đọc lịch sử' : data.entries.length === 0 ? 'Chưa có lần quét nào. Kết quả quét ở các tab khác sẽ hiện ở đây.' : 'Không có lần quét nào khớp bộ lọc.'}
          </li>
        )}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs text-slate-500">
        <span className="tabular-nums">
          {number(shown.length)} lần quét · trang {shownPage + 1} / {number(pages)}
        </span>
        <span className="flex flex-wrap gap-2">
          <button type="button" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)} className={SMALL_BUTTON}>
            Trước
          </button>
          <button type="button" disabled={shownPage >= pages - 1} onClick={() => setPage(shownPage + 1)} className={SMALL_BUTTON}>
            Sau
          </button>
          <button type="button" disabled={shown.length === 0} onClick={() => downloadCsv(shown, me)} className={`${SMALL_BUTTON} inline-flex items-center gap-1`}>
            <Download className="h-3.5 w-3.5" />
            Tải CSV
          </button>
        </span>
      </div>

      <p className="flex gap-2 border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Lịch sử có từ khi app bắt đầu ghi nhật ký quét. Kết luận tính lại theo danh sách YouTube Audio Library hiện tại, nên có thể khác lúc quét nếu danh sách đã đổi. Xem lại kết quả không tốn lượt AudD.
      </p>
    </Panel>
  );
}
