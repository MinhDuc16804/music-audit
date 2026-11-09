import { useState } from 'react';
import type { ReactNode } from 'react';
import { ExternalLink, Music, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { needsStudioLookup } from './videoCheck';
import type { CheckedTrack } from './videoCheck';

/** "UC" không kèm mã kênh: Studio tự chuyển sang kênh của tài khoản đang đăng nhập. */
const STUDIO_MUSIC_URL = 'https://studio.youtube.com/channel/UC/music';

/** Chiều cao các thanh sóng âm trang trí, tính theo phần trăm. */
const SOUND_BAR_HEIGHTS = [35, 62, 48, 86, 58, 100, 70, 44, 78, 54, 92, 40, 66, 84, 50, 30];

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-brand-100 bg-white shadow-card ${className}`}>{children}</div>;
}

export function SoundBars({ className = '' }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`sound-bars ${className}`}>
      {SOUND_BAR_HEIGHTS.map((height, position) => (
        <span key={position} style={{ height: `${height}%`, animationDelay: `${position * -0.17}s` }} />
      ))}
    </div>
  );
}

export function IconBadge({ children }: { children: ReactNode }) {
  return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">{children}</span>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-slate-900">{children}</h3>;
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

/** Danh sách bài máy nhận ra trong một video, kèm mức khớp với thư viện. */
export function TrackList({ tracks }: { tracks: CheckedTrack[] }) {
  return (
    <ul className="divide-y divide-slate-100">
      {tracks.map(({ track, libraryTrack, nearTrack, isDoubtful, isIgnored }) => (
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
  );
}
