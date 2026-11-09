import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Ban, Clock, Download, Info, ListVideo, LoaderCircle, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, Video } from 'lucide-react';
import type { AudioLibraryIndex } from './audioLibrary';
import { buildBatchCsv, estimateAuddRequests, formatDuration, MAX_BATCH_VIDEOS, parseBatchLinks } from './batchScan';
import type { Batch, BatchCurrentResponse, BatchEstimateResponse, BatchItem } from './batchScan';
import { IconBadge, Panel, SoundBars, TrackList } from './components';
import { getVideoVerdict } from './videoCheck';
import type { VideoVerdict, VideoVerdictKind } from './videoCheck';

const BATCH_API = '/api/batches';
const POLL_INTERVAL_MS = 3000;
const ESTIMATE_DELAY_MS = 500;
const SMALL_BUTTON = 'rounded-xl border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-800 hover:bg-brand-50';
const PILL = 'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset';
const PILL_SLATE = 'bg-slate-100 text-slate-600 ring-slate-200';

const VERDICT_DISPLAY: Record<VideoVerdictKind, { label: string; pill: string; icon: ReactNode; tileIcon: ReactNode }> = {
  allowed: {
    label: 'Được dùng',
    pill: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    icon: <ShieldCheck className="h-4 w-4" />,
    tileIcon: <ShieldCheck className="h-3.5 w-3.5 text-emerald-700" />,
  },
  review: {
    label: 'Cần người duyệt',
    pill: 'bg-amber-50 text-amber-800 ring-amber-200',
    icon: <ShieldQuestion className="h-4 w-4" />,
    tileIcon: <ShieldQuestion className="h-3.5 w-3.5 text-amber-700" />,
  },
  blocked: {
    label: 'Không được dùng',
    pill: 'bg-rose-50 text-rose-800 ring-rose-200',
    icon: <ShieldX className="h-4 w-4" />,
    tileIcon: <ShieldX className="h-3.5 w-3.5 text-rose-700" />,
  },
  error: {
    label: 'Chưa có kết luận',
    pill: PILL_SLATE,
    icon: <ShieldAlert className="h-4 w-4" />,
    tileIcon: <ShieldAlert className="h-3.5 w-3.5 text-slate-500" />,
  },
};
const VERDICT_KINDS = Object.keys(VERDICT_DISPLAY) as VideoVerdictKind[];

const BATCH_TITLES: Record<Batch['status'], string> = {
  running: 'Đang quét lô',
  paused: 'Lô đang tạm dừng',
  done: 'Đã quét xong lô',
};

async function readBatchResponse<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || payload === null) {
    throw new Error((payload as { error?: string } | null)?.error ?? 'Không gọi được máy chủ.');
  }
  return payload as T;
}

