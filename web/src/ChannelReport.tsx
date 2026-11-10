/**
 * Báo cáo của một lần quét kênh đã xong và danh sách các lần quét trước.
 * Chỉ đọc kết quả đã lưu trên máy chủ, không gửi gì cho AudD.
 */

import { useEffect, useMemo, useState } from 'react';
import { Download, Info, LoaderCircle, Search, Video } from 'lucide-react';
import { formatDuration } from './batchScan';
import { buildChannelSongsCsv, buildChannelVideosCsv, CHANNEL_GROUP_LABELS, DETECTION_LABELS, LIBRARY_LABELS } from './channelScan';
import type { ChannelHistoryItem, ChannelHistoryResponse, ChannelReport, ChannelReportVideo, ChannelScanView } from './channelScan';
import { IconBadge, Panel } from './components';
import {
  downloadCsv,
  formatNumber as number,
  PILL,
  PILL_AMBER,
  PILL_BRAND,
  PILL_GREEN,
  PILL_GREY,
  PILL_RED,
  readJsonResponse as readResponse,
  SMALL_BUTTON,
} from './ui';

const API = '/api/channel-scans';
const PAGE_SIZE = 20;

const GROUP_PILLS: Record<string, string> = { 'co-nhac': PILL_RED, 'can-nghe-lai': PILL_AMBER, sach: PILL_GREEN };
const GROUPS: { id: string; hint: string }[] = [
  { id: 'co-nhac', hint: 'Đã nhận ra bài' },
  { id: 'can-nghe-lai', hint: 'Chưa đủ căn cứ' },
  { id: 'sach', hint: 'AudD không xác nhận được' },
];

function libraryPill(library: string) {
  return library === 'khop-chac' ? PILL_GREEN : library === 'gan-giong' ? PILL_AMBER : PILL_GREY;
}

