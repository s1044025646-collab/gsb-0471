export interface RawItem {
  id: string;
  p: string;
}

export interface Fraction {
  /** 既约分数分子 */
  num: bigint;
  /** 既约分数分母（恒为 10 的幂，最多 1e12） */
  den: bigint;
}

export interface SortedRow {
  id: string;
  /** 原始十进制字符串，规范化（不去零，保留用户输入） */
  raw: string;
  /** 秩，从 1 开始 */
  rank: number;
  /** 原始 p 的既约比例 */
  p: Fraction;
  /** 调整后 p（既约比例） */
  adj: Fraction;
  /** 调整值最小值实际来源秩 */
  sourceRank: number;
  /** 门槛 i*alpha/m，仅在给定 alpha 的判定报告中存在 */
}

export interface FamilyMeta {
  familyId: string;
  version: number;
  m: number;
  algorithm: string;
  createdAt: string;
  note: string;
}

export interface DecisionItem {
  id: string;
  rank: number;
  p: string;
  threshold: string;
  thresholdFraction: Fraction;
  /** 该项自身门槛比较 p(i) <= i*alpha/m */
  ownPass: boolean;
  /** 是否被最终拒绝集合覆盖（前 cutoffRank 项） */
  rejected: boolean;
  adjustedP: string;
  adjustedFraction: Fraction;
  adjLeAlpha: boolean;
  sourceRank: number;
}

export interface DecisionReport {
  familyId: string;
  version: number;
  alpha: string;
  m: number;
  cutoffRank: number | null;
  rejectedIds: string[];
  rows: DecisionItem[];
  fdrNote: string;
}

export type DiffStatus = "newly_rejected" | "restored" | "unchanged";

export interface VersionDiff {
  fromVersion: number;
  toVersion: number;
  alpha: string;
  added: Array<{ id: string; p?: string }>;
  removed: Array<{ id: string; p?: string }>;
  changed: Array<{ id: string; fromP: string; toP: string }>;
  newlyRejected: string[];
  restored: string[];
  unchangedRejected: string[];
  unchangedRetained: string[];
}
