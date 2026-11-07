import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  AudioLines,
  Clock,
  BookOpen,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  Info,
  Library,
  Link2,
  ListChecks,
  LoaderCircle,
  Music,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  Video,
} from 'lucide-react';
import { buildAudioLibraryIndex, isAudioLibraryFile } from './audioLibrary';
import type { AudioLibraryFile, AudioLibraryIndex } from './audioLibrary';
import { RESOURCE_GROUPS } from './catalog';
import type { MusicResource } from './catalog';
import { readMediaDuration } from './mediaDuration';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, UPLOAD_TOO_LARGE_MESSAGE } from './uploadLimit';
import { getVideoVerdict, needsStudioLookup } from './videoCheck';
import type { IdentifyResult, VideoVerdictKind } from './videoCheck';
import { parseYoutubeVideoId } from './youtubeLink';

type TabId = 'video' | 'guide' | 'library';

/** "UC" không kèm mã kênh: Studio tự chuyển sang kênh của tài khoản đang đăng nhập. */
const STUDIO_MUSIC_URL = 'https://studio.youtube.com/channel/UC/music';

interface AudioLibraryState {
  status: 'loading' | 'ready' | 'failed';
  index: AudioLibraryIndex;
  file?: AudioLibraryFile;
}

const TABS: { id: TabId; label: string; description: string; icon: ReactNode }[] = [
  {
    id: 'video',
    label: 'Kiểm tra nhạc',
    description: 'Dán link YouTube hoặc tải file lên. Bài nhận ra phải có trong YouTube Audio Library thì mới được dùng.',
    icon: <Video className="h-4 w-4" />,
  },
  {
    id: 'guide',
    label: 'Quy trình & Pháp lý',
    description: 'Các bước cần hoàn tất và khái niệm cần nắm trước khi đăng nội dung.',
    icon: <BookOpen className="h-4 w-4" />,
  },
  {
    id: 'library',
    label: 'Nguồn nhạc',
    description: 'Danh sách nguồn nhạc tham khảo. Đọc điều khoản hiện hành trước khi sử dụng.',
    icon: <Library className="h-4 w-4" />,
  },
];

const VERDICT_STYLES: Record<VideoVerdictKind, { accent: string; tint: string; icon: ReactNode }> = {
  allowed: { accent: 'border-l-emerald-600', tint: 'bg-emerald-50/70', icon: <ShieldCheck className="h-6 w-6 text-emerald-700" /> },
  blocked: { accent: 'border-l-rose-600', tint: 'bg-rose-50/70', icon: <ShieldX className="h-6 w-6 text-rose-700" /> },
  review: { accent: 'border-l-amber-500', tint: 'bg-amber-50/70', icon: <ShieldQuestion className="h-6 w-6 text-amber-700" /> },
  error: { accent: 'border-l-slate-400', tint: 'bg-slate-50', icon: <ShieldAlert className="h-6 w-6 text-slate-500" /> },
};

const HOW_IT_WORKS = [
  { title: 'Đưa nội dung vào', body: 'Dán link video YouTube hoặc chọn file.', icon: <Link2 className="h-5 w-5" /> },
  { title: 'AudD nhận diện', body: 'Máy tìm các bài nhạc có trong nội dung.', icon: <AudioLines className="h-5 w-5" /> },
  { title: 'Đối chiếu thư viện', body: 'Từng bài được tra trong danh sách YouTube Audio Library.', icon: <ListChecks className="h-5 w-5" /> },
];

const VERDICT_LEGEND = [
  { title: 'Được dùng', body: 'Mọi bài khớp chắc với thư viện.', icon: <ShieldCheck className="h-4 w-4 text-emerald-700" /> },
  { title: 'Cần người duyệt', body: 'Có bài gần khớp hoặc chưa chắc chắn.', icon: <ShieldQuestion className="h-4 w-4 text-amber-700" /> },
  { title: 'Không được dùng', body: 'Có bài nằm ngoài thư viện.', icon: <ShieldX className="h-4 w-4 text-rose-700" /> },
];

/** Chiều cao các thanh sóng âm trang trí, tính theo phần trăm. */
const SOUND_BAR_HEIGHTS = [35, 62, 48, 86, 58, 100, 70, 44, 78, 54, 92, 40, 66, 84, 50, 30];

