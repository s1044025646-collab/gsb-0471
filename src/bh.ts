// BH 核心算法：排序、逐级判定、从后向前单调修正的调整值。
// 全部关键比较使用 BigInt 整数比例（SCALE = 10^12），不依赖显示舍入。

import { SCALE, toFractionString, toDisplayDecimal } from "./decimal.ts";

export const ALGORITHM_VERSION = "BH-1.0";

export interface FamilyItemInput {
  id: string;
  p: string; // 原始十进制字符串
}

export interface SortedRow {
  rank: number; // 从 1 开始
  id: string;
  inputIndex: number; // 原输入顺序下标
  pScaled: bigint; // p * SCALE
  pOriginal: string;
}

export interface AdjustedRow extends SortedRow {
  // 调整值 = min(1, m*p(i)/i, 后一项调整值)，以 (num, den) 既约分数保存
  adjNum: bigint;
  adjDen: bigint;
  sourceRank: number; // 最小值实际来源的秩；并列取较小秩
}

export interface FamilyResult {
  m: number;
  sorted: AdjustedRow[]; // 按排序秩
}

export type FamilyErrorCode = "DUPLICATE_ID" | "EMPTY_ID" | "FAMILY_SIZE";

export class FamilyError extends Error {
  readonly code: FamilyErrorCode;
  constructor(code: FamilyErrorCode, message: string) {
    super(message);
    this.name = "FamilyError";
    this.code = code;
  }
}

export const MIN_FAMILY_SIZE = 1;
export const MAX_FAMILY_SIZE = 10_000;

// 稳定排序：p 升序；p 相同按编号字典序；再相同（不可能，编号唯一）按输入下标。
export function sortFamily(
  items: { id: string; inputIndex: number; pScaled: bigint; pOriginal: string }[],
): SortedRow[] {
  const arr = [...items];
  arr.sort((a, b) => {
    if (a.pScaled !== b.pScaled) return a.pScaled < b.pScaled ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return a.inputIndex - b.inputIndex;
  });
  return arr.map((it, i) => ({ ...it, rank: i + 1 }));
}

// 计算调整值：从末尾向前递推。
// adj(i) = min(1, m*p(i)/i, adj(i+1))；来源秩取取得最小值的秩，并列取较小秩。
export function computeAdjusted(sorted: SortedRow[]): AdjustedRow[] {
  const m = sorted.length;
  const result: AdjustedRow[] = new Array(m);
  // 当前累积最小值（分数 curNum/curDen）与其来源秩
  let curNum = 1n;
  let curDen = 1n;
  let curSource = m;
  for (let i = m; i >= 1; i--) {
    const row = sorted[i - 1];
    // 候选1: 1；候选2: m*p/i；候选3: 当前累积值
    // 先比较 m*p/i 与 1
    const mpNum = BigInt(m) * row.pScaled;
    const mpDen = SCALE * BigInt(i);
    let bestNum: bigint;
    let bestDen: bigint;
    let bestSource: number;
    if (mpNum * curDen <= curNum * mpDen) {
      // m*p/i <= 当前累积值（含 1 的候选，因为初始累积值就是 1）
      bestNum = mpNum;
      bestDen = mpDen;
      bestSource = i;
    } else {
      bestNum = curNum;
      bestDen = curDen;
      bestSource = curSource;
    }
    // 与 1 比较（截断到 1）
    if (bestNum > bestDen) {
      bestNum = 1n;
      bestDen = 1n;
      bestSource = i;
    }
    curNum = bestNum;
    curDen = bestDen;
    curSource = bestSource;
    result[i - 1] = { ...row, adjNum: bestNum, adjDen: bestDen, sourceRank: bestSource };
  }
  return result;
}

// 逐级判定：找满足 p(i) <= i*alpha/m 的最大 i；前 i 项拒绝。
// 返回截止秩 k（0 表示全部保留）。
export function cutoffRank(sorted: SortedRow[], alphaScaled: bigint): number {
  const m = sorted.length;
  let k = 0;
  for (let i = 1; i <= m; i++) {
    // p(i) <= i*alpha/m  <=>  p*m <= i*alpha（均为 SCALE 整数）
    const lhs = sorted[i - 1].pScaled * BigInt(m);
    const rhs = BigInt(i) * alphaScaled;
    if (lhs <= rhs) k = i;
  }
  return k;
}

// 用调整值判定：adj <= alpha 的集合。应与截止秩法完全一致。
export function rejectedByAdjusted(
  sorted: AdjustedRow[],
  alphaScaled: bigint,
): Set<string> {
  const set = new Set<string>();
  for (const row of sorted) {
    // adj <= alpha  <=>  adjNum*SCALE <= alpha*adjDen
    if (row.adjNum * SCALE <= alphaScaled * row.adjDen) {
      set.add(row.id);
    }
  }
  return set;
}

export function rejectedByCutoff(sorted: SortedRow[], alphaScaled: bigint): Set<string> {
  const k = cutoffRank(sorted, alphaScaled);
  const set = new Set<string>();
  for (let i = 1; i <= k; i++) set.add(sorted[i - 1].id);
  return set;
}

export function adjToScaled(row: AdjustedRow): bigint {
  // 仅供显示/导出：向下取整到 SCALE 整数（判定不使用）
  return (row.adjNum * SCALE) / row.adjDen;
}

export function adjFraction(row: AdjustedRow): string {
  return toFractionString(row.adjNum, row.adjDen);
}

export function adjDisplay(row: AdjustedRow): string {
  return toDisplayDecimal(adjToScaled(row));
}
