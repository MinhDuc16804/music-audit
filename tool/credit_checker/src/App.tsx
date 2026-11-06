import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  BookOpen,
  Database,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Info,
  Library,
  Music,
  Scale,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  User,
} from 'lucide-react';
import { analyzeMusic, buildCatalogIndex, USE_CASE_LABELS } from './analyzer';
import type { AnalysisResult, CatalogIndex, UseCase } from './analyzer';
import { CATALOG, RESOURCE_GROUPS } from './catalog';
import type { CatalogFile, CopyrightStatus, MusicResource } from './catalog';

type TabId = 'checker' | 'guide' | 'library';
type CopyState = 'idle' | 'copied' | 'failed';

interface MusicQuery {
  title: string;
  artist: string;
}

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: 'checker', label: 'Kiểm tra', icon: <Search className="h-4 w-4" /> },
  { id: 'guide', label: 'Checklist & Pháp lý', icon: <BookOpen className="h-4 w-4" /> },
  { id: 'library', label: 'Thư viện nhạc an toàn', icon: <Library className="h-4 w-4" /> },
];

const PRESETS: MusicQuery[] = [
  { title: 'Fur Elise', artist: 'Beethoven' },
  { title: 'Carefree', artist: 'Kevin MacLeod' },
  { title: 'Faded', artist: 'Alan Walker' },
  { title: 'Shape of You', artist: 'Ed Sheeran' },
];

const STATUS_STYLES: Record<CopyrightStatus, { badge: string; icon: ReactNode }> = {
  SAFE: {
    badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    icon: <ShieldCheck className="h-5 w-5" />,
  },
  LICENSED: {
    badge: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
    icon: <ShieldCheck className="h-5 w-5" />,
  },
  WARNING: {
    badge: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    icon: <ShieldAlert className="h-5 w-5" />,
  },
  RESTRICTED: {
    badge: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
    icon: <ShieldX className="h-5 w-5" />,
  },
};

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

interface CatalogState {
  index: CatalogIndex;
  importedCount: number;
  generatedAt?: string;
  isDemo: boolean;
}

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

function CatalogNotice({ catalog }: { catalog: CatalogState }) {
  if (catalog.isDemo) {
    return (
      <p className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
        <strong>Dữ liệu demo, không phải thông tin bản quyền thật.</strong> {catalog.importedCount.toLocaleString('vi-VN')} bài
        được tạo tự động để thử khối lượng lớn. Ví dụ, thử nhập "Bài demo 00042" và "Nghệ sĩ demo 042".
      </p>
    );
  }
  const updatedAt = catalog.generatedAt && new Date(catalog.generatedAt).toLocaleDateString('vi-VN');
  return (
    <p className="mb-6 flex items-center gap-2 text-xs text-slate-400">
      <Database className="h-3.5 w-3.5" />
      {catalog.importedCount > 0
        ? `Dữ liệu của đội: ${catalog.importedCount.toLocaleString('vi-VN')} bài, cập nhật ${updatedAt}.`
        : 'Đang dùng dữ liệu mẫu rất nhỏ kèm theo app.'}
    </p>
  );
}

function ResourceLink({ resource }: { resource: MusicResource }) {
  return (
    <a
      href={resource.url}
      target="_blank"
      rel="noreferrer"
      className="block rounded-xl border border-slate-800 bg-slate-950 p-3 transition hover:border-indigo-500"
    >
      <span className="flex items-center gap-2 text-sm font-medium text-slate-100">
        {resource.name}
        <ExternalLink className="h-3.5 w-3.5 text-slate-500" />
      </span>
      <span className="mt-1 block text-xs text-slate-400">{resource.note}</span>
    </a>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-sm font-semibold text-indigo-300">{title}</h4>
      {children}
    </section>
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
    <Section title="Đoạn ghi nguồn cho phần mô tả">
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300">
        {text}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="mt-2 inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-xs font-medium text-slate-100 transition hover:bg-slate-700"
      >
        {copyState === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copyState === 'copied' ? 'Đã sao chép' : 'Sao chép đoạn ghi nguồn'}
      </button>
      {copyState === 'failed' && (
        <p className="mt-2 text-xs text-rose-300">Trình duyệt chặn sao chép. Hãy bôi đen đoạn trên rồi sao chép thủ công.</p>
      )}
    </Section>
  );
}

