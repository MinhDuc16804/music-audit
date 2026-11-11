/**
 * Gắn ngân sách AudD tháng vào các lượt quét: giữ chỗ trước khi gửi, tính theo số thật khi xong.
 * Ngân sách tắt (thiếu AUDD_MONTHLY_BUDGET) thì mọi lượt đều được qua, các hàm không làm gì.
 */

import { join } from 'node:path';
import { DEFAULT_MAX_SCAN_SECONDS } from '../src/batchScan.ts';
import { budgetRefusal, requestsForSeconds } from '../src/budget.ts';
import type { BudgetKind } from '../src/budget.ts';
import { SCAN_SEGMENT_SECONDS } from '../src/videoCheck.ts';
import type { IdentifyResult } from '../src/videoCheck.ts';
import { createMonthlyBudget, parseBudgetConfig } from './monthlyBudget.ts';
import type { BudgetHold, BudgetLedger } from './monthlyBudget.ts';
import { createStateFile } from './stateFile.ts';

/** Ngân sách tháng không đủ cho lượt quét. */
export class BudgetError extends Error {}

/**
 * Trần quét mỗi video theo AUDD_MAX_CHUNKS, như bên Python, để giữ chỗ ngân sách đúng bằng số Python có thể gửi.
 * Biến sai thì Python đã từ chối chạy; ở đây dùng mặc định 60 phút để không giữ chỗ thiếu.
 */
export function getMaxScanSeconds(env: Record<string, string | undefined> = process.env): number {
  const chunks = Number(env.AUDD_MAX_CHUNKS?.trim() || Number.NaN);
  return Number.isInteger(chunks) && chunks > 0 ? chunks * SCAN_SEGMENT_SECONDS : DEFAULT_MAX_SCAN_SECONDS;
}

const LEDGER_BROKEN = (month: string) =>
  `Sổ chi AudD tháng này (out/budget/${month}.json) không đọc được nên app tạm chặn mọi lượt quét, để không đếm lại ngân sách từ 0. Nhờ người quản trị sửa hoặc khôi phục file.`;

export interface BudgetGuardDeps {
  getOutFolder: () => string;
  isCached: (videoId: string) => boolean;
  /** Độ dài video trên YouTube, cùng trần quét mỗi video. Lỗi thì trả về null. */
  readDurations: (videoId: string) => Promise<{ max_seconds?: number; videos?: Record<string, number> } | null>;
  env?: Record<string, string | undefined>;
}

export function createBudgetGuard({ getOutFolder, isCached, readDurations, env = process.env }: BudgetGuardDeps) {
  // Sổ chi AudD mỗi tháng một file trong out/budget/.
  const ledgerFiles = new Map<string, ReturnType<typeof createStateFile<BudgetLedger>>>();
  const ledgerFile = (month: string) => {
    let file = ledgerFiles.get(month);
    if (!file) {
      file = createStateFile<BudgetLedger>(() => join(getOutFolder(), 'budget', `${month}.json`), 'sổ chi AudD');
      ledgerFiles.set(month, file);
    }
    return file;
  };
  const budgetConfig = parseBudgetConfig(env);
  const budget = budgetConfig
    ? createMonthlyBudget(budgetConfig, { readSync: (month) => ledgerFile(month).readSyncStrict(), write: (ledger) => ledgerFile(ledger.month).write(ledger) })
    : null;
  const budgetView = () => budget?.view() ?? null;

  /** Giữ chỗ trong ngân sách tháng. Ngân sách tắt hoặc không tốn gì thì trả về null. Không đủ thì ném BudgetError. */
  const reserveBudget = (user: string, kind: BudgetKind, requests: number): BudgetHold | null => {
    if (!budget || requests <= 0) {
      return null;
    }
    if (budget.isBroken()) {
      throw new BudgetError(LEDGER_BROKEN(budget.view().month));
    }
    const hold = budget.reserve(user, kind, requests);
    if (!hold) {
      throw new BudgetError(budgetRefusal(requests, budget.view()));
    }
    return hold;
  };

  /** Số yêu cầu AudD lượt quét đã gửi thật: kết quả cũ thì 0, chưa biết độ dài thì tính trần. */
  const usedRequests = (result: IdentifyResult) =>
    result.cached ? 0 : requestsForSeconds(result.duration_seconds ?? 0, result.max_seconds ?? getMaxScanSeconds(env));

  /** Ước tính yêu cầu cho một video theo độ dài trên YouTube. Không đọc được độ dài thì tính trần. */
  const estimateVideoRequests = async (videoId: string, rescan: boolean) => {
    if (!budget || (!rescan && isCached(videoId))) {
      return 0;
    }
    const info = await readDurations(videoId).catch(() => null);
    return requestsForSeconds(info?.videos?.[videoId] ?? 0, info?.max_seconds ?? getMaxScanSeconds(env));
  };

  /**
   * Quét có giữ chỗ ngân sách: xong thì tính theo số thật. Lỗi thì giữ nguyên phần đã tính,
   * vì không biết AudD đã nhận bao nhiêu yêu cầu trước khi lỗi, thừa còn hơn thiếu.
   */
  const withBudget = async (hold: BudgetHold | null, scan: () => Promise<IdentifyResult>) => {
    try {
      const result = await scan();
      budget?.settle(hold, usedRequests(result));
      return result;
    } catch (error) {
      budget?.settle(hold, hold?.requests ?? 0);
      throw error;
    }
  };

  /** Ước tính yêu cầu cho một video theo độ dài trên YouTube rồi giữ chỗ. Không đủ thì ném BudgetError. */
  const reserveVideo = async (user: string, kind: BudgetKind, videoId: string, rescan: boolean) =>
    reserveBudget(user, kind, await estimateVideoRequests(videoId, rescan));

  /** File tải lên chưa biết độ dài trước khi nhận, nên giữ chỗ theo trần. Quét xong tính theo độ dài thật và trả lại phần thừa. */
  const reserveUpload = (user: string) => reserveBudget(user, 'file', requestsForSeconds(0, getMaxScanSeconds(env)));

  return { budget, budgetView, reserveBudget, reserveUpload, reserveVideo, withBudget };
}

export type BudgetGuard = ReturnType<typeof createBudgetGuard>;
