import { cmpFrac, compareId, fracMulDiv, minFrac, parseDecimal, reduce, toDisplay } from "./decimal.js";
import { BhError } from "./errors.js";
import type {
  DecisionItem,
  DecisionReport,
  Fraction,
  RawItem,
  SortedRow,
  VersionDiff,
} from "./types.js";

export const ALGORITHM_VERSION = "BH-1.0";
export const MAX_M = 10000;
const ONE: Fraction = { num: 1n, den: 1n };

export interface ValidatedItem {
  id: string;
  raw: string;
  p: Fraction;
}

/**
 * 校验整族输入：编号唯一非空，1..10000 条，p 为合法十进制。
 * 任何一条失败都整体拒绝（原子性）。
 */
export function validateItems(items: unknown): ValidatedItem[] {
  if (!Array.isArray(items)) {
    throw new BhError("BAD_REQUEST", "items 必须是数组");
  }
  if (items.length === 0) {
    throw new BhError("EMPTY_FAMILY", "检验族至少包含 1 条检验");
  }
  if (items.length > MAX_M) {
    throw new BhError("TOO_MANY_TESTS", `每族最多 ${MAX_M} 条检验，收到 ${items.length}`);
  }
  const seen = new Set<string>();
  const out: ValidatedItem[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (typeof it !== "object" || it === null) {
      throw new BhError("BAD_REQUEST", `第 ${idx + 1} 项必须是对象`);
    }
    const id = (it as { id?: unknown }).id;
    const p = (it as { p?: unknown }).p;
    if (id === undefined || p === undefined) {
      throw new BhError("MISSING_FIELD", `第 ${idx + 1} 项缺少 id 或 p 字段`);
    }
    if (typeof id !== "string" || id.trim() === "") {
      throw new BhError("EMPTY_ID", `第 ${idx + 1} 项编号必须是非空字符串`);
    }
    if (id.trim() !== id || id.length !== id.trim().length) {
      // 允许 id 本身含空格，但不允许纯空白；保持原始 id
    }
    if (seen.has(id)) {
      throw new BhError("DUPLICATE_ID", `编号重复：${id}`, { id });
    }
    seen.add(id);
    const frac = parseDecimal(p, `编号 ${id} 的 p 值`);
    out.push({ id, raw: String(p), p: frac });
  }
  return out;
}

/** 稳定排序：p 升序，相同 p 按编号字典序。 */
export function stableSort(items: ValidatedItem[]): ValidatedItem[] {
  return [...items]
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => {
      const c = cmpFrac(a.it.p, b.it.p);
      if (c !== 0) return c;
      const ci = compareId(a.it.id, b.it.id);
      if (ci !== 0) return ci;
      return a.idx - b.idx;
    })
    .map((x) => x.it);
}

export interface BhResult {
  m: number;
  rows: SortedRow[];
  /** 按原输入顺序的行（id 索引） */
  byId: Map<string, SortedRow>;
  inputOrder: string[];
}

/**
 * BH 核心：
 * 调整值从末尾向前递推：
 *   adj(m) = min(1, m*p(m)/m) = min(1, p(m))
 *   adj(i) = min(1, m*p(i)/i, adj(i+1))
 * 相同 p 必须得到相同调整值；最小来源秩并列时取较小秩。
 */
export function runBh(rawItems: RawItem[]): BhResult {
  const validated = validateItems(rawItems);
  const sorted = stableSort(validated);
  const m = sorted.length;
  const mBig = BigInt(m);

  // 先计算每个秩的原始候选 q(i) = min(1, m*p(i)/i)
  const candidates: Fraction[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    const raw = fracMulDiv(sorted[i].p, mBig, BigInt(rank));
    candidates[i] = minFrac(ONE, raw);
  }

  // 独立穷举：对每个后缀 j..m 取最小 m*p(k)/k（再与 1 取 min），
  // 作为从后向前递推结果的核对基准。
  const brute: Fraction[] = new Array(m);
  let running = candidates[m - 1];
  for (let i = m - 1; i >= 0; i--) {
    if (cmpFrac(candidates[i], running) < 0) running = candidates[i];
    brute[i] = running;
  }

  // 相同 p 调整值必须相同：对 p 相等的秩块，取块内最小调整值。
  const adj: Fraction[] = brute.slice();
  for (let i = 0; i < m; ) {
    let j = i;
    while (j + 1 < m && cmpFrac(sorted[j + 1].p, sorted[i].p) === 0) j++;
    if (j > i) {
      let blockMin = adj[i];
      for (let k = i + 1; k <= j; k++) {
        if (cmpFrac(adj[k], blockMin) < 0) blockMin = adj[k];
      }
      for (let k = i; k <= j; k++) adj[k] = blockMin;
    }
    i = j + 1;
  }

  // 来源秩：调整值是从该秩起整个后缀候选的最小值，
  // 因此在块起点开始的整个后缀中找第一个命中候选的秩（即最小秩）。
  const sourceRank: number[] = new Array(m);
  for (let i = 0; i < m; ) {
    let j = i;
    while (j + 1 < m && cmpFrac(sorted[j + 1].p, sorted[i].p) === 0) j++;
    const target = adj[i];
    let src = -1;
    for (let k = i; k < m; k++) {
      if (cmpFrac(candidates[k], target) === 0) {
        src = k + 1;
        break; // 从前往后，第一个即最小秩
      }
    }
    if (src === -1) throw new BhError("INTERNAL", "无法确定调整值来源秩");
    for (let k = i; k <= j; k++) sourceRank[k] = src;
    i = j + 1;
  }

  // 单调性与不小于原 p 的不变量检查
  for (let i = 0; i < m; i++) {
    if (cmpFrac(adj[i], sorted[i].p) < 0) {
      throw new BhError("INTERNAL", "调整值小于原 p，算法不变量被破坏");
    }
    if (i > 0 && cmpFrac(adj[i], adj[i - 1]) < 0) {
      throw new BhError("INTERNAL", "调整值不满足随排序 p 不减");
    }
  }

  const rows: SortedRow[] = sorted.map((it, i) => ({
    id: it.id,
    raw: it.raw,
    rank: i + 1,
    p: it.p,
    adj: adj[i],
    sourceRank: sourceRank[i],
  }));
  const byId = new Map<string, SortedRow>();
  for (const r of rows) byId.set(r.id, r);
  return { m, rows, byId, inputOrder: validated.map((v) => v.id) };
}

