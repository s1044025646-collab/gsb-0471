import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDecimal, SCALE, toFractionString } from "../src/decimal.ts";
import {
  computeAdjusted,
  sortFamily,
  cutoffRank,
  rejectedByAdjusted,
  rejectedByCutoff,
  type AdjustedRow,
} from "../src/bh.ts";
import { Store, prepareItems } from "../src/store.ts";
import { buildAdjustedTable, buildDecideReport } from "../src/report.ts";

function family(ps: string[], ids?: string[]): AdjustedRow[] {
  const items = ps.map((p, i) => ({
    id: ids?.[i] ?? `H${i + 1}`,
    inputIndex: i,
    pScaled: parseDecimal(p),
    pOriginal: p,
  }));
  return computeAdjusted(sortFamily(items));
}

function adjFractionString(row: AdjustedRow): string {
  return toFractionString(row.adjNum, row.adjDen);
}

// 独立穷举：adj(i) = min(1, min_{j>=i} m*p(j)/j)
function bruteForceAdjusted(sorted: AdjustedRow[]): string[] {
  const m = sorted.length;
  const out: string[] = [];
  for (let i = 1; i <= m; i++) {
    let bestNum = 1n;
    let bestDen = 1n;
    for (let j = i; j <= m; j++) {
      const num = BigInt(m) * sorted[j - 1].pScaled;
      const den = SCALE * BigInt(j);
      if (num * bestDen < bestNum * den) {
        bestNum = num;
        bestDen = den;
      }
    }
    out.push(toFractionString(bestNum, bestDen));
  }
  return out;
}

function checkAgainstBruteForce(sorted: AdjustedRow[]): void {
  const expected = bruteForceAdjusted(sorted);
  for (let i = 0; i < sorted.length; i++) {
    assert.equal(
      adjFractionString(sorted[i]),
      expected[i],
      `秩 ${i + 1} 调整值与穷举结果不一致`,
    );
  }
}

test("十进制解析：合法与非法", () => {
  assert.equal(parseDecimal("0.05"), 50_000_000_000n);
  assert.equal(parseDecimal("1"), SCALE);
  assert.equal(parseDecimal("0.000000000001"), 1n);
  assert.throws(() => parseDecimal("1e-3"), /科学计数/);
  assert.throws(() => parseDecimal("NaN"));
  assert.throws(() => parseDecimal(""));
  assert.throws(() => parseDecimal(null));
  assert.throws(() => parseDecimal("0.0000000000001")); // 13 位小数
  assert.throws(() => parseDecimal("1.000000000001"));
  assert.throws(() => parseDecimal("-0.1"));
  assert.throws(() => parseDecimal("2"));
});

test("已知示例 p=[0.01,0.04,0.03,0.2] 调整值=[0.04,4/75,4/75,0.2]", () => {
  const sorted = family(["0.01", "0.04", "0.03", "0.2"]);
  const byId = new Map(sorted.map((r) => [r.id, r]));
  const inInputOrder = ["H1", "H2", "H3", "H4"].map((id) =>
    adjFractionString(byId.get(id)!),
  );
  assert.deepEqual(inInputOrder, ["1/25", "4/75", "4/75", "1/5"]);
  // 0.04 = 1/25, 0.2 = 1/5
  const k = cutoffRank(sorted, parseDecimal("0.05"));
  assert.equal(k, 1);
  assert.deepEqual([...rejectedByCutoff(sorted, parseDecimal("0.05"))], ["H1"]);
  // 两种拒绝集合计算一致
  assert.deepEqual(
    rejectedByAdjusted(sorted, parseDecimal("0.05")),
    rejectedByCutoff(sorted, parseDecimal("0.05")),
  );
});

test("逐级判定：第一秩未单独通过但最终三项都拒绝", () => {
  const sorted = family(["0.02", "0.03", "0.04"]);
  const alpha = parseDecimal("0.05");
  // 秩1: 0.02 <= 1*0.05/3 ≈ 0.016667? 否
  const m = 3;
  const local1 = sorted[0].pScaled * BigInt(m) <= 1n * alpha;
  assert.equal(local1, false);
  const k = cutoffRank(sorted, alpha);
  assert.equal(k, 3);
  assert.deepEqual(
    [...rejectedByCutoff(sorted, alpha)].sort(),
    ["H1", "H2", "H3"],
  );
});

