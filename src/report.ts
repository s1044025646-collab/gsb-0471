// 报告：排序表、逐级判定、调整值、版本比较、JSON/CSV 导出。

import {
  adjDisplay,
  adjFraction,
  cutoffRank,
  type AdjustedRow,
} from "./bh.ts";
import { SCALE, toDisplayDecimal } from "./decimal.ts";
import type { FamilyRecord } from "./store.ts";

export interface DecideRow {
  rank: number;
  id: string;
  pOriginal: string;
  threshold: string; // i*alpha/m 显示小数
  localPass: boolean; // 该项自身门槛比较是否通过
  rejected: boolean; // 是否被最终拒绝集合覆盖
  adjustedFraction: string;
  adjustedDecimal: string;
  sourceRank: number;
}

export interface DecideReport {
  familyId: string;
  version: number;
  algorithmVersion: string;
  m: number;
  alpha: string;
  cutoffRank: number;
  rejectedIds: string[];
  rows: DecideRow[]; // 按秩排序
}

export function buildDecideReport(
  fam: FamilyRecord,
  alphaScaled: bigint,
  alphaOriginal: string,
): DecideReport {
  const m = fam.m;
  const k = cutoffRank(fam.sorted, alphaScaled);
  const rows: DecideRow[] = fam.sorted.map((row) => {
    // 门槛 i*alpha/m，以 SCALE 整数表示
    const thrScaled = (BigInt(row.rank) * alphaScaled) / BigInt(m);
    const localPass =
      row.pScaled * BigInt(m) <= BigInt(row.rank) * alphaScaled;
    return {
      rank: row.rank,
      id: row.id,
      pOriginal: row.pOriginal,
      threshold: toDisplayDecimal(thrScaled),
      localPass,
      rejected: row.rank <= k,
      adjustedFraction: adjFraction(row),
      adjustedDecimal: adjDisplay(row),
      sourceRank: row.sourceRank,
    };
  });
  return {
    familyId: fam.familyId,
    version: fam.version,
    algorithmVersion: fam.algorithmVersion,
    m,
    alpha: alphaOriginal,
    cutoffRank: k,
    rejectedIds: rows.filter((r) => r.rejected).map((r) => r.id),
    rows,
  };
}

export interface AdjustedTableRow {
  id: string;
  inputIndex: number;
  pOriginal: string;
  rank: number;
  adjustedFraction: string;
  adjustedDecimal: string;
  sourceRank: number;
}

// 调整值表，还原到原输入顺序。
export function buildAdjustedTable(fam: FamilyRecord): AdjustedTableRow[] {
  return [...fam.sorted]
    .sort((a, b) => a.inputIndex - b.inputIndex)
    .map((row) => ({
      id: row.id,
      inputIndex: row.inputIndex,
      pOriginal: row.pOriginal,
      rank: row.rank,
      adjustedFraction: adjFraction(row),
      adjustedDecimal: adjDisplay(row),
      sourceRank: row.sourceRank,
    }));
}

export interface VersionCompareReport {
  familyId: string;
  fromVersion: number;
  toVersion: number;
  newlyRejected: string[]; // 新增拒绝（同 alpha 下）
  restoredKept: string[]; // 恢复保留
  unchangedRejected: string[];
  unchangedKept: string[];
  addedIds: string[];
  removedIds: string[];
  alpha: string;
}

export function compareVersions(
  older: FamilyRecord,
  newer: FamilyRecord,
  alphaScaled: bigint,
  alphaOriginal: string,
): VersionCompareReport {
  const rejOld = new Set(
    older.sorted
      .filter((r) => r.rank <= cutoffRank(older.sorted, alphaScaled))
      .map((r) => r.id),
  );
  const rejNew = new Set(
    newer.sorted
      .filter((r) => r.rank <= cutoffRank(newer.sorted, alphaScaled))
      .map((r) => r.id),
  );
  const idsOld = new Set(older.items.map((i) => i.id));
  const idsNew = new Set(newer.items.map((i) => i.id));
  const common = [...idsOld].filter((id) => idsNew.has(id));
  return {
    familyId: newer.familyId,
    fromVersion: older.version,
    toVersion: newer.version,
    alpha: alphaOriginal,
    newlyRejected: common.filter((id) => !rejOld.has(id) && rejNew.has(id)),
    restoredKept: common.filter((id) => rejOld.has(id) && !rejNew.has(id)),
    unchangedRejected: common.filter((id) => rejOld.has(id) && rejNew.has(id)),
    unchangedKept: common.filter((id) => !rejOld.has(id) && !rejNew.has(id)),
    addedIds: [...idsNew].filter((id) => !idsOld.has(id)),
    removedIds: [...idsOld].filter((id) => !idsNew.has(id)),
  };
}

function csvEscape(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function decideReportToCsv(report: DecideReport): string {
  const header =
    "rank,id,p_original,threshold,local_pass,rejected,adjusted_fraction,adjusted_decimal,source_rank";
  const lines = report.rows.map((r) =>
    [
      r.rank,
      csvEscape(r.id),
      r.pOriginal,
      r.threshold,
      r.localPass,
      r.rejected,
      r.adjustedFraction,
      r.adjustedDecimal,
      r.sourceRank,
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

export function adjustedTableToCsv(rows: AdjustedTableRow[]): string {
  const header =
    "id,input_index,p_original,rank,adjusted_fraction,adjusted_decimal,source_rank";
  const lines = rows.map((r) =>
    [
      csvEscape(r.id),
      r.inputIndex,
      r.pOriginal,
      r.rank,
      r.adjustedFraction,
      r.adjustedDecimal,
      r.sourceRank,
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

// 供测试与演示：按秩取行
export function rowAtRank(sorted: AdjustedRow[], rank: number): AdjustedRow {
  return sorted[rank - 1];
}

export { SCALE };
