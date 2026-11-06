import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  FileSearch,
  Info,
  Library,
  LoaderCircle,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  TriangleAlert,
  Video,
} from 'lucide-react';
import { analyzeMusic, buildCatalogIndex, USE_CASE_LABELS } from './analyzer';
import type { AnalysisResult, CatalogIndex, UseCase } from './analyzer';
import { CATALOG, RESOURCE_GROUPS } from './catalog';
import type { CatalogFile, CopyrightStatus, MusicResource } from './catalog';
import { getVideoVerdict } from './videoCheck';
import type { IdentifyResult, VideoVerdictKind } from './videoCheck';
import { parseYoutubeVideoId } from './youtubeLink';

type TabId = 'checker' | 'video' | 'guide' | 'library';
type CopyState = 'idle' | 'copied' | 'failed';

interface MusicQuery {
  title: string;
  artist: string;
}

interface CatalogState {
  index: CatalogIndex;
  importedCount: number;
  generatedAt?: string;
  isDemo: boolean;
}

const TABS: { id: TabId; label: string; description: string; icon: ReactNode }[] = [
  {
    id: 'checker',
    label: 'Kiểm tra bài hát',
    description: 'Tra cứu tình trạng bản quyền trước khi đưa một bài nhạc vào sản phẩm.',
    icon: <Search className="h-4 w-4" />,
  },
  {
    id: 'video',
    label: 'Kiểm tra video',
    description: 'Dán link YouTube để máy nhận diện nhạc trong video và đối chiếu với giấy phép của đội.',
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

const PRESETS: MusicQuery[] = [
  { title: 'Fur Elise', artist: 'Beethoven' },
  { title: 'Carefree', artist: 'Kevin MacLeod' },
  { title: 'Faded', artist: 'Alan Walker' },
  { title: 'Shape of You', artist: 'Ed Sheeran' },
];

const STATUS_STYLES: Record<CopyrightStatus, { accent: string; badge: string; decision: string; icon: ReactNode }> = {
  SAFE: {
    accent: 'border-l-emerald-600',
    badge: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    decision: 'Được dùng bản phổ, cần kiểm tra bản thu',
    icon: <ShieldCheck className="h-4 w-4" />,
  },
  LICENSED: {
    accent: 'border-l-sky-600',
    badge: 'bg-sky-50 text-sky-800 ring-sky-200',
    decision: 'Được dùng trong phạm vi giấy phép',
    icon: <ShieldCheck className="h-4 w-4" />,
  },
  WARNING: {
    accent: 'border-l-amber-500',
    badge: 'bg-amber-50 text-amber-800 ring-amber-200',
    decision: 'Chỉ được dùng khi đáp ứng điều kiện',
    icon: <ShieldAlert className="h-4 w-4" />,
  },
  RESTRICTED: {
    accent: 'border-l-rose-600',
    badge: 'bg-rose-50 text-rose-800 ring-rose-200',
    decision: 'Không dùng khi chưa có giấy phép',
    icon: <ShieldX className="h-4 w-4" />,
  },
};

const VERDICT_STYLES: Record<VideoVerdictKind, { accent: string; icon: ReactNode }> = {
  cleared: { accent: 'border-l-sky-600', icon: <ShieldCheck className="h-5 w-5 text-sky-700" /> },
  needs_license: { accent: 'border-l-rose-600', icon: <ShieldX className="h-5 w-5 text-rose-700" /> },
  unknown: { accent: 'border-l-amber-500', icon: <ShieldQuestion className="h-5 w-5 text-amber-700" /> },
  no_music: { accent: 'border-l-slate-400', icon: <ShieldQuestion className="h-5 w-5 text-slate-500" /> },
  error: { accent: 'border-l-slate-400', icon: <ShieldAlert className="h-5 w-5 text-slate-500" /> },
};

const SCAN_RETRY_MS = 15_000;
const MAX_SCAN_ATTEMPTS = 40;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

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

const BUILT_IN_CATALOG: CatalogState = {
  index: buildCatalogIndex(CATALOG),
  importedCount: 0,
  isDemo: false,
};

function isCatalogFile(value: unknown): value is CatalogFile {
  return Array.isArray((value as CatalogFile | null)?.entries);
}

/** Nạp public/catalog.json nếu có. Không có thì dùng dữ liệu mẫu kèm theo app. */
function useCatalog(): CatalogState {
  const [catalog, setCatalog] = useState(BUILT_IN_CATALOG);

  useEffect(() => {
    let isCancelled = false;
    fetch(`${import.meta.env.BASE_URL}catalog.json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((file: unknown) => {
        if (!isCancelled && isCatalogFile(file)) {
          setCatalog({
            index: buildCatalogIndex([...CATALOG, ...file.entries]),
            importedCount: file.entries.length,
            generatedAt: file.generatedAt,
            isDemo: file.isDemo,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      isCancelled = true;
    };
  }, []);

  return catalog;
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-slate-200 bg-white ${className}`}>{children}</div>;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-slate-900">{children}</h3>;
}

function DataStatus({ catalog }: { catalog: CatalogState }) {
  const updatedAt = catalog.generatedAt && new Date(catalog.generatedAt).toLocaleDateString('vi-VN');
  const sourceLabel = catalog.isDemo ? 'Dữ liệu demo' : catalog.importedCount > 0 ? 'Dữ liệu của đội' : 'Dữ liệu mẫu';

  return (
    <div className="text-xs text-slate-500">
      <p className="flex items-center gap-1.5 font-medium text-slate-700">
        <Database className="h-3.5 w-3.5" />
        {sourceLabel}
      </p>
      <p className="mt-1">
        {catalog.importedCount > 0
          ? `${catalog.importedCount.toLocaleString('vi-VN')} bài, cập nhật ${updatedAt}`
          : 'Chỉ gồm vài bài minh họa'}
      </p>
    </div>
  );
}

function DemoBanner({ count }: { count: number }) {
  return (
    <div className="flex gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 lg:px-8">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <strong className="font-semibold">Dữ liệu demo, không phải thông tin bản quyền thật.</strong>{' '}
        {count.toLocaleString('vi-VN')} bài được tạo tự động để thử khối lượng lớn. Ví dụ, thử nhập "Bài demo 00042" và
        "Nghệ sĩ demo 042".
      </p>
    </div>
  );
}

function AttributionHelper({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <section className="space-y-2 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>Đoạn ghi nguồn</SectionTitle>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {copyState === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copyState === 'copied' ? 'Đã sao chép' : 'Sao chép'}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 font-mono text-xs text-slate-700">
        {text}
      </pre>
      {copyState === 'failed' && (
        <p className="text-xs text-rose-700">Trình duyệt chặn sao chép. Hãy bôi đen đoạn trên rồi sao chép thủ công.</p>
      )}
    </section>
  );
}

function ResultRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-5 py-3 text-sm xl:grid-cols-[150px_minmax(0,1fr)] xl:gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}

function ResultCard({ result, useCase }: { result: AnalysisResult; useCase: UseCase }) {
  const style = STATUS_STYLES[result.status];

  return (
    <Panel className="divide-y divide-slate-200 overflow-hidden">
      <header className={`border-l-4 px-5 py-4 ${style.accent}`} aria-live="polite">
        <p className="text-xs text-slate-500">
          {result.title}
          {result.artist && ` - ${result.artist}`}
        </p>
        <h3 className="mt-1 text-lg font-semibold text-slate-900">{style.decision}</h3>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium ring-1 ring-inset ${style.badge}`}>
            {style.icon}
            {result.statusLabel}
          </span>
          <span>Rủi ro: {result.riskLevel}</span>
          <span aria-hidden="true">·</span>
          <span>{USE_CASE_LABELS[useCase]}</span>
        </div>
      </header>

      <dl className="divide-y divide-slate-100">
        <ResultRow label="Loại giấy phép">{result.licenseType}</ResultRow>
        <ResultRow label="Quyền sáng tác">{result.compositionRights}</ResultRow>
        <ResultRow label="Quyền bản thu">{result.masterRights}</ResultRow>
        <ResultRow label="Căn cứ">{result.sourceNote}</ResultRow>
      </dl>

      {result.attribution && <AttributionHelper text={result.attribution} />}

      <section className="space-y-2 px-5 py-4">
        <SectionTitle>Việc cần làm</SectionTitle>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-700 marker:text-slate-400">
          {result.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="space-y-2 px-5 py-4">
        <SectionTitle>Nguồn nhạc thay thế</SectionTitle>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
          {result.alternatives.map((resource) => (
            <li key={resource.name}>
              <a
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                title={resource.note}
                className="inline-flex items-center gap-1 text-brand-700 hover:underline"
              >
                {resource.name}
                <ExternalLink className="h-3 w-3" />
              </a>
            </li>
          ))}
        </ul>
      </section>
    </Panel>
  );
}

function CheckerTab({ catalogIndex }: { catalogIndex: CatalogIndex }) {
  const [songTitle, setSongTitle] = useState('');
  const [artistName, setArtistName] = useState('');
  const [useCase, setUseCase] = useState<UseCase>('youtube_monetized');
  const [query, setQuery] = useState<MusicQuery | null>(null);

  const result = useMemo(
    () => (query ? analyzeMusic({ ...query, useCase }, catalogIndex) : null),
    [query, useCase, catalogIndex],
  );

  // Sửa thông tin bài là xóa kết quả cũ, để không đọc nhầm kết quả của bài trước cho bài mới.
  const handleTitleChange = (value: string) => {
    setSongTitle(value);
    setQuery(null);
  };

  const handleArtistChange = (value: string) => {
    setArtistName(value);
    setQuery(null);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (songTitle.trim()) {
      setQuery({ title: songTitle, artist: artistName });
    }
  };

  const handlePreset = (preset: MusicQuery) => {
    setSongTitle(preset.title);
    setArtistName(preset.artist);
    setQuery(preset);
  };

  const fieldClass =
    'mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600';

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Panel className="p-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Tên bài hát <span className="text-rose-600">*</span>
            <input
              type="text"
              value={songTitle}
              onChange={(event) => handleTitleChange(event.target.value)}
              className={fieldClass}
              required
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Tác giả / Nghệ sĩ
            <input
              type="text"
              value={artistName}
              onChange={(event) => handleArtistChange(event.target.value)}
              className={fieldClass}
            />
            <span className="mt-1 block text-xs font-normal text-slate-500">
              Thiếu thông tin này thì không đối chiếu được với dữ liệu.
            </span>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Mục đích sử dụng
            <select
              value={useCase}
              onChange={(event) => setUseCase(event.target.value as UseCase)}
              className={fieldClass}
            >
              {Object.entries(USE_CASE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800"
          >
            <Search className="h-4 w-4" />
            Kiểm tra
          </button>
        </form>

        <div className="mt-4 border-t border-slate-100 pt-3">
          <p className="text-xs text-slate-500">Ví dụ</p>
          <div className="mt-1.5 flex flex-col items-start gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.title}
                type="button"
                onClick={() => handlePreset(preset)}
                className="text-left text-xs text-brand-700 hover:underline"
              >
                {preset.title} - {preset.artist}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      {result ? (
        <ResultCard result={result} useCase={useCase} />
      ) : (
        <Panel className="flex flex-col items-center px-6 py-16 text-center">
          <FileSearch className="h-8 w-8 text-slate-300" />
          <p className="mt-3 text-sm font-medium text-slate-700">Chưa có kết quả</p>
          <p className="mt-1 text-sm text-slate-500">Nhập thông tin bài hát để xem tình trạng bản quyền.</p>
        </Panel>
      )}
    </div>
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

function VideoTab({ catalogIndex }: { catalogIndex: CatalogIndex }) {
  const [videoLink, setVideoLink] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [useCase, setUseCase] = useState<UseCase>('youtube_monetized');
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [message, setMessage] = useState('');
  const scanIdRef = useRef(0);

  const verdict = useMemo(
    () => (result ? getVideoVerdict(result, useCase, catalogIndex) : null),
    [result, useCase, catalogIndex],
  );

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
    if (!uploadFile && !parseYoutubeVideoId(videoLink)) {
      setMessage('Hãy dán link của một video YouTube hoặc chọn file. Không nhận link kênh hay playlist.');
      return;
    }
    if (uploadFile && uploadFile.size > MAX_UPLOAD_BYTES) {
      setMessage('File lớn hơn 500 MB.');
      return;
    }

    const scanId = scanIdRef.current + 1;
    scanIdRef.current = scanId;
    setResult(null);
    setMessage('');
    setIsScanning(true);

    try {
      for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt += 1) {
        const scan = await (uploadFile ? requestIdentifyFile(uploadFile) : requestIdentify(videoLink));
        if (scanIdRef.current !== scanId) {
          return;
        }
        if (scan.status !== 'processing') {
          setResult(scan);
          setIsScanning(false);
          return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, SCAN_RETRY_MS));
        if (scanIdRef.current !== scanId) {
          return;
        }
      }
      setMessage('ACRCloud chưa quét xong. Bấm Kiểm tra lại sau ít phút, video không bị gửi quét lại.');
    } catch (error) {
      if (scanIdRef.current === scanId) {
        setMessage(error instanceof Error ? error.message : 'Không quét được video.');
      }
    }
    if (scanIdRef.current === scanId) {
      setIsScanning(false);
    }
  };

  const fieldClass =
    'mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-1 focus:ring-brand-600';

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Panel className="p-5">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-slate-700">
            Link video YouTube <span className="text-rose-600">*</span>
            <input
              type="text"
              inputMode="url"
              placeholder="https://www.youtube.com/watch?v=..."
              value={videoLink}
              onChange={(event) => handleLinkChange(event.target.value)}
              className={fieldClass}
            />
            <span className="mt-1 block text-xs font-normal text-slate-500">
              Quét bằng link cần gói AudD trả phí, và video phải đang công khai.
            </span>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Hoặc tải file lên
            <input
              key={uploadFile ? 'co-file' : 'chua-co-file'}
              type="file"
              accept="audio/*,video/*"
              onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-slate-700"
            />
            {uploadFile && <span className="mt-1 block break-all text-xs font-normal text-slate-700">{uploadFile.name}</span>}
            <span className="mt-1 block text-xs font-normal text-slate-500">
              Tối đa 500 MB. File được gửi tới AudD để quét, tốn 1 yêu cầu cho mỗi 12 giây âm thanh.
            </span>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Mục đích sử dụng
            <select
              value={useCase}
              onChange={(event) => setUseCase(event.target.value as UseCase)}
              className={fieldClass}
            >
              {Object.entries(USE_CASE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={isScanning}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-60"
          >
            {isScanning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
            {isScanning ? 'Đang quét...' : 'Kiểm tra video'}
          </button>
        </form>
      </Panel>

      {verdict && result ? (
        <Panel className="divide-y divide-slate-200 overflow-hidden">
          <header className={`border-l-4 px-5 py-4 ${VERDICT_STYLES[verdict.kind].accent}`} aria-live="polite">
            <p className="break-all text-xs text-slate-500">{result.url}</p>
            <h3 className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900">
              {VERDICT_STYLES[verdict.kind].icon}
              {verdict.title}
            </h3>
            <p className="mt-1 text-sm text-slate-600">{verdict.detail}</p>
          </header>

          {verdict.tracks.length > 0 && (
            <section className="space-y-2 px-5 py-4">
              <SectionTitle>Bài máy nhận ra ({verdict.tracks.length})</SectionTitle>
              <ul className="divide-y divide-slate-100">
                {verdict.tracks.map(({ track, analysis }) => (
                  <li key={`${track.title}-${track.artists}`} className="flex flex-col gap-1 py-2 md:flex-row md:items-center md:justify-between md:gap-4">
                    <div className="min-w-0 text-sm">
                      <p className="font-medium text-slate-800">{track.title}</p>
                      <p className="text-xs text-slate-500">
                        {[track.artists, track.label].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <span
                      className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[analysis.status].badge}`}
                    >
                      {STATUS_STYLES[analysis.status].icon}
                      {analysis.statusLabel}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="flex gap-2 px-5 py-3 text-xs text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Không nhận ra bài không có nghĩa là an toàn. Kết quả quét không phải bằng chứng về bản quyền.
            {result.scan_note && ` ${result.scan_note}`}
          </p>
        </Panel>
      ) : (
        <Panel className="flex flex-col items-center px-6 py-16 text-center">
          {isScanning ? (
            <>
              <LoaderCircle className="h-8 w-8 animate-spin text-brand-700" />
              <p className="mt-3 text-sm font-medium text-slate-700">Đang quét video</p>
              <p className="mt-1 text-sm text-slate-500">Có thể mất vài phút. Có thể dừng chờ, video không bị gửi quét lại.</p>
              <button
                type="button"
                onClick={cancelScan}
                className="mt-3 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Dừng chờ
              </button>
            </>
          ) : message ? (
            <>
              <ShieldAlert className="h-8 w-8 text-amber-600" />
              <p className="mt-3 text-sm font-medium text-slate-700">Chưa kiểm tra được</p>
              <p className="mt-1 text-sm text-slate-500">{message}</p>
            </>
          ) : (
            <>
              <Video className="h-8 w-8 text-slate-300" />
              <p className="mt-3 text-sm font-medium text-slate-700">Chưa có kết quả</p>
              <p className="mt-1 text-sm text-slate-500">Dán link video để xem nhạc trong video.</p>
            </>
          )}
        </Panel>
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
        <ul className="mt-4 space-y-3">
          {CHECKLIST_ITEMS.map((item) => (
            <li key={item}>
              <label className="flex items-start gap-2 text-sm text-slate-700">
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

      <Panel className="divide-y divide-slate-100">
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
          <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-900">{group.title}</h2>
          <ul className="divide-y divide-slate-100">
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
  const [activeTab, setActiveTab] = useState<TabId>('checker');
  const catalog = useCatalog();
  const currentTab = TABS.find((tab) => tab.id === activeTab) ?? TABS[0];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <aside className="flex flex-col border-b border-slate-200 bg-white lg:fixed lg:inset-y-0 lg:w-60 lg:border-b-0 lg:border-r">
        <div className="h-1 shrink-0 bg-linear-to-r from-brand-400 to-brand-600" />
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
            <p className="text-xs text-slate-500">Công cụ nội bộ</p>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:flex-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm ${
                activeTab === tab.id
                  ? 'bg-brand-50 font-medium text-brand-800'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="hidden border-t border-slate-200 p-5 lg:block">
          <DataStatus catalog={catalog} />
        </div>
      </aside>

      <div className="flex min-h-screen flex-col lg:pl-60">
        {catalog.isDemo && <DemoBanner count={catalog.importedCount} />}

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 lg:px-8">
          <header className="mb-6">
            <h1 className="text-xl font-semibold">{currentTab.label}</h1>
            <p className="mt-1 text-sm text-slate-600">{currentTab.description}</p>
          </header>

          {/* Giữ các tab luôn được mount để đổi tab không làm mất form, kết quả và checklist. */}
          <div hidden={activeTab !== 'checker'}>
            <CheckerTab catalogIndex={catalog.index} />
          </div>
          <div hidden={activeTab !== 'video'}>
            <VideoTab catalogIndex={catalog.index} />
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
            Kết quả tra theo luật cố định và dữ liệu nội bộ, không phải tư vấn pháp lý và không thay thế giấy phép. Không chắc
            chắn thì hỏi bộ phận pháp lý.
          </p>
          <div className="mt-3 lg:hidden">
            <DataStatus catalog={catalog} />
          </div>
        </footer>
      </div>
    </div>
  );
}