test("全零与全一", () => {
  const zeros = family(["0", "0", "0"]);
  for (const r of zeros) assert.equal(adjFractionString(r), "0");
  assert.equal(cutoffRank(zeros, parseDecimal("0.05")), 3);
  const ones = family(["1", "1"]);
  for (const r of ones) assert.equal(adjFractionString(r), "1");
  assert.equal(cutoffRank(ones, parseDecimal("1")), 2);
  assert.equal(cutoffRank(ones, parseDecimal("0.999999999999")), 0);
});

test("单项族", () => {
  const sorted = family(["0.3"]);
  assert.equal(adjFractionString(sorted[0]), "3/10");
  assert.equal(cutoffRank(sorted, parseDecimal("0.3")), 1); // 等于门槛算通过
  assert.equal(cutoffRank(sorted, parseDecimal("0.299999999999")), 0);
});

test("重复 p 值得到相同调整值", () => {
  const sorted = family(["0.03", "0.03", "0.03", "0.5"]);
  const fracs = sorted.map(adjFractionString);
  assert.equal(fracs[0], fracs[1]);
  assert.equal(fracs[1], fracs[2]);
  assert.equal(fracs[0], "1/25"); // 4*0.03/3 = 0.04
});

test("门槛精确相等算通过", () => {
  // m=2, alpha=0.1: 秩1 门槛 0.05, 秩2 门槛 0.1
  const sorted = family(["0.05", "0.1"]);
  assert.equal(cutoffRank(sorted, parseDecimal("0.1")), 2);
});

test("输入重排不改变各编号调整值", () => {
  const a = family(["0.01", "0.04", "0.03", "0.2"]);
  const b = family(["0.2", "0.03", "0.01", "0.04"]);
  const mapA = new Map(a.map((r) => [r.pOriginal, adjFractionString(r)]));
  for (const r of b) {
    assert.equal(adjFractionString(r), mapA.get(r.pOriginal));
  }
});

test("增加不显著项改变分母（不剔除大行）", () => {
  const small = family(["0.01", "0.02"]);
  const big = family(["0.01", "0.02", "0.9", "0.95", "0.99"]);
  const adjSmall = new Map(small.map((r) => [r.pOriginal, adjFractionString(r)]));
  const adjBig = new Map(big.map((r) => [r.pOriginal, adjFractionString(r)]));
  // m=2: adj(0.01)=0.02; m=5: adj(0.01)=0.05
  assert.equal(adjSmall.get("0.01"), "1/50");
  assert.equal(adjBig.get("0.01"), "1/20");
});

test("最大精度字符串", () => {
  const sorted = family(["0.000000000001", "0.999999999999"]);
  assert.equal(sorted[0].pScaled, 1n);
  assert.equal(adjFractionString(sorted[0]), "1/500000000000"); // 2*1e-12/1
  checkAgainstBruteForce(sorted);
});

test("调整值性质：不小于原 p、随排序 p 不减、来源秩有效", () => {
  const ps = ["0.01", "0.04", "0.03", "0.2", "0.5", "0.001", "0.9"];
  const sorted = family(ps);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    // adj >= p
    assert.ok(r.adjNum * SCALE >= r.pScaled * r.adjDen, `秩${r.rank} adj >= p`);
    // 单调不减
    if (i > 0) {
      const prev = sorted[i - 1];
      assert.ok(
        prev.adjNum * r.adjDen <= r.adjNum * prev.adjDen,
        `秩${r.rank} 调整值单调`,
      );
    }
    assert.ok(r.sourceRank >= r.rank && r.sourceRank <= sorted.length);
  }
  checkAgainstBruteForce(sorted);
});

