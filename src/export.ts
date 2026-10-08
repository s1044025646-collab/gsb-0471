import { fracToString, toDisplay } from "./decimal.js";
import type { DecisionReport } from "./types.js";
import type { BhResult } from "./bh.js";

export interface FamilyJson {
  familyId: string;
  version: number;
  m: number;
  inputOrder: string[];
  sortedTable: Array<{
    rank: number;
    id: string;
    p: string;
    pFraction: string;
    adjustedP: string;
    adjustedPFraction: string;
    sourceRank: number;
  }>;
}

/** 导出冻结族的排序表（JSON） */
export function familyToJson(familyId: string, version: number, result: BhResult): FamilyJson {
  return {
    familyId,
    version,
    m: result.m,
    inputOrder: result.inputOrder,
    sortedTable: result.rows.map((r) => ({
      rank: r.rank,
      id: r.id,
      p: r.raw,
      pFraction: fracToString(r.p),
      adjustedP: toDisplay(r.adj).text,
      adjustedPFraction: fracToString(r.adj),
      sourceRank: r.sourceRank,
    })),
  };
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportToCsv(report: DecisionReport): string {
  const header = [
    "rank",
    "id",
    "p",
    "threshold_i*alpha/m",
    "own_pass_p<=threshold",
    "adjusted_p",
    "adjusted_p_fraction",
    "adj<=alpha",
    "rejected_in_final_set",
    "source_rank",
  ];
  const lines = [header.join(",")];
  for (const r of report.rows) {
    lines.push(
      [
        r.rank,
        csvCell(r.id),
        r.p,
        r.threshold,
        r.ownPass ? 1 : 0,
        r.adjustedP,
        fracToString(r.adjustedFraction),
        r.adjLeAlpha ? 1 : 0,
        r.rejected ? 1 : 0,
        r.sourceRank,
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

export function familyToCsv(familyId: string, version: number, result: BhResult): string {
  void familyId;
  void version;
  const header = [
    "rank",
    "id",
    "p",
    "p_fraction",
    "adjusted_p",
    "adjusted_p_fraction",
    "source_rank",
  ];
  const lines = [header.join(",")];
  for (const r of result.rows) {
    lines.push(
      [
        r.rank,
        csvCell(r.id),
        r.raw,
        fracToString(r.p),
        toDisplay(r.adj).text,
        fracToString(r.adj),
        r.sourceRank,
      ].join(",")
    );
  }
  return lines.join("\r\n");
}