function ReportRow({ video }: { video: ChannelReportVideo }) {
  const [isOpen, setIsOpen] = useState(false);
  const meta = [video.seconds > 0 ? formatDuration(video.seconds) : '', video.tracks.length ? `${video.tracks.length} bài nhận ra` : ''].filter(Boolean).join(' · ');

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_18rem] gap-3 text-sm">
          <IconBadge>
            <Video className="h-4 w-4" />
          </IconBadge>
          <div className="min-w-0">
            <a href={video.url} target="_blank" rel="noreferrer" className="wrap-anywhere font-medium text-slate-800 hover:underline">
              {video.title || video.videoId}
            </a>
            {meta && <p className="text-xs text-slate-500 tabular-nums">{meta}</p>}
            {video.reason && <p className="text-xs text-amber-800">{video.reason}</p>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className={`${PILL} ${GROUP_PILLS[video.group] ?? PILL_GREY}`}>{CHANNEL_GROUP_LABELS[video.group] ?? video.group}</span>
          <button type="button" aria-expanded={isOpen} onClick={() => setIsOpen(!isOpen)} className={SMALL_BUTTON}>
            {isOpen ? 'Thu gọn' : 'Chi tiết'}
          </button>
        </div>
      </div>
      {isOpen && (
        <div className="mt-2.5 grid gap-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
          <p>
            Máy lọc: <b className="font-medium">{DETECTION_LABELS[video.detection] ?? 'Chưa lọc'}</b>
            {video.musicSeconds && ` · ${video.musicSeconds} giây có nhạc`}
            {video.policy && ` · Policy: ${LIBRARY_LABELS[video.policy] ?? video.policy}`}
          </p>
          {video.tracks.map((track) => (
            <div key={`${track.title}-${track.artist}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-slate-200 pt-2">
              <div className="min-w-0 flex-[1_1_14rem]">
                <p className="text-sm font-medium text-slate-800">{track.title}</p>
                <p>{[track.artist, track.label, track.position].filter(Boolean).join(' · ')}</p>
              </div>
              <span className={`${PILL} ${libraryPill(track.library)}`}>{LIBRARY_LABELS[track.library] ?? track.library}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** Báo cáo của một lần quét đã xong. Chỉ đọc kết quả đã lưu, không gửi gì cho AudD. */
export function ChannelResult({ scan }: { scan: Pick<ChannelScanView, 'id' | 'createdAt'> }) {
  const [report, setReport] = useState<ChannelReport | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'videos' | 'songs'>('videos');
  const [group, setGroup] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    let isCancelled = false;
    fetch(`${API}/${scan.id}/report`)
      .then((response) => readResponse<ChannelReport>(response))
      .then((next) => {
        if (!isCancelled) {
          setReport(next);
        }
      })
      .catch((reason: unknown) => {
        if (!isCancelled) {
          setError(reason instanceof Error ? reason.message : 'Không đọc được báo cáo.');
        }
      });
    return () => {
      isCancelled = true;
    };
  }, [scan.id]);

  const search = query.trim().toLowerCase();
  const videos = useMemo(
    () =>
      (report?.videos ?? []).filter(
        (video) =>
          (group === 'all' || video.group === group) &&
          (!search || video.title.toLowerCase().includes(search) || video.tracks.some((track) => track.title.toLowerCase().includes(search))),
      ),
    [report, group, search],
  );
  const songs = useMemo(
    () => (report?.songs ?? []).filter((song) => !search || song.title.toLowerCase().includes(search) || song.artist.toLowerCase().includes(search)),
    [report, search],
  );

  if (error) {
    return <Panel className="p-5 text-sm text-rose-700">{error}</Panel>;
  }
  if (!report) {
    return (
      <Panel className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500">
        <LoaderCircle className="h-4 w-4 animate-spin" />
        Đang đọc báo cáo
      </Panel>
    );
  }

  const total = view === 'videos' ? videos.length : songs.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const shownPage = Math.min(page, pages - 1);
  const start = shownPage * PAGE_SIZE;
  const fileDate = scan.createdAt.slice(0, 10);
  const emptyText =
    group === 'sach' ? 'AudD không báo được "không có nhạc", nên nhóm Sạch luôn trống. Video không nhận ra bài nằm ở Cần nghe lại.' : 'Không có dòng nào khớp.';

  return (
    <Panel className="overflow-hidden">
      <div className="space-y-4 p-5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {GROUPS.map(({ id, hint }) => (
            <button
              key={id}
              type="button"
              aria-pressed={group === id}
              onClick={() => {
                setGroup(group === id ? 'all' : id);
                setPage(0);
              }}
              className={`flex flex-col gap-0.5 rounded-xl border p-3 text-left ${group === id ? 'border-brand-700 bg-brand-50' : 'border-brand-100 bg-white hover:border-brand-300'}`}
            >
              <strong className="text-xl font-bold text-slate-900 tabular-nums">{number(report.videos.filter((video) => video.group === id).length)}</strong>
              <span className="text-xs font-medium text-slate-600">{CHANNEL_GROUP_LABELS[id]}</span>
              <span className="text-[11px] text-slate-500">{hint}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-xl bg-brand-50 p-1">
            {(['videos', 'songs'] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => {
                  setView(id);
                  setPage(0);
                }}
                className={`rounded-lg px-3 py-1 text-xs whitespace-nowrap text-brand-800 ${view === id ? 'bg-white font-semibold shadow-sm' : 'font-medium'}`}
              >
                {id === 'videos' ? 'Theo video' : 'Theo bài'}
              </button>
            ))}
          </div>
          <label className="relative min-w-0 flex-[1_1_12rem]">
            <span className="sr-only">Tìm trong kết quả</span>
            <Search className="absolute top-2 left-2.5 h-4 w-4 text-slate-400" />
            <input
              value={query}
              placeholder="Tìm tên video hoặc tên bài"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              className="w-full rounded-xl border border-brand-200 bg-white py-1.5 pr-3 pl-8 text-xs text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100"
            />
          </label>
        </div>
      </div>

      <ul className="divide-y divide-slate-100 border-y border-slate-100">
        {view === 'videos'
          ? videos.slice(start, start + PAGE_SIZE).map((video) => <ReportRow key={video.videoId} video={video} />)
          : songs.slice(start, start + PAGE_SIZE).map((song) => (
              <li key={`${song.title}-${song.artist}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 text-sm">
                <div className="min-w-0 flex-[1_1_18rem]">
                  <p className="font-medium text-slate-800">{song.title}</p>
                  <p className="text-xs text-slate-500">{[song.artist, song.label].filter(Boolean).join(' · ')}</p>
                  <p className="text-xs text-slate-500 tabular-nums">
                    {number(song.videoCount)} video{song.seconds > 0 && ` · ${formatDuration(song.seconds)}`}
                  </p>
                </div>
                <span className={`${PILL} ${libraryPill(song.library)}`}>{LIBRARY_LABELS[song.library] ?? song.library}</span>
              </li>
            ))}
        {total === 0 && <li className="px-5 py-6 text-center text-sm text-slate-500">{emptyText}</li>}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs text-slate-500">
        <span className="tabular-nums">
          {number(total)} dòng · trang {shownPage + 1} / {number(pages)}
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

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
        <p className="flex min-w-0 flex-[1_1_18rem] gap-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Thư viện chỉ xác nhận bài có trong Library, không thấy thì vẫn là Chưa tra. Kết quả quét không phải bằng chứng về bản quyền.
        </p>
        <span className="flex flex-wrap gap-2">
          <button type="button" onClick={() => downloadCsv(buildChannelVideosCsv(report.videos), `bao-cao-quet-${fileDate}.csv`)} className={`${SMALL_BUTTON} inline-flex items-center gap-1`}>
            <Download className="h-3.5 w-3.5" />
            Tải báo cáo video
          </button>
          <button type="button" onClick={() => downloadCsv(buildChannelSongsCsv(report.songs), `songs-${fileDate}.csv`)} className={`${SMALL_BUTTON} inline-flex items-center gap-1`}>
            <Download className="h-3.5 w-3.5" />
            Tải danh sách bài
          </button>
        </span>
      </div>
    </Panel>
  );
}

const formatScanTime = (value: string) =>
  new Date(value).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Các lần quét đã kết thúc của mọi người. Mở lại báo cáo không cần lấy lại danh sách video và không tốn lượt. */
export function PastScans({ refreshKey, hiddenId }: { refreshKey: string; hiddenId?: string }) {
  const [items, setItems] = useState<ChannelHistoryItem[]>([]);
  const [openId, setOpenId] = useState('');

  useEffect(() => {
    let isCancelled = false;
    fetch(`${API}/history`)
      .then((response) => readResponse<ChannelHistoryResponse>(response))
      .then(({ scans }) => {
        if (!isCancelled) {
          setItems(scans);
        }
      })
      .catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, [refreshKey]);

  const shown = items.filter(({ id }) => id !== hiddenId);
  const open = shown.find(({ id }) => id === openId);
  if (shown.length === 0) {
    return null;
  }

  return (
    <>
      <Panel className="overflow-hidden">
        <h3 className="border-b border-brand-100 px-5 py-3 text-sm font-semibold text-slate-900">Các lần quét trước</h3>
        <ul className="divide-y divide-slate-100">
          {shown.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3 text-sm">
              <div className="min-w-0 flex-[1_1_16rem]">
                <a href={item.channelUrl} target="_blank" rel="noreferrer" className="wrap-anywhere font-medium text-slate-800 hover:underline">
                  {item.channelTitle || item.channelUrl}
                </a>
                <p className="text-xs text-slate-500 tabular-nums">
                  {[
                    formatScanTime(item.createdAt),
                    item.user === 'khong-ro' ? '' : item.user,
                    item.sent ? `${number(item.sent.videos)} video đã gửi · ${number(item.sent.requests)} yêu cầu AudD` : 'Chưa gửi AudD',
                    item.failed ? `${number(item.failed)} video lỗi` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <span className={`${PILL} ${item.stoppedEarly ? PILL_GREY : PILL_BRAND}`}>{item.stoppedEarly ? 'Dừng sớm' : 'Đã xong'}</span>
                <button type="button" aria-expanded={openId === item.id} onClick={() => setOpenId(openId === item.id ? '' : item.id)} className={SMALL_BUTTON}>
                  {openId === item.id ? 'Đóng báo cáo' : 'Mở báo cáo'}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <p className="flex gap-2 border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Báo cáo đọc từ kết quả đã lưu của kênh, nên nếu kênh được quét thêm sau đó thì báo cáo cũ gồm cả video mới quét.
        </p>
      </Panel>
      {open && (
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-semibold text-slate-900">
            Báo cáo: {open.channelTitle || open.channelUrl} · {formatScanTime(open.createdAt)}
          </p>
          <ChannelResult key={open.id} scan={open} />
        </div>
      )}
    </>
  );
}
