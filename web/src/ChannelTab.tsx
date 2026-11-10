import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ListVideo, LoaderCircle, Search, ShieldAlert, Tv, Video } from 'lucide-react';
import { formatDuration } from './batchScan';
import { budgetRefusal, costOfRequests, formatMoney, remainingBudgetRequests } from './budget';
import type { BudgetView } from './budget';
import { ChannelResult, PastScans } from './ChannelReport';
import { MAX_CLIPS, MIN_CLIPS, parseChannelInput, pickPrepared, searchChannelVideos, worstCaseRequests } from './channelScan';
import type { ChannelCurrentResponse, ChannelOptions, ChannelRequirements, ChannelScanView, ChannelStatus, ChannelVideo } from './channelScan';
import { IconBadge, Panel, SoundBars } from './components';
import { NotifySwitch, useScanNotice } from './NotifySwitch';
import { describeChannelChange } from './scanNotice';
import { formatNumber as number, PILL, PILL_GREY, postJson, PRIMARY_BUTTON, readJsonResponse as readResponse, SMALL_BUTTON } from './ui';

const API = '/api/channel-scans';
const POLL_INTERVAL_MS = 3000;
const VIDEO_LIST_PAGE_SIZE = 10;
const DEFAULT_CLIPS = 8;
const TRY_LIMITS: { value: number; label: string }[] = [
  { value: 1, label: 'Thử 1 video' },
  { value: 20, label: '20 video' },
  { value: 0, label: 'Cả kênh' },
];
const DEFAULT_OPTIONS: ChannelOptions = { filter: false, musicOnly: false, clips: 0, limit: 1 };


const STEP_LABELS = ['Lấy danh sách', 'Tải âm thanh', 'Lọc nhạc', 'Nhận diện', 'Báo cáo'];
const STEP_OF_STATUS: Record<ChannelStatus, number> = { ready: 0, downloading: 1, filtering: 2, awaiting: 3, identifying: 3, paused: 3, done: 4 };
const RUNNING: ChannelStatus[] = ['downloading', 'filtering', 'identifying'];

const post = (path: string, body: unknown = {}) => postJson<ChannelCurrentResponse>(`${API}${path}`, body);


function Option({
  id,
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className={`grid grid-cols-[18px_minmax(0,1fr)] gap-x-2 text-sm font-medium text-slate-700 ${disabled ? 'opacity-55' : ''}`}>
      <input id={id} type="checkbox" className="mt-0.5 accent-brand-700" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
      {hint && <span className="col-start-2 text-xs font-normal text-slate-500">{hint}</span>}
    </label>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span>{label}</span>
      <b className="text-right font-semibold text-slate-900 tabular-nums">{value}</b>
    </div>
  );
}