test("随机族穷举核对 + 两种拒绝集合一致 + alpha 单调", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 30; trial++) {
    const m = 1 + Math.floor(rand() * 12);
    const ps = Array.from({ length: m }, () =>
      (Math.floor(rand() * 1_000_000) / 1_000_000).toFixed(6),
    );
    const sorted = family(ps);
    checkAgainstBruteForce(sorted);
    for (const alphaStr of ["0.01", "0.05", "0.1", "0.2"]) {
      const alpha = parseDecimal(alphaStr);
      assert.deepEqual(
        rejectedByAdjusted(sorted, alpha),
        rejectedByCutoff(sorted, alpha),
        `trial=${trial} alpha=${alphaStr} 两种拒绝集合不一致`,
      );
    }
    // alpha 单调：已拒绝项目不恢复保留
    let prev = new Set<string>();
    for (const alphaStr of ["0.001", "0.01", "0.05", "0.1", "0.5", "1"]) {
      const cur = rejectedByCutoff(sorted, parseDecimal(alphaStr));
      for (const id of prev) assert.ok(cur.has(id), "alpha 增加后拒绝集合收缩");
      prev = cur;
    }
  }
});

test("存储：幂等导入、版本演进、冻结旧版本、整体拒绝", () => {
  const store = new Store(":memory:");
  const items1 = [
    { id: "H1", p: "0.01" },
    { id: "H2", p: "0.04" },
  ];
  const r1 = store.importFamily("fam", items1);
  assert.equal(r1.created, true);
  assert.equal(r1.record.version, 1);
  const r1again = store.importFamily("fam", items1);
  assert.equal(r1again.created, false);
  assert.equal(r1again.record.version, 1);

  const r2 = store.importFamily("fam", [...items1, { id: "H3", p: "0.9" }]);
  assert.equal(r2.created, true);
  assert.equal(r2.record.version, 2);
  // 旧版本冻结：m 仍为 2
  const v1 = store.getFamily("fam", 1)!;
  assert.equal(v1.m, 2);
  assert.equal(store.getFamily("fam")!.version, 2);

  // 非法输入整体拒绝，不产生新版本
  assert.throws(
    () =>
      store.importFamily("fam", [
        { id: "H1", p: "0.01" },
        { id: "H1", p: "0.02" },
      ]),
    /重复/,
  );
  assert.throws(
    () => store.importFamily("fam", [{ id: "H1", p: "abc" }]),
  );
  assert.deepEqual(store.listVersions("fam"), [1, 2]);
  store.close();
});

test("版本比较：新增拒绝 / 恢复保留 / 未变", async () => {
  const { compareVersions } = await import("../src/report.ts");
  const store = new Store(":memory:");
  store.importFamily("cmp", [
    { id: "A", p: "0.01" },
    { id: "B", p: "0.04" },
  ]);
  store.importFamily("cmp", [
    { id: "A", p: "0.01" },
    { id: "B", p: "0.06" },
  ]);
  const v1 = store.getFamily("cmp", 1)!;
  const v2 = store.getFamily("cmp", 2)!;
  const alpha = parseDecimal("0.05");
  // v1: 0.01<=0.025, 0.04<=0.05 -> 都拒绝; v2: 0.06>0.05 -> 只拒 A
  const report = compareVersions(v1, v2, alpha, "0.05");
  assert.deepEqual(report.restoredKept, ["B"]);
  assert.deepEqual(report.unchangedRejected, ["A"]);
  assert.deepEqual(report.newlyRejected, []);
  store.close();
});

test("决定报告区分局部比较与最终覆盖", () => {
  const store = new Store(":memory:");
  const { record } = store.importFamily("step", [
    { id: "A", p: "0.02" },
    { id: "B", p: "0.03" },
    { id: "C", p: "0.04" },
  ]);
  const report = buildDecideReport(record, parseDecimal("0.05"), "0.05");
  assert.equal(report.cutoffRank, 3);
  const rank1 = report.rows[0];
  assert.equal(rank1.localPass, false); // 自己的门槛比较未通过
  assert.equal(rank1.rejected, true); // 但被最终拒绝集合覆盖
  store.close();
});

test("调整表还原原输入顺序", () => {
  const store = new Store(":memory:");
  const { record } = store.importFamily("ord", [
    { id: "z", p: "0.2" },
    { id: "a", p: "0.01" },
  ]);
  const table = buildAdjustedTable(record);
  assert.deepEqual(table.map((r) => r.id), ["z", "a"]);
  store.close();
});