function ResultCard({ result }: { result: AnalysisResult }) {
  const style = STATUS_STYLES[result.status];

  return (
    <article className="mt-6 space-y-5 rounded-2xl border border-slate-800 bg-slate-900 p-6" aria-live="polite">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h3 className="text-lg font-bold text-slate-100">
          {result.title}
          {result.artist && ` - ${result.artist}`}
        </h3>
        <span className={`inline-flex w-fit items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-semibold ${style.badge}`}>
          {style.icon}
          {result.statusLabel}
        </span>
      </header>

      <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-xs text-slate-500">Loại giấy phép</dt>
          <dd className="mt-1 text-slate-200">{result.licenseType}</dd>
        </div>
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-xs text-slate-500">Mức rủi ro với mục đích đã chọn</dt>
          <dd className="mt-1 text-slate-200">{result.riskLevel}</dd>
        </div>
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-xs text-slate-500">Quyền sáng tác (Composition)</dt>
          <dd className="mt-1 text-slate-300">{result.compositionRights}</dd>
        </div>
        <div className="rounded-xl bg-slate-950 p-3">
          <dt className="text-xs text-slate-500">Quyền bản thu (Master Recording)</dt>
          <dd className="mt-1 text-slate-300">{result.masterRights}</dd>
        </div>
      </dl>

      <p className="flex gap-2 text-xs text-slate-400">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {result.sourceNote}
      </p>

      {result.attribution && <AttributionHelper text={result.attribution} />}

      <Section title="Việc cần làm">
        <ol className="space-y-2 text-sm text-slate-300">
          {result.steps.map((step, index) => (
            <li key={step} className="flex gap-2">
              <span className="font-semibold text-indigo-400">{index + 1}.</span>
              {step}
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Nguồn nhạc thay thế">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {result.alternatives.map((resource) => (
            <ResourceLink key={resource.name} resource={resource} />
          ))}
        </div>
      </Section>
    </article>
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

  const inputClass =
    'w-full rounded-xl border border-slate-700 bg-slate-950 py-3 pl-10 pr-3 text-sm text-slate-100 outline-none focus:border-indigo-500';

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="relative block">
            <span className="sr-only">Tên bài hát</span>
            <Music className="absolute left-3 top-3.5 h-4 w-4 text-slate-500" />
            <input
              type="text"
              placeholder="Tên bài hát..."
              value={songTitle}
              onChange={(event) => setSongTitle(event.target.value)}
              className={inputClass}
              required
            />
          </label>
          <label className="relative block">
            <span className="sr-only">Tác giả hoặc nghệ sĩ</span>
            <User className="absolute left-3 top-3.5 h-4 w-4 text-slate-500" />
            <input
              type="text"
              placeholder="Tác giả / Nghệ sĩ..."
              value={artistName}
              onChange={(event) => setArtistName(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <label className="block text-sm text-slate-300">
          Mục đích sử dụng
          <select
            value={useCase}
            onChange={(event) => setUseCase(event.target.value as UseCase)}
            className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-100 outline-none focus:border-indigo-500"
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
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3 text-sm font-medium text-white transition hover:bg-indigo-500"
        >
          <Search className="h-4 w-4" />
          Phân tích bản quyền
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Thử nhanh:</span>
          {PRESETS.map((preset) => (
            <button
              key={preset.title}
              type="button"
              onClick={() => handlePreset(preset)}
              className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:border-indigo-500"
            >
              {preset.title} - {preset.artist}
            </button>
          ))}
        </div>
      </form>

      {result && <ResultCard result={result} />}
    </>
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
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="mb-4 flex items-center gap-2 font-semibold">
          <CheckCircle2 className="h-5 w-5 text-indigo-400" />
          Checklist trước khi đăng ({checkedItems.length}/{CHECKLIST_ITEMS.length})
        </h2>
        <ul className="space-y-3">
          {CHECKLIST_ITEMS.map((item) => (
            <li key={item}>
              <label className="flex items-start gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={checkedItems.includes(item)}
                  onChange={() => toggleItem(item)}
                  className="mt-0.5 accent-indigo-500"
                />
                {item}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="flex items-center gap-2 font-semibold">
          <BookOpen className="h-5 w-5 text-indigo-400" />
          Khái niệm cần biết
        </h2>
        {LEGAL_TOPICS.map((topic) => (
          <div key={topic.title}>
            <h3 className="text-sm font-semibold text-indigo-300">{topic.title}</h3>
            <p className="mt-1 text-sm text-slate-400">{topic.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

function LibraryTab() {
  return (
    <div className="space-y-6">
      {RESOURCE_GROUPS.map((group) => (
        <section key={group.title} className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="mb-3 font-semibold">{group.title}</h2>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {group.resources.map((resource) => (
              <ResourceLink key={resource.name} resource={resource} />
            ))}
          </div>
        </section>
      ))}
      <p className="text-xs text-slate-500">Điều khoản của từng nguồn có thể thay đổi, hãy đọc lại trước khi dùng.</p>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('checker');
  const catalog = useCatalog();

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-6 font-sans text-slate-100 md:px-6">
      <header className="mx-auto max-w-5xl border-b border-slate-800 pb-5">
        <div className="flex items-center gap-3">
          <Scale className="h-7 w-7 text-indigo-500" />
          <div>
            <h1 className="text-xl font-bold">Music Copyright Checker</h1>
            <p className="text-xs text-slate-400">Tra cứu theo luật cố định và dữ liệu mẫu, không phải tư vấn pháp lý.</p>
          </div>
        </div>
        <nav className="mt-4 flex flex-wrap gap-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-pressed={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
                activeTab === tab.id ? 'bg-indigo-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto mt-6 max-w-5xl">
        {/* Giữ các tab luôn được mount để đổi tab không làm mất form, kết quả và checklist. */}
        <div hidden={activeTab !== 'checker'}>
          <CatalogNotice catalog={catalog} />
          <CheckerTab catalogIndex={catalog.index} />
        </div>
        <div hidden={activeTab !== 'guide'}>
          <GuideTab />
        </div>
        <div hidden={activeTab !== 'library'}>
          <LibraryTab />
        </div>
      </main>
    </div>
  );
}