function Steps({ scan }: { scan: ChannelScanView }) {
  const status = scan.status === 'paused' ? (scan.pausedFrom ?? 'downloading') : scan.status;
  const current = STEP_OF_STATUS[status];
  const skipFilter = scan.options?.filter === false;
  const percent = scan.progress.total > 0 ? Math.round((scan.progress.done / scan.progress.total) * 100) : 0;

  return (
    <ol className="grid grid-cols-1 gap-2 sm:grid-cols-5">
      {STEP_LABELS.map((label, position) => {
        const isSkipped = position === 2 && skipFilter;
        const isDone = position < current || scan.status === 'done';
        const isCurrent = position === current && !isDone && status !== 'awaiting';
        const width = isDone ? 100 : isCurrent ? percent : 0;
        return (
          <li key={label} className={`grid gap-1.5 text-xs ${isSkipped ? 'opacity-60' : ''}`}>
            <span className="h-1.5 overflow-hidden rounded-full bg-brand-50">
              <span className="block h-full rounded-full bg-linear-to-r from-brand-400 to-brand-600 transition-all" style={{ width: `${isSkipped ? 0 : width}%` }} />
            </span>
            <span className={isCurrent ? 'font-semibold text-brand-800' : isDone ? 'text-slate-700' : 'text-slate-500'}>
              {label}
              {isSkipped && <span className="block text-[11px] text-slate-500">Bỏ qua</span>}
              {isCurrent && scan.progress.total > 0 && (
                <span className="block text-[11px] font-normal text-slate-500 tabular-nums">
                  {number(scan.progress.done)} / {number(scan.progress.total)}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function VideoList({ videos, options, maxSeconds }: { videos: ChannelVideo[]; options: ChannelOptions; maxSeconds: number }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const prepared = useMemo(() => pickPrepared(videos, options).filter(({ scanned }) => !scanned), [videos, options]);
  const picked = useMemo(() => new Set(prepared.map(({ videoId }) => videoId)), [prepared]);
  const rows = useMemo(() => searchChannelVideos(videos, query), [videos, query]);
  const pages = Math.max(1, Math.ceil(rows.length / VIDEO_LIST_PAGE_SIZE));
  const shownPage = Math.min(page, pages - 1);
  const start = shownPage * VIDEO_LIST_PAGE_SIZE;
  const hours = Math.round(videos.reduce((sum, { seconds }) => sum + seconds, 0) / 3600);
  const onlyMusic = options.filter && options.musicOnly;

  return (
    <Panel className="overflow-hidden" aria-label="Danh sách video">
      <div className="space-y-3 p-5">
        <div>
          <h3 className="text-xl font-bold text-slate-900">Danh sách video</h3>
          <p className="text-sm text-slate-500 tabular-nums">
            {number(videos.length)} video · {number(hours)} giờ · mới nhất ở trên · lần này xử lý {number(prepared.length)} video
            {onlyMusic && ', chỉ gửi video có nhạc sau khi lọc'}
          </p>
        </div>
        <label className="relative block">
          <span className="sr-only">Tìm trong danh sách video</span>
          <Search className="absolute top-2 left-2.5 h-4 w-4 text-slate-400" />
          <input
            id="channel-video-search"
            value={query}
            placeholder="Tìm theo tên video"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            className="w-full rounded-xl border border-brand-200 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100"
          />
        </label>
      </div>

      <ul className="divide-y divide-slate-100 border-y border-slate-100">
        {rows.slice(start, start + VIDEO_LIST_PAGE_SIZE).map((video) => (
          <li key={video.videoId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3">
            <div className="flex min-w-0 flex-[1_1_18rem] gap-3 text-sm">
              <IconBadge>
                <Video className="h-4 w-4" />
              </IconBadge>
              <div className="min-w-0">
                <a href={`https://www.youtube.com/watch?v=${video.videoId}`} target="_blank" rel="noreferrer" className="wrap-anywhere font-medium text-slate-800 hover:underline">
                  {video.title || video.videoId}
                </a>
                <p className="text-xs text-slate-500 tabular-nums">
                  {video.seconds > 0 ? formatDuration(video.seconds) : 'Chưa rõ độ dài'}
                  {video.seconds > maxSeconds && options.clips === 0 && ` · chỉ quét ${Math.round(maxSeconds / 60)} phút đầu`}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {!video.scanned && <span className="text-xs whitespace-nowrap text-slate-500 tabular-nums">{number(worstCaseRequests([video], { ...options, limit: 0 }, maxSeconds))} yêu cầu</span>}
              {video.scanned ? (
                <span className={`${PILL} bg-emerald-50 text-emerald-800 ring-emerald-200`}>Đã quét</span>
              ) : picked.has(video.videoId) ? (
                <span className={`${PILL} bg-brand-50 text-brand-800 ring-brand-200`}>Sẽ quét</span>
              ) : (
                <span className={`${PILL} ${PILL_GREY}`}>Chưa quét</span>
              )}
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="px-5 py-6 text-center text-sm text-slate-500">Không có video nào khớp.</li>}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs text-slate-500">
        <span className="tabular-nums">
          {number(rows.length)} video · trang {shownPage + 1} / {number(pages)}
        </span>
        <span className="flex gap-2">
          <button type="button" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)} className={SMALL_BUTTON}>
            Trước
          </button>
          <button type="button" disabled={shownPage >= pages - 1} onClick={() => setPage(shownPage + 1)} className={SMALL_BUTTON}>
            Sau
          </button>
        </span>
      </div>
    </Panel>
  );
}

function RunPanel({
  scan,
  maxRequests,
  remainingRequests,
  budget,
  isBusy,
  onAction,
  onNew,
}: {
  scan: ChannelScanView;
  maxRequests: number;
  remainingRequests: number;
  /** Ngân sách AudD tháng này, null nếu chưa bật. */
  budget: BudgetView | null;
  /** Đang chờ máy chủ trả lời lần bấm trước, khóa các nút để không gửi hai lần. */
  isBusy: boolean;
  onAction: (path: string) => void;
  onNew: () => void;
}) {
  const titles: Record<ChannelStatus, string> = {
    ready: 'Sẵn sàng quét',
    downloading: 'Đang tải âm thanh',
    filtering: 'Đang lọc nhạc',
    awaiting: 'Chờ xác nhận chi phí',
    identifying: 'Đang nhận diện',
    paused: 'Lần quét đang tạm dừng',
    done: scan.stoppedEarly ? 'Đã dừng lần quét' : 'Đã quét xong kênh',
  };
  const isRunning = RUNNING.includes(scan.status);
  const canStop = isRunning || scan.status === 'paused';
  const gate = scan.gate;
  const isOverLimit = Boolean(gate && gate.requests > maxRequests);
  const isOverDaily = Boolean(gate && !isOverLimit && gate.requests > remainingRequests);
  const isOverBudget = Boolean(gate && budget && !isOverLimit && !isOverDaily && gate.requests > remainingBudgetRequests(budget));
  const subtitle =
    scan.status === 'done'
      ? scan.stoppedEarly
        ? 'Phần chưa quét nằm ở nhóm Cần nghe lại.'
        : `Đã xong${scan.failed ? `, ${number(scan.failed)} video lỗi nằm ở nhóm Cần nghe lại` : ''}. Chạy lại cùng kênh sẽ không tính thêm video đã quét.`
      : scan.status === 'ready'
        ? 'Tải âm thanh và lọc nhạc không tốn lượt AudD.'
        : scan.status === 'awaiting'
          ? 'Chưa có yêu cầu AudD nào được gửi.'
          : 'Có thể đóng tab, app vẫn chạy tiếp. Máy chủ gửi từng video một, xen kẽ với các màn hình khác.';

  return (
    <Panel className="space-y-4 p-5" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_16rem]">
          <h3 className="text-xl font-bold text-slate-900">{titles[scan.status]}</h3>
          <p className="text-sm text-slate-500">
            <span className="font-medium text-slate-700">{scan.channelTitle}</span> · {subtitle}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isRunning && (
            <button type="button" disabled={isBusy} onClick={() => onAction(`/${scan.id}/pause`)} className={SMALL_BUTTON}>
              Tạm dừng
            </button>
          )}
          {scan.status === 'paused' && (
            <button type="button" disabled={isBusy} onClick={() => onAction(`/${scan.id}/resume`)} className={SMALL_BUTTON}>
              Chạy tiếp
            </button>
          )}
          {canStop && (
            <button type="button" disabled={isBusy} onClick={() => onAction(`/${scan.id}/stop`)} className={SMALL_BUTTON}>
              Dừng phần chưa quét
            </button>
          )}
          {scan.status === 'done' && (
            <button type="button" onClick={onNew} className={SMALL_BUTTON}>
              Quét lần mới
            </button>
          )}
        </div>
      </div>

      <Steps scan={scan} />

      {scan.pauseReason && (
        <p className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {scan.pauseReason}
        </p>
      )}

      {scan.status === 'awaiting' && gate && (
        <div className="space-y-3 rounded-xl bg-brand-50 p-3 text-sm text-brand-900">
          <p>
            {scan.options?.filter && (
              <>
                Máy lọc xong: <b className="tabular-nums">{number(gate.withMusic)}</b> video có nhạc, <b className="tabular-nums">{number(gate.noMusic)}</b> video không nhạc.{' '}
              </>
            )}
            {gate.noAudio > 0 && <>{number(gate.noAudio)} video không tải được âm thanh sẽ nằm ở nhóm Cần nghe lại. </>}
            Sẽ gửi <b className="tabular-nums">{number(gate.videos)}</b> video, dùng khoảng <b className="tabular-nums">{number(gate.requests)}</b> yêu cầu AudD.
          </p>
          {budget && gate.requests > 0 && (
            <p>
              Chi phí tối đa <b className="tabular-nums">{formatMoney(costOfRequests(gate.requests, budget.pricePer1000), budget.currency)}</b>. Ngân sách tháng còn{' '}
              <b className="tabular-nums">
                {isOverBudget
                  ? formatMoney(costOfRequests(remainingBudgetRequests(budget), budget.pricePer1000), budget.currency)
                  : `${formatMoney(costOfRequests(remainingBudgetRequests(budget) - gate.requests, budget.pricePer1000), budget.currency)} sau khi quét`}
              </b>
              .
            </p>
          )}
          {isOverBudget && budget && gate && <p className="text-rose-700">{budgetRefusal(gate.requests, budget)}</p>}
          {isOverDaily && (
            <p className="text-rose-700">
              Hạn mức quét kênh hôm nay của bạn chỉ còn {number(remainingRequests)} yêu cầu. Hãy dừng ở đây và quét ít video hơn, hoặc thử lại vào ngày mai.
            </p>
          )}
          {isOverLimit && (
            <p className="text-rose-700">
              Vượt trần {number(maxRequests)} yêu cầu mỗi lần quét. Hãy dừng ở đây và quét ít video hơn, hoặc nhờ người quản trị tăng MAX_CHANNEL_SCAN_REQUESTS.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={isOverLimit || isOverDaily || isOverBudget || isBusy} onClick={() => onAction(`/${scan.id}/send`)} className={PRIMARY_BUTTON}>
              {gate.videos === 0 ? 'Xem báo cáo' : 'Gửi nhận diện'}
            </button>
            <button type="button" disabled={isBusy} onClick={() => onAction(`/${scan.id}/stop`)} className={SMALL_BUTTON}>
              Dừng ở đây
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function ChannelTab() {
  const [channel, setChannel] = useState('');
  const [skipShorts, setSkipShorts] = useState(false);
  const [state, setState] = useState<ChannelCurrentResponse | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [requirements, setRequirements] = useState<ChannelRequirements | null>(null);
  const [options, setOptions] = useState<ChannelOptions>(DEFAULT_OPTIONS);
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState('');

  const listRef = useRef<HTMLDivElement>(null);
  const scrollToListRef = useRef(false);

  const scan = isNew ? null : (state?.scan ?? null);
  const status = scan?.status;
  useScanNotice(state?.scan ?? null, ({ id, status: seen }) => ({ id, status: seen }), describeChannelChange);

  // Danh sách có thể nằm dưới cột cấu hình, nên cuộn tới để người dùng thấy kết quả của nút vừa bấm.
  useEffect(() => {
    if (scrollToListRef.current && status === 'ready') {
      scrollToListRef.current = false;
      listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [status, scan?.id]);

  useEffect(() => {
    fetch(`${API}/requirements`)
      .then((response) => readResponse<ChannelRequirements>(response))
      .then(setRequirements)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let isCancelled = false;
    const refresh = () =>
      fetch(`${API}/current`)
        .then((response) => readResponse<ChannelCurrentResponse>(response))
        .then((next) => {
          if (!isCancelled) {
            setState(next);
          }
        })
        .catch(() => undefined);
    void refresh();
    const timer = status && RUNNING.includes(status) ? setInterval(refresh, POLL_INTERVAL_MS) : undefined;
    return () => {
      isCancelled = true;
      clearInterval(timer);
    };
  }, [status, scan?.id]);

  const run = async (request: () => Promise<ChannelCurrentResponse>) => {
    setMessage('');
    setIsBusy(true);
    try {
      setState(await request());
      setIsNew(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thực hiện được.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleFetch = (event: FormEvent) => {
    event.preventDefault();
    scrollToListRef.current = true;
    setOptions(DEFAULT_OPTIONS);
    void run(() => post('', { channel, skipShorts }));
  };

  const update = (change: Partial<ChannelOptions>) => {
    setOptions((current) => {
      const next = { ...current, ...change };
      return next.filter ? next : { ...next, musicOnly: false, clips: 0 };
    });
  };

  const videos = scan?.status === 'ready' ? (scan.videos ?? []) : [];
  const isReady = scan?.status === 'ready';
  const canEditChannel = !scan || scan.status === 'ready' || scan.status === 'done';
  const isChannelValid = parseChannelInput(channel) !== null;
  const worst = scan ? worstCaseRequests(videos, options, scan.maxSeconds) : 0;
  const needsFilterResult = options.filter && (options.musicOnly || options.clips > 0);
  const pool = options.limit > 0 ? videos.slice(0, options.limit) : videos;
  const fresh = pool.filter((video) => !video.scanned);
  const longVideos = fresh.filter((video) => scan && video.seconds > scan.maxSeconds).length;

  const requirementItems: { label: string; ok: boolean | undefined; needed: boolean }[] = [
    { label: 'Khóa YouTube Data API', ok: requirements?.youtubeKey, needed: true },
    { label: 'yt-dlp', ok: requirements?.ytDlp, needed: true },
    { label: 'ffmpeg', ok: requirements?.ffmpeg, needed: options.filter },
    { label: 'Mô hình lọc nhạc YAMNet', ok: requirements?.yamnet, needed: options.filter },
    { label: 'Khóa AudD', ok: requirements?.auddKey, needed: true },
  ];
  const lacking = requirementItems.filter(({ ok, needed }) => needed && ok === false).map(({ label }) => label);
  const isMissing = lacking.length > 0;

  const startLabel = options.limit === 0 ? 'Bắt đầu quét cả kênh' : `Bắt đầu quét ${number(Math.min(options.limit, videos.length))} video`;

  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Panel className="space-y-4 p-5">
        <form onSubmit={handleFetch} className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">
            Link kênh YouTube
            <input
              id="channel-link"
              value={channel}
              spellCheck={false}
              disabled={!canEditChannel}
              placeholder="https://www.youtube.com/@ten-kenh"
              onChange={(event) => setChannel(event.target.value)}
              className="mt-1 block w-full rounded-xl border border-brand-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
            />
          </label>
          <Option id="channel-skip-shorts" label="Bỏ qua Shorts" checked={skipShorts} disabled={!canEditChannel} onChange={setSkipShorts} />
          <button type="submit" disabled={!canEditChannel || !isChannelValid || isBusy || requirements?.youtubeKey === false} className={`${SMALL_BUTTON} inline-flex w-full items-center justify-center gap-1.5`}>
            {isBusy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            Lấy danh sách video
          </button>
        </form>

        {scan && (
          <div className="flex items-center gap-3 rounded-xl bg-brand-50 px-3 py-2.5">
            <IconBadge>
              <Tv className="h-4 w-4" />
            </IconBadge>
            <div className="min-w-0 text-xs text-slate-500">
              <p className="truncate text-sm font-semibold text-slate-900">{scan.channelTitle}</p>
              <p className="tabular-nums">
                {number(scan.totalVideos)} video · {number(Math.round(scan.totalSeconds / 3600))} giờ
              </p>
            </div>
          </div>
        )}

        {isReady && (
          <>
            <Option
              id="channel-filter"
              label="Lọc trước có nhạc hay không"
              hint="Chạy trên máy chủ, không tốn lượt AudD. Phân vân vẫn tính là có nhạc."
              checked={options.filter}
              onChange={(filter) => update({ filter })}
            />
            <Option
              id="channel-music-only"
              label="Chỉ gửi video có nhạc"
              hint="Video bị bỏ qua vẫn có trong báo cáo ở nhóm Cần nghe lại, không bao giờ được xếp Sạch."
              checked={options.musicOnly}
              disabled={!options.filter}
              onChange={(musicOnly) => update({ musicOnly })}
            />
            <div>
              <Option
                id="channel-clips"
                label="Chỉ gửi đoạn ngắn"
                hint="Mỗi 45 giây lấy một đoạn 12 giây ở chỗ có nhạc. Nhạc nằm giữa hai đoạn có thể bị sót."
                checked={options.clips > 0}
                disabled={!options.filter}
                onChange={(checked) => update({ clips: checked ? DEFAULT_CLIPS : 0 })}
              />
              {options.clips > 0 && (
                <label className="mt-1 ml-[26px] flex items-center gap-2 text-xs text-slate-500">
                  Tối đa
                  <input
                    type="range"
                    className="min-w-0 flex-1 accent-brand-700"
                    min={MIN_CLIPS}
                    max={MAX_CLIPS}
                    value={options.clips}
                    onChange={(event) => update({ clips: Number(event.target.value) })}
                  />
                  <span className="whitespace-nowrap tabular-nums">{options.clips} đoạn mỗi video</span>
                </label>
              )}
            </div>

            <div>
              <p className="mb-1 text-sm font-medium text-slate-700">Số video quét</p>
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-brand-50 p-1" role="group">
                {TRY_LIMITS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={options.limit === value}
                    onClick={() => update({ limit: value })}
                    className={`rounded-lg px-1 py-1.5 text-xs text-brand-800 ${options.limit === value ? 'bg-white font-semibold shadow-sm' : 'font-medium'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-1.5 rounded-xl bg-brand-50 p-3 text-xs text-slate-600">
              <StatRow label="Video chưa quét trong phạm vi" value={number(fresh.length)} />
              <StatRow label="Yêu cầu AudD ước tính" value={`${needsFilterResult ? 'tối đa ' : ''}${number(worst)}`} />
              <StatRow label="Trần mỗi lần quét" value={number(state?.maxRequests ?? 0)} />
              <StatRow label="Hạn mức còn lại hôm nay" value={number(state?.remainingRequests ?? 0)} />
              <StatRow label="Hỏi lại trước khi gửi" value={needsFilterResult ? 'Có, với số chính xác' : 'Có'} />
            </div>
            {longVideos > 0 && options.clips === 0 && <p className="text-xs text-amber-800">{number(longVideos)} video dài hơn giới hạn, chỉ quét {Math.round((scan?.maxSeconds ?? 0) / 60)} phút đầu.</p>}
            <p className="text-xs text-slate-500">Tải âm thanh từ YouTube có thể vi phạm Điều khoản dịch vụ của YouTube. App không dùng cookie tài khoản kênh.</p>
            <button
              type="button"
              disabled={isBusy || isMissing || fresh.length === 0}
              onClick={() => void run(() => post(`/${scan?.id}/start`, options))}
              className={`${PRIMARY_BUTTON} w-full`}
            >
              <ListVideo className="h-4 w-4" />
              {startLabel}
            </button>
            {fresh.length === 0 && <p className="text-xs text-slate-500">Các video trong phạm vi này đều đã quét.</p>}
          </>
        )}

        <NotifySwitch id="channel-notify" />
        {isMissing && <p className="text-xs text-rose-700">Chưa quét được vì máy chủ còn thiếu: {lacking.join(', ')}.</p>}
        {message && <p className="text-xs text-rose-700">{message}</p>}
      </Panel>

      <div className="grid min-w-0 gap-6">
        {scan ? (
          <RunPanel
            scan={scan}
            maxRequests={state?.maxRequests ?? 0}
            remainingRequests={state?.remainingRequests ?? 0}
            budget={state?.budget ?? null}
            isBusy={isBusy}
            onAction={(path) => void run(() => post(path))}
            onNew={() => {
              setIsNew(true);
              setMessage('');
            }}
          />
        ) : (
          <EmptyState>Dán link kênh rồi bấm Lấy danh sách video. Tiến trình và báo cáo sẽ hiện ở đây.</EmptyState>
        )}
        {scan?.status === 'ready' && (
          <div ref={listRef} className="min-w-0">
            <VideoList key={scan.id} videos={videos} options={options} maxSeconds={scan.maxSeconds} />
          </div>
        )}
        {scan?.status === 'done' && <ChannelResult key={scan.id} scan={scan} />}
        <PastScans refreshKey={`${scan?.id ?? ''}-${status ?? ''}`} hiddenId={scan?.status === 'done' ? scan.id : undefined} />
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Panel className="flex flex-col items-center px-6 py-16 text-center">
      <SoundBars className="h-12 w-28 text-brand-400" />
      <p className="mt-4 text-sm font-semibold text-slate-800">Chưa có lần quét nào</p>
      <p className="mt-1 text-sm text-slate-500">{children}</p>
    </Panel>
  );
}