/**
 * 截止秩法：最大的使 p(i) <= i*alpha/m 的 i；前 i 项全部拒绝。
 */
export function cutoffRank(rows: SortedRow[], alpha: Fraction): number | null {
  const m = rows.length;
  const mBig = BigInt(m);
  let cutoff: number | null = null;
  for (const r of rows) {
    const threshold = fracMulDiv(alpha, BigInt(r.rank), mBig);
    if (cmpFrac(r.p, threshold) <= 0) cutoff = r.rank; // 等于算通过；取最大
  }
  return cutoff;
}

const FDR_NOTE =
  "BH 控制错误发现率(FDR)的期望值：在独立性或特定正相关(PRDS)条件下，FDR 期望不超过 m0/m*alpha；" +
  "不表示本次拒绝集合中错误拒绝数一定低于某个整数，也不表示任一假设为真的概率，" +
  "任意相关性结构下不保证同一界值。";

export interface ReportInput {
  familyId: string;
  version: number;
  result: BhResult;
  alphaInput: string;
}

export function decide({ familyId, version, result, alphaInput }: ReportInput): DecisionReport {
  const alpha = parseDecimal(alphaInput, "alpha 显著性水平");
  if (cmpFrac(alpha, ONE) > 0 || cmpFrac(alpha, { num: 0n, den: 1n }) < 0) {
    throw new BhError("OUT_OF_RANGE", "alpha 必须在 [0,1] 区间");
  }
  const { rows, m } = result;
  const cutoff = cutoffRank(rows, alpha);

  const decisionRows: DecisionItem[] = rows.map((r) => {
    const threshold = fracMulDiv(alpha, BigInt(r.rank), BigInt(m));
    const ownPass = cmpFrac(r.p, threshold) <= 0;
    const rejected = cutoff !== null && r.rank <= cutoff;
    const adjLeAlpha = cmpFrac(r.adj, alpha) <= 0;
    if (adjLeAlpha !== rejected) {
      throw new BhError(
        "INTERNAL",
        `截止秩法与调整值法结果不一致：id=${r.id} cutoff=${cutoff} adj<=alpha=${adjLeAlpha}`
      );
    }
    return {
      id: r.id,
      rank: r.rank,
      p: r.raw,
      threshold: toDisplay(threshold).text,
      thresholdFraction: threshold,
      ownPass,
      rejected,
      adjustedP: toDisplay(r.adj).text,
      adjustedFraction: r.adj,
      adjLeAlpha,
      sourceRank: r.sourceRank,
    };
  });

  return {
    familyId,
    version,
    alpha: alphaInput,
    m,
    cutoffRank: cutoff,
    rejectedIds: cutoff === null ? [] : rows.filter((r) => r.rank <= cutoff).map((r) => r.id),
    rows: decisionRows,
    fdrNote: FDR_NOTE,
  };
}

export function diffVersions(
  from: { version: number; result: BhResult },
  to: { version: number; result: BhResult },
  alphaInput: string
): VersionDiff {
  const alpha = parseDecimal(alphaInput, "alpha 显著性水平");
  const rA = decide({
    familyId: "",
    version: from.version,
    result: from.result,
    alphaInput,
  });
  const rB = decide({
    familyId: "",
    version: to.version,
    result: to.result,
    alphaInput,
  });
  const mapA = new Map(rA.rows.map((r) => [r.id, r]));
  const mapB = new Map(rB.rows.map((r) => [r.id, r]));
  const rawA = new Map(from.result.rows.map((r) => [r.id, r]));
  const rawB = new Map(to.result.rows.map((r) => [r.id, r]));

  const added: Array<{ id: string; p?: string }> = [];
  const removed: Array<{ id: string; p?: string }> = [];
  const changed: Array<{ id: string; fromP: string; toP: string }> = [];
  const newlyRejected: string[] = [];
  const restored: string[] = [];
  const unchangedRejected: string[] = [];
  const unchangedRetained: string[] = [];

  for (const [id, b] of mapB) {
    const a = mapA.get(id);
    if (!a) {
      added.push({ id, p: rawB.get(id)?.raw });
      continue;
    }
    if (rawA.get(id)!.raw !== rawB.get(id)!.raw) {
      changed.push({ id, fromP: rawA.get(id)!.raw, toP: rawB.get(id)!.raw });
    }
    if (!a.rejected && b.rejected) newlyRejected.push(id);
    else if (a.rejected && !b.rejected) restored.push(id);
    else if (b.rejected) unchangedRejected.push(id);
    else unchangedRetained.push(id);
  }
  for (const [id] of mapA) {
    if (!mapB.has(id)) removed.push({ id, p: rawA.get(id)?.raw });
  }

  return {
    fromVersion: from.version,
    toVersion: to.version,
    alpha: alphaInput,
    added,
    removed,
    changed,
    newlyRejected,
    restored,
    unchangedRejected,
    unchangedRetained,
  };
}

export { reduce };