function postBatch<T>(path: string, body: unknown = {}): Promise<T> {
  return fetch(`${BATCH_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => readBatchResponse<T>(response));
}

function getItemKind(item: BatchItem, verdict: VideoVerdict | undefined): VideoVerdictKind | null {
  if (item.status === 'error') {
    return 'error';
  }
  return item.status === 'done' ? (verdict?.kind ?? 'error') : null;
}

function getItemMeta(item: BatchItem): string {
  const duration = item.result?.duration_seconds ?? 0;
  const maxSeconds = item.result?.max_seconds ?? 0;
  const parts = [
    duration > 0 ? formatDuration(duration) : '',
    item.cached ? 'Kết quả cũ, không tốn lượt' : item.result ? `${estimateAuddRequests(duration, maxSeconds || undefined)} yêu cầu AudD` : '',
    item.result?.tracks?.length ? `${item.result.tracks.length} bài nhận ra` : '',
    maxSeconds > 0 && duration > maxSeconds ? `Chỉ quét ${Math.round(maxSeconds / 60)} phút đầu` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

function StatusPill({ item, kind }: { item: BatchItem; kind: VideoVerdictKind | null }) {
  if (kind) {
    return (
      <span className={`${PILL} ${VERDICT_DISPLAY[kind].pill}`}>
        {VERDICT_DISPLAY[kind].icon}
        {VERDICT_DISPLAY[kind].label}
      </span>
    );
  }
  if (item.status === 'running') {
    return (
      <span className={`${PILL} bg-brand-50 text-brand-800 ring-brand-200`}>
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Đang quét
      </span>
    );
  }
  return (
    <span className={`${PILL} ${PILL_SLATE}`}>
      {item.status === 'cancelled' ? <Ban className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
      {item.status === 'cancelled' ? 'Đã hủy' : 'Đang chờ'}
    </span>
  );
}

function BatchRow({ item, verdict, onRetry }: { item: BatchItem; verdict?: VideoVerdict; onRetry: (videoId: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const meta = getItemMeta(item);
  const canOpen = item.status === 'done' && Boolean(verdict);

  return (
    <li className="px-5 py-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
        <div className="flex min-w-0 gap-3 text-sm">
          <IconBadge>
            <Video className="h-4 w-4" />
          </IconBadge>
          <div className="min-w-0">
            <a href={item.url} target="_blank" rel="noreferrer" className="break-all font-medium text-slate-800 hover:underline">
              {item.url}
            </a>
            {meta && <p className="text-xs text-slate-500">{meta}</p>}
            {item.error && <p className="mt-0.5 text-xs text-amber-800">{item.error}</p>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <StatusPill item={item} kind={getItemKind(item, verdict)} />
          {canOpen && (
            <button type="button" aria-expanded={isOpen} onClick={() => setIsOpen(!isOpen)} className={SMALL_BUTTON}>
              {isOpen ? 'Thu gọn' : 'Chi tiết'}
            </button>
          )}
          {item.status === 'error' && (
            <button type="button" onClick={() => onRetry(item.videoId)} className={SMALL_BUTTON}>
              Quét lại
            </button>
          )}
        </div>
      </div>
      {canOpen && isOpen && verdict && (
        <div className="mt-2.5 rounded-xl bg-slate-50 p-3">
          <p className="text-sm text-slate-600">{verdict.detail}</p>
          {verdict.tracks.length > 0 && (
            <div className="mt-2">
              <TrackList tracks={verdict.tracks} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function downloadCsv(batch: Batch, verdicts: Map<string, VideoVerdict>) {
  const rows = batch.items
    .filter(({ status }) => status === 'done' || status === 'error')
    .map((item) => {
      const verdict = verdicts.get(item.videoId);
      return {
        url: item.url,
        verdict: VERDICT_DISPLAY[getItemKind(item, verdict) ?? 'error'].label,
        detail: item.error ?? verdict?.detail ?? '',
        durationSeconds: item.result?.duration_seconds ?? 0,
        tracks: verdict?.tracks.map(({ track }) => `${track.title} - ${track.artists}`) ?? [],
      };
    });
  // BOM để Excel đọc đúng tiếng Việt.
  const url = URL.createObjectURL(new Blob([`﻿${buildBatchCsv(rows)}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `quet-hang-loat-${batch.createdAt.slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function BatchResult({
  batch,
  libraryIndex,
  onAction,
}: {
  batch: Batch;
  libraryIndex: AudioLibraryIndex;
  onAction: (path: string) => void;
}) {
  const [filter, setFilter] = useState<VideoVerdictKind | 'all'>('all');

  const verdicts = useMemo(
    () =>
      new Map(
        batch.items.flatMap((item) => (item.result ? [[item.videoId, getVideoVerdict(item.result, libraryIndex)] as const] : [])),
      ),
    [batch, libraryIndex],
  );

  const kindOf = (item: BatchItem) => getItemKind(item, verdicts.get(item.videoId));
  const active = batch.items.filter(({ status }) => status !== 'cancelled');
  const finished = active.filter((item) => kindOf(item) !== null);
  const shown = batch.items.filter((item) => filter === 'all' || kindOf(item) === filter);
  const hasQueued = batch.items.some(({ status }) => status === 'queued');

  return (
    <Panel className="divide-y divide-brand-100 overflow-hidden">
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
          <div aria-live="polite">
            <h3 className="text-xl font-bold text-slate-900">{BATCH_TITLES[batch.status]}</h3>
            <p className="text-sm text-slate-500">
              {finished.length} / {active.length} video đã có kết quả.{batch.status === 'running' && ' Có thể đóng tab, lô vẫn chạy tiếp.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {batch.status === 'paused' && (
              <button type="button" onClick={() => onAction(`/${batch.id}/resume`)} className={SMALL_BUTTON}>
                Chạy tiếp
              </button>
            )}
            {hasQueued && (
              <button type="button" onClick={() => onAction(`/${batch.id}/cancel`)} className={SMALL_BUTTON}>
                Hủy phần chưa quét
              </button>
            )}
            <button
              type="button"
              disabled={finished.length === 0}
              onClick={() => downloadCsv(batch, verdicts)}
              className={`${SMALL_BUTTON} inline-flex items-center gap-1 disabled:opacity-60`}
            >
              <Download className="h-3.5 w-3.5" />
              Xuất CSV
            </button>
          </div>
        </div>

        <div className="h-2 overflow-hidden rounded-full bg-brand-50">
          <div
            className="h-full rounded-full bg-linear-to-r from-brand-400 to-brand-600 transition-all"
            style={{ width: `${active.length ? (finished.length / active.length) * 100 : 0}%` }}
          />
        </div>

        {batch.pauseReason && (
          <p className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            Lô đã tạm dừng để không tốn lượt. {batch.pauseReason} Các video chưa quét vẫn được giữ lại.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {VERDICT_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={filter === kind}
              onClick={() => setFilter(filter === kind ? 'all' : kind)}
              className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left ${
                filter === kind ? 'border-brand-700 bg-brand-50' : 'border-brand-100 bg-white hover:border-brand-300'
              }`}
            >
              <strong className="text-xl font-bold text-slate-900 tabular-nums">{finished.filter((item) => kindOf(item) === kind).length}</strong>
              <span className="flex items-center gap-1 text-xs font-medium text-slate-600">
                {VERDICT_DISPLAY[kind].tileIcon}
                {VERDICT_DISPLAY[kind].label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <ul className="divide-y divide-slate-100">
        {shown.map((item) => (
          <BatchRow
            key={item.videoId}
            item={item}
            verdict={verdicts.get(item.videoId)}
            onRetry={(videoId) => onAction(`/${batch.id}/items/${videoId}/retry`)}
          />
        ))}
        {shown.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-500">Chưa có video nào ở mức này.</li>}
      </ul>

      <p className="flex gap-2 px-5 py-3 text-xs text-slate-500">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Danh sách thư viện không chính thức và có thể đã cũ. Kết quả quét không phải bằng chứng về bản quyền.
      </p>
    </Panel>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <b className="font-semibold text-slate-900 tabular-nums">{value}</b>
    </div>
  );
}

export function BatchTab({ libraryIndex, isLibraryReady }: { libraryIndex: AudioLibraryIndex; isLibraryReady: boolean }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<BatchCurrentResponse | null>(null);
  const [estimate, setEstimate] = useState<BatchEstimateResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  const parsed = useMemo(() => parseBatchLinks(text), [text]);
  const idsKey = parsed.videoIds.join(',');
  const batch = state?.batch ?? null;
  const isBatchActive = batch !== null && batch.status !== 'done';

  useEffect(() => {
    let isCancelled = false;
    const refresh = () =>
      fetch(`${BATCH_API}/current`)
        .then((response) => readBatchResponse<BatchCurrentResponse>(response))
        .then((next) => {
          if (!isCancelled) {
            setState(next);
          }
        })
        .catch(() => undefined);
    void refresh();
    const timer = batch?.status === 'running' ? setInterval(refresh, POLL_INTERVAL_MS) : undefined;
    return () => {
      isCancelled = true;
      clearInterval(timer);
    };
  }, [batch?.id, batch?.status]);

  useEffect(() => {
    setEstimate(null);
    const videoIds = idsKey ? idsKey.split(',') : [];
    if (videoIds.length === 0 || videoIds.length > MAX_BATCH_VIDEOS) {
      return undefined;
    }
    let isCancelled = false;
    const timer = setTimeout(() => {
      postBatch<BatchEstimateResponse>('/estimate', { videoIds })
        .then((next) => {
          if (!isCancelled) {
            setEstimate(next);
          }
        })
        .catch(() => undefined);
    }, ESTIMATE_DELAY_MS);
    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
    // Lô vừa xong thì các video trong đó đã có kết quả, nên phải ước tính lại.
  }, [idsKey, batch?.status]);

  const count = parsed.videoIds.length;
  const cachedCount = estimate?.videos.filter(({ cached }) => cached).length ?? 0;
  const neededScans = count - cachedCount;
  const uncached = estimate?.videos.filter(({ cached }) => !cached) ?? [];
  const requests = uncached.reduce((sum, { seconds }) => sum + estimateAuddRequests(seconds, estimate?.maxSeconds), 0);
  const hasUnknownLength = uncached.some(({ seconds }) => seconds === 0);
  const requestText = !estimate ? '...' : `${hasUnknownLength ? 'tối đa ' : ''}${requests.toLocaleString('vi-VN')}`;

  const problem = !isLibraryReady
    ? 'Chưa nạp được danh sách YouTube Audio Library nên chưa quét được.'
    : isBatchActive
      ? 'Lô hiện tại chưa xong. Hãy chờ hoặc hủy phần chưa quét.'
      : count > MAX_BATCH_VIDEOS
        ? `Mỗi lô tối đa ${MAX_BATCH_VIDEOS} video. Hãy bớt ${count - MAX_BATCH_VIDEOS} link.`
        : state && neededScans > state.remainingScans
          ? `Lô này cần ${neededScans} lượt nhưng hôm nay chỉ còn ${state.remainingScans} lượt.`
          : '';
  const skipped = [
    parsed.invalid > 0 ? `${parsed.invalid} dòng không phải link video` : '',
    parsed.duplicates > 0 ? `${parsed.duplicates} link trùng, đã bỏ` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const runAction = (request: Promise<BatchCurrentResponse>) => {
    setMessage('');
    return request.then(setState).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Không thực hiện được.'));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    await runAction(postBatch<BatchCurrentResponse>('', { videoIds: parsed.videoIds }));
    setIsSubmitting(false);
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Panel className="p-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Danh sách link YouTube
            <textarea
              value={text}
              spellCheck={false}
              placeholder="Mỗi dòng một link video"
              onChange={(event) => setText(event.target.value)}
              className="mt-1 block min-h-44 w-full resize-y rounded-xl border border-brand-200 bg-white px-3 py-2.5 font-mono text-xs font-normal leading-relaxed text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100"
            />
            <span className="mt-1 block text-xs font-normal text-slate-500">Mỗi dòng một link video công khai. Không nhận link kênh hay playlist.</span>
          </label>

          <div>
            <div className="grid gap-1.5 rounded-xl bg-brand-50 p-3 text-xs text-slate-600">
              <StatRow label="Video sẽ quét" value={`${count} / ${MAX_BATCH_VIDEOS}`} />
              <StatRow label="Yêu cầu AudD ước tính" value={count === 0 ? '0' : requestText} />
              <StatRow label={`Lượt sẽ dùng${cachedCount ? ` (${cachedCount} video đã có kết quả)` : ''}`} value={String(neededScans)} />
              <StatRow label="Lượt còn lại hôm nay" value={state ? `${state.remainingScans} / ${state.dailyLimit}` : '...'} />
            </div>
            {skipped && <p className="mt-2 text-xs text-amber-800">{skipped}</p>}
            {problem && <p className="mt-2 text-xs text-rose-700">{problem}</p>}
            {message && <p className="mt-2 text-xs text-rose-700">{message}</p>}
          </div>

          <button
            type="submit"
            disabled={count === 0 || Boolean(problem) || isSubmitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-brand-800 to-brand-700 px-3 py-2.5 text-sm font-semibold text-white shadow-card transition hover:from-brand-900 hover:to-brand-800 disabled:opacity-60"
          >
            {isSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ListVideo className="h-4 w-4" />}
            {`Quét ${count} video`}
          </button>
        </form>
      </Panel>

      {batch ? (
        <BatchResult key={batch.id} batch={batch} libraryIndex={libraryIndex} onAction={(path) => void runAction(postBatch<BatchCurrentResponse>(path))} />
      ) : (
        <Panel className="flex flex-col items-center px-6 py-16 text-center">
          <SoundBars className="h-12 w-28 text-brand-400" />
          <p className="mt-4 text-sm font-semibold text-slate-800">Chưa có lô nào</p>
          <p className="mt-1 text-sm text-slate-500">Dán danh sách link rồi bấm Quét. Kết quả từng video sẽ hiện ở đây.</p>
        </Panel>
      )}
    </div>
  );
}