const LEGAL_TOPICS = [
  {
    title: 'Bản phổ và bản thu',
    body: 'Một bài nhạc có hai lớp quyền: phần sáng tác (Composition) và bản thu (Master Recording). Bản phổ đã tự do không có nghĩa là mọi bản thu của nó đều tự do.',
  },
  {
    title: 'Sync License',
    body: 'Giấy phép đưa nhạc vào hình ảnh như video, quảng cáo hoặc phim. Thường cần xin từ cả bên giữ quyền sáng tác lẫn bên giữ bản thu.',
  },
  {
    title: 'Thương mại và phi thương mại',
    body: 'Thương mại không chỉ là quảng cáo. Video kiếm tiền, nội dung của doanh nghiệp hay bài có tài trợ thường đều bị coi là thương mại, nên giấy phép "phi thương mại" không đủ.',
  },
  {
    title: 'Lưu hóa đơn và giấy phép',
    body: 'Giữ giấy phép, hóa đơn và ảnh chụp trang điều khoản tại thời điểm tải nhạc. Đây là bằng chứng khi kháng nghị, vì điều khoản có thể thay đổi sau này.',
  },
];

const CHECKLIST_ITEMS = [
  'Đã xác định tác giả và người giữ quyền của bài',
  'Đã kiểm tra cả phần sáng tác lẫn bản thu',
  'Giấy phép bao gồm đúng mục đích và nền tảng sử dụng',
  'Đã ghi nguồn đúng mẫu nếu giấy phép yêu cầu',
  'Đã lưu giấy phép và hóa đơn vào hồ sơ dự án',
];

const SCAN_FACTS = [
  { label: 'Link YouTube công khai', icon: <Link2 className="h-3.5 w-3.5" /> },
  { label: 'MP3, WAV, MP4, MOV và nhiều định dạng khác', icon: <Music className="h-3.5 w-3.5" /> },
  { label: `File tối đa ${MAX_UPLOAD_MB} MB`, icon: <CloudUpload className="h-3.5 w-3.5" /> },
  { label: 'Quét 60 phút đầu', icon: <Clock className="h-3.5 w-3.5" /> },
];

