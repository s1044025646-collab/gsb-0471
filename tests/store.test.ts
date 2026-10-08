import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { decide } from "../src/bh.js";
import { BhError } from "../src/errors.js";
import type { RawItem } from "../src/types.js";

let dir: string;
let store: Store;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bh-test-"));
  store = new Store(join(dir, "t.sqlite"));
});

after(() => store.close());

test("导入失败整体回滚，不产生残缺族", () => {
  assert.throws(
    () =>
      store.importFamily("bad", [
        { id: "a", p: "0.1" },
        { id: "a", p: "0.2" },
      ]),
    BhError
  );
  assert.equal(store.getLatestVersion("bad"), null);
});

test("冻结后多 alpha 复用，增删产生新版本，旧版本不改写", () => {
  const v1Items: RawItem[] = [
    { id: "a", p: "0.04" },
    { id: "b", p: "0.03" },
  ];
  const { version: v1 } = store.importFamily("fam", v1Items);
  assert.equal(v1, 1);
  const s1 = store.loadFamily("fam", 1);
  const r1a = decide({ familyId: "fam", version: 1, result: s1.result, alphaInput: "0.05" });
  const r1b = decide({ familyId: "fam", version: 1, result: s1.result, alphaInput: "0.1" });
  assert.equal(r1a.cutoffRank, 2);
  assert.equal(r1b.cutoffRank, 2);

  store.importFamily("fam", [...v1Items, { id: "c", p: "0.999" }]);
  const s1again = store.loadFamily("fam", 1);
  assert.equal(s1again.result.m, 2, "旧版本 m 不得改写");
  const s2 = store.loadFamily("fam", 2);
  assert.equal(s2.result.m, 3);
  const r2 = decide({ familyId: "fam", version: 2, result: s2.result, alphaInput: "0.05" });
  // m 变大后 a 不再被拒绝
  assert.ok(!r2.rejectedIds.includes("a"));
});

test("幂等键重复请求返回同一版本；跨族复用冲突报错", () => {
  const first = store.importFamily("idem", [{ id: "a", p: "0.01" }], "key-1");
  const second = store.importFamily(
    "idem",
    [
      { id: "a", p: "0.01" },
      { id: "b", p: "0.02" },
    ],
    "key-1"
  );
  assert.deepEqual(first, { version: 1, reused: false });
  assert.deepEqual(second, { version: 1, reused: true });
  assert.throws(
    () => store.importFamily("other", [{ id: "z", p: "0.5" }], "key-1"),
    BhError
  );
});

test("重启后（重开数据库）仍可按原族读取不同阈值", () => {
  store.close();
  const reopened = new Store(join(dir, "t.sqlite"));
  const s = reopened.loadFamily("fam", 1);
  assert.equal(s.result.m, 2);
  const rep = decide({ familyId: "fam", version: 1, result: s.result, alphaInput: "0.001" });
  assert.equal(rep.cutoffRank, null);
  reopened.close();
  store = new Store(join(dir, "t.sqlite"));
});
