import { test } from "node:test";
import assert from "node:assert/strict";
import { cmpFrac, fracMulDiv, parseDecimal, toDisplay } from "../src/decimal.js";
import { BhError } from "../src/errors.js";
import { decide, diffVersions, runBh, validateItems } from "../src/bh.js";
import type { Fraction, RawItem } from "../src/types.js";

function ids(items: Array<{ id: string }>): string[] {
  return items.map((i) => i.id);
}

test("示例1: p=[0.01,0.04,0.03,0.2] 调整值 [0.04,4/75,4/75,0.2]", () => {
  const items: RawItem[] = [
    { id: "a", p: "0.01" },
    { id: "b", p: "0.04" },
    { id: "c", p: "0.03" },
    { id: "d", p: "0.2" },
  ];
  const r = runBh(items);
  const adj = (id: string) => r.byId.get(id)!.adj;
  assert.equal(toDisplay(adj("a")).text, "0.04");
  assert.equal(`${adj("b").num}/${adj("b").den}`, "4/75");
  assert.equal(`${adj("c").num}/${adj("c").den}`, "4/75");
  assert.equal(toDisplay(adj("d")).text, "0.2");
  const report = decide({ familyId: "f", version: 1, result: r, alphaInput: "0.05" });
  assert.deepEqual(report.rejectedIds, ["a"]);
  assert.equal(report.cutoffRank, 1);
});

test("示例2: p=[0.02,0.03,0.04] 第一秩自身不通过但三项全拒绝", () => {
  const items: RawItem[] = [
    { id: "x", p: "0.02" },
    { id: "y", p: "0.03" },
    { id: "z", p: "0.04" },
  ];
  const r = runBh(items);
  const report = decide({ familyId: "f", version: 1, result: r, alphaInput: "0.05" });
  assert.equal(report.cutoffRank, 3);
  assert.deepEqual(new Set(report.rejectedIds), new Set(["x", "y", "z"]));
  // 第一秩自身比较：0.02 <= 1*0.05/3 = 0.01666... 为 false
  assert.equal(report.rows.find((row) => row.rank === 1)!.ownPass, false);
  // 但它被最终拒绝集合覆盖
  assert.equal(report.rows.find((row) => row.rank === 1)!.rejected, true);
  // 第三秩自身通过 0.04 <= 0.05
  assert.equal(report.rows.find((row) => row.rank === 3)!.ownPass, true);
});

test("全零 p：全部拒绝，调整值为 0", () => {
  const items = [0, 1, 2].map((i) => ({ id: `z${i}`, p: "0.000" }));
  const r = runBh(items);
  for (const row of r.rows) assert.equal(cmpFrac(row.adj, { num: 0n, den: 1n }), 0);
  const report = decide({ familyId: "f", version: 1, result: r, alphaInput: "0" });
  assert.equal(report.cutoffRank, 3);
  assert.equal(report.rejectedIds.length, 3);
});

test("全一 p：alpha<1 时全部保留", () => {
  const items = [0, 1, 2].map((i) => ({ id: `o${i}`, p: "1" }));
  const r = runBh(items);
  for (const row of r.rows) assert.equal(toDisplay(row.adj).text, "1");
  const report = decide({ familyId: "f", version: 1, result: r, alphaInput: "0.05" });
  assert.equal(report.cutoffRank, null);
  assert.deepEqual(report.rejectedIds, []);
  // alpha=1 且门槛精确相等：全部拒绝
  const report1 = decide({ familyId: "f", version: 1, result: r, alphaInput: "1" });
  assert.equal(report1.cutoffRank, 3);
});

test("单项检验", () => {
  const r = runBh([{ id: "solo", p: "0.03" }]);
  assert.equal(r.m, 1);
  assert.equal(toDisplay(r.byId.get("solo")!.adj).text, "0.03");
  const rep = decide({ familyId: "f", version: 1, result: r, alphaInput: "0.05" });
  assert.deepEqual(rep.rejectedIds, ["solo"]);
});

