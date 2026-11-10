import { useEffect, useRef, useState } from 'react';
import type { ScanNotice, SeenStatus } from './scanNotice';

/** Lưu trong trình duyệt của từng người, không gửi đi đâu. */
const STORAGE_KEY = 'credit-checker:notify';
const CHANGE_EVENT = 'credit-checker:notify-change';

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEnabled(value: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Trình duyệt chặn lưu thì công tắc chỉ có tác dụng tới khi tải lại trang.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

let baseTitle = '';

/** Thêm nhãn vào tiêu đề tab khi người dùng đang ở tab khác, bỏ đi khi họ quay lại. */
function markTabTitle(label: string) {
  if (!document.hidden) {
    return;
  }
  baseTitle ||= document.title;
  document.title = `${label} ${baseTitle}`;
  const restore = () => {
    if (!document.hidden) {
      document.title = baseTitle;
      document.removeEventListener('visibilitychange', restore);
    }
  };
  document.addEventListener('visibilitychange', restore);
}

function showNotice(notice: ScanNotice) {
  if (!readEnabled()) {
    return;
  }
  markTabTitle(notice.tabLabel);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(notice.title, { body: notice.body, icon: `${import.meta.env.BASE_URL}brand/quoc-duy-mark.png`, tag: notice.title });
  }
}

/** Báo khi trạng thái đổi so với lần trước app thấy. Lần đầu chỉ ghi nhận, không báo. */
export function useScanNotice<Status, Value>(
  value: Value | null,
  getSeen: (value: Value) => SeenStatus<Status>,
  describe: (previous: SeenStatus<Status> | null, value: Value | null) => ScanNotice | null,
) {
  const previousRef = useRef<SeenStatus<Status> | null>(null);
  useEffect(() => {
    const notice = describe(previousRef.current, value);
    if (notice) {
      showNotice(notice);
    }
    previousRef.current = value ? getSeen(value) : null;
  }, [value]);
}

/** Công tắc dùng chung giữa các tab: bật ở tab này thì tab kia cũng bật. */
export function NotifySwitch({ id }: { id: string }) {
  const [enabled, setEnabled] = useState(readEnabled);
  const [hint, setHint] = useState('');

  useEffect(() => {
    const sync = () => setEnabled(readEnabled());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);

  const handleChange = async (checked: boolean) => {
    writeEnabled(checked);
    setEnabled(checked);
    if (!checked) {
      setHint('');
      return;
    }
    if (!('Notification' in window)) {
      setHint('Trình duyệt này không hiện được thông báo, app chỉ đổi tiêu đề tab.');
      return;
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission().catch(() => 'denied' as const) : Notification.permission;
    setHint(permission === 'granted' ? 'Chỉ báo được khi app còn mở ở một tab.' : 'Trình duyệt chưa cho hiện thông báo, app chỉ đổi tiêu đề tab. Có thể cho phép lại trong cài đặt trang.');
  };

  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-700">
        <input id={id} type="checkbox" className="accent-brand-700" checked={enabled} onChange={(event) => void handleChange(event.target.checked)} />
        Báo cho tôi khi quét xong
      </label>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
