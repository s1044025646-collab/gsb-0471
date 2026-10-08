/**
 * 端到端演示：导入两个题目示例族 → 多 alpha 判定 → 新版本对比 → CSV 导出。
 * 运行: npm run demo
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { decide, diffVersions } from "../src/bh.js";
import { reportToCsv, familyToJson } from "../src/export.js";
import { fracToString } from "../src/decimal.js";

const dir = mkdtempSync(join(tmpdir(), "bh-demo-"));
const store = new Store(join(dir, "demo.sqlite"));

console.log("== 示例 1：p=[0.01,0.04,0.03,0.2]，alpha=0.05 ==");
store.importFamily("example1", [
  { id: "g1", p: "0.01" },
  { id: "g2", p: "0.04" },
  { id: "g3", p: "0.03" },
  { id: "g4", p: "0.2" },
]);
const s1 = store.loadFamily("example1");
const r1 = decide({ familyId: "example1", version: 1, result: s1.result, alphaInput: "0.05" });
for (const row of r1.rows) {
  console.log(
    `秩 ${row.rank} id=${row.id} p=${row.p} 门槛=${row.threshold} 自身通过=${row.ownPass} ` +
      `调整值=${fracToString(row.adjustedFraction)}`
  );
}
console.log("截止秩:", r1.cutoffRank, " 拒绝集合:", r1.rejectedIds);
console.log("说明:", r1.fdrNote);

console.log("\n== 示例 2：p=[0.02,0.03,0.04]，第一秩自身不通过但三项全拒绝 ==");
store.importFamily("example2", [
    { id: "h1", p: "0.02" },
    { id: "h2", p: "0.03" },
    { id: "h3", p: "0.04" },
  ]);
const s2 = store.loadFamily("example2");
const r2 = decide({ familyId: "example2", version: 1, result: s2.result, alphaInput: "0.05" });
console.log("各行 ownPass:", r2.rows.map((x) => `${x.id}:${x.ownPass}`).join(" "));
console.log("截止秩:", r2.cutoffRank, " 拒绝集合:", r2.rejectedIds);

console.log("\n== 冻结族多 alpha 复用（不重新选择参与行）==");
for (const alpha of ["0.01", "0.05", "0.1"]) {
  const rep = decide({ familyId: "example1", version: 1, result: s1.result, alphaInput: alpha });
  console.log(`alpha=${alpha} 截止秩=${rep.cutoffRank} 拒绝=${rep.rejectedIds.join(",") || "(无)"}`);
}

console.log("\n== 新版本：增加一个不显著项后比较 ==");
store.importFamily("example1", [
  { id: "g1", p: "0.01" },
  { id: "g2", p: "0.04" },
  { id: "g3", p: "0.03" },
  { id: "g4", p: "0.2" },
  { id: "g5", p: "0.999" },
]);
const s1v2 = store.loadFamily("example1", 2);
const d = diffVersions(
  { version: 1, result: s1.result },
  { version: 2, result: s1v2.result },
  "0.05"
);
console.log("新增:", d.added.map((x) => x.id), " 恢复保留:", d.restored);

const outJson = join(dir, "example1-v2.json");
const outCsv = join(dir, "example1-v2.csv");
writeFileSync(outJson, JSON.stringify(familyToJson("example1", 2, s1v2.result), null, 2));
writeFileSync(
  outCsv,
  "\uFEFF" +
    reportToCsv(decide({ familyId: "example1", version: 2, result: s1v2.result, alphaInput: "0.05" }))
);
console.log("\n导出文件:", outJson, "与", outCsv);
store.close();
