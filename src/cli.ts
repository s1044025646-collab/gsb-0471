// CLI：导入、校验、调整值、判定、来源、比较、导出、演示。
// 用法: node --experimental-strip-types src/cli.ts <命令> [参数]

import { readFileSync } from "node:fs";
import { Store, defaultDbPath, prepareItems } from "./store.ts";
import { parseDecimal } from "./decimal.ts";
import {
  buildAdjustedTable,
  buildDecideReport,
  compareVersions,
  decideReportToCsv,
  adjustedTableToCsv,
} from "./report.ts";
import { adjFraction } from "./bh.ts";

const store = new Store(process.env.BH_DB ?? defaultDbPath());

function fail(err: unknown): never {
  const e = err as any;
  const code = e?.code ?? "ERROR";
  console.error(`错误 [${code}] ${e?.message ?? err}`);
  process.exit(1);
}

function out(data: unknown, format: string | undefined, csvFn?: (d: any) => string): void {
  if (format === "csv" && csvFn) {
    process.stdout.write(csvFn(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags.set(argv[i].slice(2), argv[i + 1] ?? "");
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

function readItems(flags: Map<string, string>): any[] {
  const file = flags.get("file");
  if (!file) throw new Error("缺少 --file <json>");
  const body = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(body) ? body : body.items;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const format = flags.get("format");

  switch (cmd) {
    case "import": {
      // import <familyId> --file items.json
      const familyId = positional[0];
      const items = readItems(flags);
      const { record, created } = store.importFamily(familyId, items);
      console.log(
        `族 ${record.familyId} 版本 ${record.version}（m=${record.m}）${created ? "已创建" : "已存在（幂等命中）"}`,
      );
      break;
    }
    case "validate": {
      const items = prepareItems(readItems(flags));
      console.log(`校验通过，共 ${items.length} 项`);
      break;
    }
    case "adjust": {
      // adjust <familyId> [--version N] [--format csv]
      const fam = mustFamily(positional[0], flags.get("version"));
      const table = buildAdjustedTable(fam);
      out(table, format, adjustedTableToCsv);
      break;
    }
    case "decide": {
      // decide <familyId> --alpha 0.05 [--version N] [--format csv]
      const fam = mustFamily(positional[0], flags.get("version"));
      const alphaRaw = flags.get("alpha");
      if (!alphaRaw) throw new Error("缺少 --alpha");
      const report = buildDecideReport(fam, parseDecimal(alphaRaw), alphaRaw);
      out(report, format, decideReportToCsv);
      break;
    }
    case "source": {
      // source <familyId> <itemId>
      const fam = mustFamily(positional[0], flags.get("version"));
      const row = fam.sorted.find((r) => r.id === positional[1]);
      if (!row) throw new Error(`编号不存在: ${positional[1]}`);
      out({
        id: row.id,
        rank: row.rank,
        pOriginal: row.pOriginal,
        adjustedFraction: adjFraction(row),
        sourceRank: row.sourceRank,
      }, format);
      break;
    }
    case "compare": {
      // compare <familyId> --from 1 --to 2 --alpha 0.05
      const older = mustFamily(positional[0], flags.get("from"));
      const newer = mustFamily(positional[0], flags.get("to"));
      const alphaRaw = flags.get("alpha");
      if (!alphaRaw) throw new Error("缺少 --alpha");
      out(compareVersions(older, newer, parseDecimal(alphaRaw), alphaRaw), format);
      break;
    }
    case "demo": {
      runDemo();
      break;
    }
    default:
      console.log(`命令: import | validate | adjust | decide | source | compare | demo
示例:
  cli demo
  cli import fam1 --file items.json
  cli decide fam1 --alpha 0.05
  cli adjust fam1 --format csv
  cli compare fam1 --from 1 --to 2 --alpha 0.05`);
  }
}

function mustFamily(familyId: string | undefined, versionRaw: string | undefined) {
  if (!familyId) throw new Error("缺少 familyId");
  const version = versionRaw ? Number(versionRaw) : undefined;
  const fam = store.getFamily(familyId, version);
  if (!fam) throw new Error(`检验族不存在: ${familyId}${version ? ` v${version}` : ""}`);
  return fam;
}

function runDemo(): void {
  const id1 = "demo-known";
  const r1 = store.importFamily(id1, [
    { id: "H1", p: "0.01" },
    { id: "H2", p: "0.04" },
    { id: "H3", p: "0.03" },
    { id: "H4", p: "0.2" },
  ]);
  console.log("== 已知示例 p=[0.01,0.04,0.03,0.2] ==");
  console.log("调整值（原输入顺序）:",
    JSON.stringify(buildAdjustedTable(r1.record).map((r) => r.adjustedFraction)));
  const d1 = buildDecideReport(r1.record, parseDecimal("0.05"), "0.05");
  console.log("alpha=0.05 拒绝集合:", JSON.stringify(d1.rejectedIds));

  const id2 = "demo-stepup";
  const r2 = store.importFamily(id2, [
    { id: "A", p: "0.02" },
    { id: "B", p: "0.03" },
    { id: "C", p: "0.04" },
  ]);
  const d2 = buildDecideReport(r2.record, parseDecimal("0.05"), "0.05");
  console.log("\n== 逐级判定示例 p=[0.02,0.03,0.04], alpha=0.05 ==");
  for (const row of d2.rows) {
    console.log(
      `秩${row.rank} ${row.id}: p=${row.pOriginal} 门槛=${row.threshold} 局部通过=${row.localPass} 最终拒绝=${row.rejected}`,
    );
  }
  console.log("说明: 秩1 局部未通过，但最大通过秩为 3，故前三项全部拒绝。");
}

main()
  .catch(fail)
  .finally(() => store.close());