test("重复 p 得到相同调整值，来源秩取较小秩", () => {
  const items: RawItem[] = [
    { id: "k1", p: "0.1" },
    { id: "k2", p: "0.1" },
    { id: "k3", p: "0.1" },
  ];
  const r = runBh(items);
  const a1 = r.rows[0].adj;
  for (const row of r.rows) {
    assert.equal(cmpFrac(row.adj, a1), 0);
  }
  // 三项候选为 0.3/0.15/0.1，最小值 0.1 仅由秩 3 产生，故来源秩均为 3。
  for (const row of r.rows) assert.equal(row.sourceRank, 3);

  // 全零时候选在所有秩并列为 0，来源并列固定取较小秩 1。
  const r0 = runBh([
    { id: "z1", p: "0" },
    { id: "z2", p: "0" },
  ]);
  for (const row of r0.rows) assert.equal(row.sourceRank, 1);

  // [0.2,0.1,0.1] 排序为 0.1(秩1) 0.1(秩2) 0.2(秩3)：
  // 0.1 块候选为 0.3/0.15，块内最小 0.15 来自秩 2；秩 3 的 0.2 不影响它们。
  const r2 = runBh([
    { id: "a", p: "0.2" },
    { id: "b", p: "0.1" },
    { id: "c", p: "0.1" },
  ]);
  assert.equal(cmpFrac(r2.rows[0].adj, r2.rows[1].adj), 0);
  assert.equal(r2.rows[0].sourceRank, 2);
  assert.equal(r2.rows[1].sourceRank, 2);
  assert.equal(toDisplay(r2.rows[0].adj).text, "0.15");
  assert.equal(toDisplay(r2.rows[2].adj).text, "0.2");
  assert.equal(r2.rows[2].sourceRank, 3);

  // 单调修正来源靠后：[0.01,0.2] -> 秩1候选0.02，秩2候选0.2，秩1不受影响；
  // 反向例子 [0.1,0.1,0.1] 已覆盖；再验 [0.5,0.02]：排序0.02,0.5，
  // 候选0.04,0.5，来源秩1。
  const r3 = runBh([
    { id: "x", p: "0.5" },
    { id: "y", p: "0.02" },
  ]);
  assert.equal(r3.rows[0].sourceRank, 1);
  assert.equal(r3.rows[1].sourceRank, 2);
});

test("门槛精确相等算通过", () => {
  // m=2, p(1)=0.025 = 1*0.05/2 精确相等
  const r = runBh([
    { id: "e1", p: "0.025" },
    { id: "e2", p: "0.9" },
  ]);
  const rep = decide({ familyId: "f", version: 1, result: r, alphaInput: "0.05" });
  assert.equal(rep.cutoffRank, 1);
  assert.equal(rep.rows[0].ownPass, true);
});

test("输入重排不改变按编号的结果", () => {
  const make = (arr: Array<[string, string]>): RawItem[] => arr.map(([id, p]) => ({ id, p }));
  const r1 = runBh(make([["a", "0.5"], ["b", "0.01"], ["c", "0.2"]]));
  const r2 = runBh(make([["c", "0.2"], ["a", "0.5"], ["b", "0.01"]]));
  for (const id of ["a", "b", "c"]) {
    assert.equal(cmpFrac(r1.byId.get(id)!.adj, r2.byId.get(id)!.adj), 0);
    assert.equal(r1.byId.get(id)!.rank, r2.byId.get(id)!.rank);
  }
});

test("增加不显著项改变分母 m，旧结果按冻结版本保留（版本对比）", () => {
  const v1 = runBh([{ id: "a", p: "0.04" }]);
  const v2 = runBh([
    { id: "a", p: "0.04" },
    { id: "big", p: "0.999" },
  ]);
  const d = diffVersions(
    { version: 1, result: v1 },
    { version: 2, result: v2 },
    "0.05"
  );
  assert.deepEqual(d.restored, ["a"]);
  assert.deepEqual(d.added.map((x) => x.id), ["big"]);
});

test("最大精度 12 位小数字符串", () => {
  const f = parseDecimal("0.123456789012");
  assert.equal(f.num.toString(), "30864197253");
  assert.equal(f.den.toString(), "250000000000");
  assert.throws(() => parseDecimal("0.1234567890123"), BhError);
});

