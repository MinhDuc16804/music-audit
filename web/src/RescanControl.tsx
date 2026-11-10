import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { getRescanCost, savedResultNote } from './rescan';
import { SMALL_BUTTON } from './ui';
import type { IdentifyResult } from './videoCheck';

const BUTTON = `${SMALL_BUTTON} inline-flex items-center gap-1.5`;

/**
 * Nút Quét lại cho một kết quả cũ. Quét lại gửi âm thanh cho AudD lần nữa và tốn yêu cầu,
 * nên luôn hỏi lại kèm chi phí và chỉ gửi khi người dùng bấm xác nhận.
 */
export function RescanControl({
  result,
  start,
  onDone,
}: {
  result: IdentifyResult;
  start: (isCurrent: () => boolean) => Promise<IdentifyResult>;
  onDone: (result: IdentifyResult) => void;
}) {
  const [step, setStep] = useState<'idle' | 'confirming' | 'running'>('idle');
  const [message, setMessage] = useState('');
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const cost = getRescanCost(result);
  const requestText = `${cost.isUpperBound ? 'tối đa ' : 'khoảng '}${cost.requests.toLocaleString('vi-VN')} yêu cầu AudD`;

  const handleConfirm = async () => {
    setStep('running');
    setMessage('');
    try {
      const fresh = await start(() => isMountedRef.current);
      if (isMountedRef.current) {
        setStep('idle');
        onDone(fresh);
      }
    } catch (error) {
      if (isMountedRef.current) {
        setStep('idle');
        setMessage(`Chưa quét lại được, kết quả cũ vẫn giữ nguyên. ${error instanceof Error ? error.message : ''}`.trim());
      }
    }
  };

  return (
    <div className="grid gap-2 text-xs">
      <p className="flex flex-wrap items-center gap-2 text-slate-500">
        {savedResultNote(result.scanned_at)} Lấy lại không tốn yêu cầu AudD.
        <button type="button" disabled={step !== 'idle'} onClick={() => setStep('confirming')} className={BUTTON}>
          {step === 'running' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {step === 'running' ? 'Đang quét lại...' : 'Quét lại'}
        </button>
      </p>
      {step === 'confirming' && (
        <div className="grid gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200" role="alert">
          <p>
            <b className="font-semibold">Quét lại nội dung này?</b> App sẽ gửi lại âm thanh cho AudD: <b className="font-semibold tabular-nums">{requestText}</b> và{' '}
            <b className="font-semibold">1 lượt quét</b> hôm nay của bạn. Kết quả cũ sẽ được thay bằng kết quả mới.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void handleConfirm()} className="rounded-xl bg-brand-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-900">
              Quét lại, tốn {requestText}
            </button>
            <button type="button" onClick={() => setStep('idle')} className={BUTTON}>
              Giữ kết quả cũ
            </button>
          </div>
        </div>
      )}
      {step === 'running' && <p className="text-slate-500">Có thể mất vài phút. Rời trang thì máy chủ vẫn quét nốt, kết quả mới nằm ở tab Lịch sử quét.</p>}
      {message && <p className="text-rose-700">{message}</p>}
    </div>
  );
}