/** Nạp danh sách thư viện. Không nạp được thì app không quét, để không chặn nhầm mọi bài. */
function useAudioLibrary(): AudioLibraryState {
  const [library, setLibrary] = useState<AudioLibraryState>({ status: 'loading', index: buildAudioLibraryIndex([]) });

  useEffect(() => {
    let isCancelled = false;
    fetch(`${import.meta.env.BASE_URL}audio-library.json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((file: unknown) => {
        if (isCancelled) {
          return;
        }
        setLibrary(
          isAudioLibraryFile(file)
            ? { status: 'ready', index: buildAudioLibraryIndex(file.tracks), file }
            : { status: 'failed', index: buildAudioLibraryIndex([]) },
        );
      })
      .catch(() => {
        if (!isCancelled) {
          setLibrary({ status: 'failed', index: buildAudioLibraryIndex([]) });
        }
      });
    return () => {
      isCancelled = true;
    };
  }, []);

  return library;
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-brand-100 bg-white shadow-card ${className}`}>{children}</div>;
}

function SoundBars({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`sound-bars ${className}`}>
      {SOUND_BAR_HEIGHTS.map((height, position) => (
        <span key={position} style={{ height: `${height}%`, animationDelay: `${position * -0.17}s` }} />
      ))}
    </div>
  );
}

function IconBadge({ children }: { children: ReactNode }) {
  return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">{children}</span>;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-slate-900">{children}</h3>;
}

function ScanFacts() {
  return (
    <ul className="mt-4 flex flex-wrap gap-2">
      {SCAN_FACTS.map((fact) => (
        <li
          key={fact.label}
          className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-inset ring-white/20"
        >
          {fact.icon}
          {fact.label}
        </li>
      ))}
    </ul>
  );
}

function PageHero({ tab }: { tab: (typeof TABS)[number] }) {
  return (
    <header className="relative mb-6 overflow-hidden rounded-2xl bg-linear-to-br from-brand-950 via-brand-900 to-brand-700 px-6 py-6 text-white shadow-card">
      <SoundBars className="absolute right-6 bottom-0 hidden h-4/5 w-72 text-brand-300 opacity-25 md:flex" />
      <div className="relative">
        <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15">{tab.icon}</span>
          {tab.label}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-brand-100">{tab.description}</p>
        {tab.id === 'video' && <ScanFacts />}
      </div>
    </header>
  );
}

/** Chép tên bài rồi mở Studio. Trang http không có quyền chép thì vẫn mở Studio và báo người duyệt tự chép. */
function StudioLookupLink({ title }: { title: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  function copyTitle() {
    if (!navigator.clipboard) {
      setCopyStatus('failed');
      return;
    }
    navigator.clipboard.writeText(title).then(
      () => setCopyStatus('copied'),
      () => setCopyStatus('failed'),
    );
  }

  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <a
        href={STUDIO_MUSIC_URL}
        target="_blank"
        rel="noreferrer"
        onClick={copyTitle}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-brand-200 bg-white px-2 py-1 font-medium text-brand-800 hover:bg-brand-50"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Tra trong Studio
      </a>
      {copyStatus === 'copied' && <span className="text-slate-500">Đã chép tên bài. Dán vào ô tìm kiếm của Studio.</span>}
      {copyStatus === 'failed' && <span className="text-amber-800">Không tự chép được. Hãy chép tay tên bài ở trên.</span>}
    </p>
  );
}

function EmptyResult() {
  return (
    <Panel className="p-6">
      <div className="flex items-center gap-3">
        <SoundBars className="h-8 w-20 text-brand-400" />
        <div>
          <p className="text-sm font-semibold text-slate-900">Chưa có kết quả</p>
          <p className="text-sm text-slate-500">Dán link video hoặc chọn file để kiểm tra.</p>
        </div>
      </div>

      <ol className="mt-6 grid gap-3 md:grid-cols-3">
        {HOW_IT_WORKS.map((step, position) => (
          <li key={step.title} className="rounded-xl bg-brand-50/70 p-4">
            <div className="flex items-center justify-between text-brand-700">
              {step.icon}
              <span className="text-xs font-semibold text-brand-800">Bước {position + 1}</span>
            </div>
            <p className="mt-3 text-sm font-semibold text-slate-900">{step.title}</p>
            <p className="mt-1 text-sm text-slate-600">{step.body}</p>
          </li>
        ))}
      </ol>

      <ul className="mt-5 grid gap-2 border-t border-brand-100 pt-5 md:grid-cols-3">
        {VERDICT_LEGEND.map((item) => (
          <li key={item.title} className="text-sm">
            <p className="flex items-center gap-1.5 font-medium text-slate-800">
              {item.icon}
              {item.title}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">{item.body}</p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

async function readIdentifyResponse(response: Response): Promise<IdentifyResult> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || payload === null) {
    const message = (payload as { error?: string } | null)?.error;
    throw new Error(message ?? 'Không gọi được phần quét. Hãy chạy app bằng npm.cmd run dev.');
  }
  return payload as IdentifyResult;
}

/** Gọi quét một lần. Gọi lại với cùng video chỉ lấy kết quả, không gửi quét lại. */
async function requestIdentify(url: string): Promise<IdentifyResult> {
  const response = await fetch('/api/identify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return readIdentifyResponse(response);
}

async function requestIdentifyFile(file: File): Promise<IdentifyResult> {
  const response = await fetch('/api/identify-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
  return readIdentifyResponse(response);
}

function VideoTab({ library }: { library: AudioLibraryState }) {
  const [videoLink, setVideoLink] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [message, setMessage] = useState('');
  const scanIdRef = useRef(0);

  const verdict = useMemo(() => (result ? getVideoVerdict(result, library.index) : null), [result, library.index]);

  useEffect(
    () => () => {
      scanIdRef.current += 1;
    },
    [],
  );

  const cancelScan = () => {
    scanIdRef.current += 1;
    setIsScanning(false);
  };

  const handleLinkChange = (value: string) => {
    cancelScan();
    setVideoLink(value);
    setUploadFile(null);
    setResult(null);
    setMessage('');
  };

  const handleFileChange = (file: File | null) => {
    cancelScan();
    setUploadFile(file);
    setVideoLink('');
    setResult(null);
    setMessage('');
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (library.status !== 'ready') {
      setMessage('Chưa nạp được danh sách YouTube Audio Library nên chưa kiểm tra được.');
      return;
    }
    if (!uploadFile && !parseYoutubeVideoId(videoLink)) {
      setMessage('Hãy dán link của một video YouTube hoặc chọn file. Không nhận link kênh hay playlist.');
      return;
    }
    if (uploadFile && uploadFile.size > MAX_UPLOAD_BYTES) {
      setMessage(UPLOAD_TOO_LARGE_MESSAGE);
      return;
    }

    const scanId = scanIdRef.current + 1;
    scanIdRef.current = scanId;
    setResult(null);
    setMessage('');
    setIsScanning(true);

    try {
      const scan = await (uploadFile ? requestIdentifyFile(uploadFile) : requestIdentify(videoLink));
      const duration = uploadFile ? await readMediaDuration(uploadFile) : scan.duration_seconds;
      if (scanIdRef.current === scanId) {
        setResult({ ...scan, duration_seconds: duration });
      }
    } catch (error) {
      if (scanIdRef.current === scanId) {
        setMessage(error instanceof Error ? error.message : 'Không quét được.');
      }
    }
    if (scanIdRef.current === scanId) {
      setIsScanning(false);
    }
  };

  const fieldClass =
    'w-full rounded-xl border border-brand-200 bg-white py-2.5 pr-3 pl-9 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Panel className="p-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Link video YouTube
            <span className="relative mt-1 block">
              <Link2 className="absolute top-3 left-3 h-4 w-4 text-brand-600" />
              <input
                type="text"
                inputMode="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={videoLink}
                onChange={(event) => handleLinkChange(event.target.value)}
                className={fieldClass}
              />
            </span>
            <span className="mt-1 block text-xs font-normal text-slate-500">
              Nhập link video công khai để kiểm tra bản quyền âm thanh.
            </span>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Hoặc tải file lên
            <span className="relative mt-1 flex flex-col items-center rounded-xl border-2 border-dashed border-brand-200 bg-brand-50/60 px-4 py-5 text-center transition-colors focus-within:border-brand-600 hover:border-brand-400">
              <CloudUpload className="h-6 w-6 text-brand-600" />
              <span className="mt-1.5 break-all text-sm font-medium text-brand-800">{uploadFile ? uploadFile.name : 'Chọn hoặc thả file vào đây'}</span>
              <span className="text-xs font-normal text-slate-500">File âm thanh hoặc video</span>
              <input
                key={uploadFile ? 'co-file' : 'chua-co-file'}
                type="file"
                accept="audio/*,video/*"
                onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </span>
            <span className="mt-1 block text-xs font-normal text-slate-500">
              Tối đa {MAX_UPLOAD_MB} MB. File được gửi tới AudD để quét, tốn 1 yêu cầu cho mỗi 12 giây âm thanh.
            </span>
          </label>
          <button
            type="submit"
            disabled={isScanning}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-r from-brand-800 to-brand-700 px-3 py-2.5 text-sm font-semibold text-white shadow-card transition hover:from-brand-900 hover:to-brand-800 disabled:opacity-60"
          >
            {isScanning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
            {isScanning ? 'Đang quét...' : 'Kiểm tra'}
          </button>
        </form>
      </Panel>

      {verdict && result ? (
        <Panel className="divide-y divide-brand-100 overflow-hidden">
          <header className={`border-l-4 px-5 py-4 ${VERDICT_STYLES[verdict.kind].accent} ${VERDICT_STYLES[verdict.kind].tint}`} aria-live="polite">
            <p className="break-all text-xs text-slate-500">{result.url}</p>
            <h3 className="mt-1 flex items-center gap-2 text-xl font-bold text-slate-900">
              {VERDICT_STYLES[verdict.kind].icon}
              {verdict.title}
            </h3>
            <p className="mt-1 text-sm text-slate-600">{verdict.detail}</p>
          </header>

          {verdict.tracks.length > 0 && (
            <section className="space-y-2 px-5 py-4">
              <SectionTitle>Bài máy nhận ra ({verdict.tracks.length})</SectionTitle>
              <ul className="divide-y divide-slate-100">
                {verdict.tracks.map(({ track, libraryTrack, nearTrack, isDoubtful, isIgnored }) => (
                  <li key={`${track.title}-${track.artists}`} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between md:gap-4">
                    <div className="flex min-w-0 gap-3 text-sm">
                      <IconBadge>
                        <Music className="h-4 w-4" />
                      </IconBadge>
                      <div className="min-w-0">
                      <p className="font-medium text-slate-800">{track.title}</p>
                      <p className="text-xs text-slate-500">
                        {[track.artists, track.label, track.isrc && `ISRC ${track.isrc}`].filter(Boolean).join(' · ')}
                      </p>
                      {track.composers && <p className="text-xs text-slate-500">Sáng tác: {track.composers}</p>}
                      {nearTrack && (
                        <p className="text-xs text-amber-800">
                          Trong thư viện có: {nearTrack.title} · {nearTrack.artist}
                        </p>
                      )}
                      {libraryTrack?.attribution && (
                        <p className="text-xs font-medium text-amber-800">
                          Phải ghi nguồn trong mô tả video, lấy đúng mẫu trong YouTube Audio Library.
                        </p>
                      )}
                      {needsStudioLookup({ libraryTrack, isIgnored }) && <StudioLookupLink title={track.title} />}
                      </div>
                    </div>
                    <span
                      className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                        isIgnored
                          ? 'bg-slate-100 text-slate-600 ring-slate-200'
                          : nearTrack || isDoubtful || libraryTrack?.unconfirmed
                          ? 'bg-amber-50 text-amber-800 ring-amber-200'
                          : libraryTrack
                            ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                            : 'bg-rose-50 text-rose-800 ring-rose-200'
                      }`}
                    >
                      {nearTrack || isDoubtful || isIgnored || libraryTrack?.unconfirmed ? (
                        <ShieldAlert className="h-4 w-4" />
                      ) : libraryTrack ? (
                        <ShieldCheck className="h-4 w-4" />
                      ) : (
                        <ShieldX className="h-4 w-4" />
                      )}
                      {nearTrack
                        ? 'Gần khớp'
                        : isIgnored
                          ? 'Có thể nhận nhầm'
                          : isDoubtful
                          ? 'Cần nghe lại'
                          : libraryTrack?.unconfirmed
                            ? 'Chưa xác nhận lại'
                            : libraryTrack
                              ? 'Có trong thư viện'
                              : 'Không có trong thư viện'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="flex gap-2 px-5 py-3 text-xs text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Danh sách thư viện không chính thức và có thể đã cũ. Kết quả quét không phải bằng chứng về bản quyền.
            {result.scan_note && ` ${result.scan_note}`}
          </p>
        </Panel>
      ) : (
        !isScanning && !message && library.status !== 'failed' ? (
          <EmptyResult />
        ) : (
        <Panel className="flex flex-col items-center px-6 py-16 text-center">
          {isScanning ? (
            <>
              <SoundBars className="h-12 w-28 text-brand-600" />
              <p className="mt-4 text-sm font-semibold text-slate-800">Đang quét</p>
              <p className="mt-1 text-sm text-slate-500">Có thể mất vài phút. Nội dung đã quét xong sẽ không bị tính phí lại.</p>
              <button
                type="button"
                onClick={cancelScan}
                className="mt-3 rounded-xl border border-brand-200 bg-white px-3 py-1.5 text-xs font-medium text-brand-800 hover:bg-brand-50"
              >
                Dừng chờ
              </button>
            </>
          ) : (
            <>
              <ShieldAlert className="h-8 w-8 text-amber-600" />
              <p className="mt-3 text-sm font-medium text-slate-700">Chưa kiểm tra được</p>
              <p className="mt-1 text-sm text-slate-500">
                {message || 'Không nạp được danh sách YouTube Audio Library. Hãy chạy lại npm run library:import.'}
              </p>
            </>
          )}
        </Panel>
        )
      )}
    </div>
  );
}

function GuideTab() {
  const [checkedItems, setCheckedItems] = useState<string[]>([]);

  const toggleItem = (item: string) => {
    setCheckedItems((current) =>
      current.includes(item) ? current.filter((value) => value !== item) : [...current, item],
    );
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      <Panel className="p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <CheckCircle2 className="h-4 w-4 text-brand-700" />
          Checklist trước khi đăng ({checkedItems.length}/{CHECKLIST_ITEMS.length})
        </h2>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-brand-50">
          <div
            className="h-full rounded-full bg-linear-to-r from-brand-400 to-brand-600 transition-all"
            style={{ width: `${(checkedItems.length / CHECKLIST_ITEMS.length) * 100}%` }}
          />
        </div>
        <ul className="mt-4 space-y-2">
          {CHECKLIST_ITEMS.map((item) => (
            <li key={item}>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl bg-brand-50/60 px-3 py-2.5 text-sm text-slate-700 hover:bg-brand-50">
                <input
                  type="checkbox"
                  checked={checkedItems.includes(item)}
                  onChange={() => toggleItem(item)}
                  className="mt-0.5 accent-brand-700"
                />
                {item}
              </label>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel className="divide-y divide-brand-100">
        <h2 className="flex items-center gap-2 p-5 text-sm font-semibold text-slate-900">
          <BookOpen className="h-4 w-4 text-brand-700" />
          Khái niệm cần biết
        </h2>
        {LEGAL_TOPICS.map((topic) => (
          <div key={topic.title} className="p-5">
            <SectionTitle>{topic.title}</SectionTitle>
            <p className="mt-1 text-sm text-slate-600">{topic.body}</p>
          </div>
        ))}
      </Panel>
    </div>
  );
}

function ResourceRow({ resource }: { resource: MusicResource }) {
  return (
    <li className="flex flex-col gap-0.5 px-5 py-3 md:flex-row md:items-center md:justify-between md:gap-6">
      <a
        href={resource.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-brand-700 hover:underline"
      >
        {resource.name}
        <ExternalLink className="h-3 w-3" />
      </a>
      <span className="text-sm text-slate-600 md:text-right">{resource.note}</span>
    </li>
  );
}

function LibraryTab() {
  return (
    <div className="space-y-6">
      {RESOURCE_GROUPS.map((group) => (
        <Panel key={group.title}>
          <h2 className="rounded-t-2xl border-b border-brand-100 bg-brand-50/70 px-5 py-3 text-sm font-semibold text-brand-900">{group.title}</h2>
          <ul className="divide-y divide-brand-100">
            {group.resources.map((resource) => (
              <ResourceRow key={resource.name} resource={resource} />
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('video');
  const library = useAudioLibrary();
  const currentTab = TABS.find((tab) => tab.id === activeTab) ?? TABS[0];

  return (
    <div className="min-h-screen text-slate-900">
      <aside className="flex flex-col bg-linear-to-b from-brand-950 via-brand-900 to-brand-800 text-white lg:fixed lg:inset-y-0 lg:w-60">
        <div className="flex items-center gap-2.5 px-4 py-3 lg:flex-col lg:items-start lg:gap-3 lg:px-5 lg:py-5">
          <img
            src={`${import.meta.env.BASE_URL}brand/quoc-duy-mark.png`}
            alt=""
            className="h-9 w-9 shrink-0 rounded-md lg:hidden"
          />
          <img
            src={`${import.meta.env.BASE_URL}brand/quoc-duy-logo.png`}
            alt="Logo Quốc Duy"
            className="hidden w-[131px] rounded-xl lg:block"
          />
          <div>
            <p className="text-sm font-semibold leading-tight">Kiểm tra bản quyền nhạc</p>
            <p className="text-xs text-brand-200">Công cụ nội bộ</p>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                activeTab === tab.id
                  ? 'bg-white font-semibold text-brand-800'
                  : 'text-brand-100 hover:bg-white/10 hover:text-white'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>

        <SoundBars className="mx-5 mb-0 hidden h-14 text-brand-300 opacity-30 lg:flex" />
      </aside>

      <div className="flex min-h-screen flex-col lg:pl-60">
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 lg:px-8">
          <PageHero tab={currentTab} />

          {/* Giữ các tab luôn được mount để đổi tab không làm mất form, kết quả và checklist. */}
          <div hidden={activeTab !== 'video'}>
            <VideoTab library={library} />
          </div>
          <div hidden={activeTab !== 'guide'}>
            <GuideTab />
          </div>
          <div hidden={activeTab !== 'library'}>
            <LibraryTab />
          </div>
        </main>

        <footer className="mx-auto w-full max-w-6xl px-4 pb-6 lg:px-8">
          <p className="flex gap-1.5 text-xs text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Kết quả tra theo luật cố định và danh sách không chính thức, không phải tư vấn pháp lý và không thay thế giấy phép.
            Không chắc chắn thì hỏi bộ phận pháp lý.
          </p>
        </footer>
      </div>
    </div>
  );
}