test("非法输入全部拒绝", () => {
  assert.throws(() => parseDecimal("1e-3"), BhError);
  assert.throws(() => parseDecimal("NaN"), BhError);
  assert.throws(() => parseDecimal(""), BhError);
  assert.throws(() => parseDecimal("  0.5 x"), BhError);
  assert.throws(() => parseDecimal("1.000000000001"), BhError);
  assert.throws(() => parseDecimal("1.1"), BhError);
  assert.throws(
    () =>
      validateItems([
        { id: "a", p: "0.1" },
        { id: "a", p: "0.2" },
      ]),
    BhError
  );
  assert.throws(() => validateItems([{ id: "", p: "0.1" }]), BhError);
  assert.throws(() => validateItems([]), BhError);
  assert.throws(
    () => validateItems(Array.from({ length: 10001 }, (_, i) => ({ id: `${i}`, p: "0.5" }))),
    BhError
  );
});

test("穷举后缀最小值核对调整值", () => {
  const ps = ["0.01", "0.04", "0.03", "0.2", "0.05", "0.05", "0.9"];
  const items: RawItem[] = ps.map((p, i) => ({ id: `t${i}`, p }));
  const r = runBh(items);
  const m = BigInt(r.m);
  const ONE: Fraction = { num: 1n, den: 1n };
  // 独立重新穷举
  const sortedP = r.rows.map((row) => row.p);
  const expectAdj: Fraction[] = [];
  const cap = (f: Fraction): Fraction => (cmpFrac(f, ONE) > 0 ? ONE : f);
  for (let i = 0; i < sortedP.length; i++) {
    let best = cap(fracMulDiv(sortedP[i], m, BigInt(i + 1)));
    for (let j = i + 1; j < sortedP.length; j++) {
      const cand = cap(fracMulDiv(sortedP[j], m, BigInt(j + 1)));
      if (cmpFrac(cand, best) < 0) best = cand;
    }
    expectAdj.push(best);
  }
  // 相同 p 块取最小值
  for (let i = 0; i < r.rows.length; ) {
    let j = i;
    while (j + 1 < r.rows.length && cmpFrac(sortedP[j + 1], sortedP[i]) === 0) j++;
    let bm = expectAdj[i];
    for (let k = i + 1; k <= j; k++) if (cmpFrac(expectAdj[k], bm) < 0) bm = expectAdj[k];
    for (let k = i; k <= j; k++) expectAdj[k] = bm;
    i = j + 1;
  }
  r.rows.forEach((row, i) => assert.equal(cmpFrac(row.adj, expectAdj[i]), 0));
});

test("两种拒绝集合算法一致，且调整值不小于原 p、单调不减", () => {
  const ps = ["0.001", "0.02", "0.02", "0.5", "0.99", "0", "0.0499", "0.0501"];
  const items: RawItem[] = ps.map((p, i) => ({ id: `n${i}`, p }));
  const r = runBh(items);
  for (const alpha of ["0", "0.01", "0.05", "0.1", "0.5", "1"]) {
    const rep = decide({ familyId: "f", version: 1, result: r, alphaInput: alpha });
    const cutoff = rep.cutoffRank;
    for (const row of rep.rows) {
      assert.equal(row.rejected, cutoff !== null && row.rank <= cutoff);
      assert.equal(row.rejected, row.adjLeAlpha);
    }
  }
  r.rows.forEach((row, i) => {
    assert.ok(cmpFrac(row.adj, row.p) >= 0);
    if (i > 0) assert.ok(cmpFrac(row.adj, r.rows[i - 1].adj) >= 0);
  });
});

test("alpha 单调：增加不会让已拒绝项目恢复保留", () => {
  const ps = ["0.001", "0.01", "0.03", "0.1", "0.4"];
  const items: RawItem[] = ps.map((p, i) => ({ id: `m${i}`, p }));
  const r = runBh(items);
  const alphas = ["0.001", "0.01", "0.02", "0.05", "0.1", "0.5", "1"];
  let prev = new Set<string>();
  for (const a of alphas) {
    const rep = decide({ familyId: "f", version: 1, result: r, alphaInput: a });
    const cur = new Set(rep.rejectedIds);
    for (const id of prev) assert.ok(cur.has(id), `alpha=${a} 时 ${id} 被错误恢复`);
    assert.ok(ids(rep.rows.filter((x) => x.rejected)).length >= prev.size);
    prev = cur;
  }
});
