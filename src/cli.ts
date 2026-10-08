#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BhError } from "./errors.js";
import { Store } from "./store.js";
import { decide, diffVersions, runBh, validateItems } from "./bh.js";
import { familyToCsv, familyToJson, reportToCsv } from "./export.js";
import { fracToString, toDisplay } from "./decimal.js";
import type { RawItem } from "./types.js";

function loadItems(fileOrJson: string): RawItem[] {
  let text: string;
  try {
    text = readFileSync(fileOrJson, "utf8");
  } catch {
    text = fileOrJson;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BhError("INVALID_JSON", "无法解析输入 JSON（既不是文件也不是 JSON 字符串）");
  }
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)) {
    parsed = (parsed as { items: unknown }).items as unknown;
  }
  if (!Array.isArray(parsed)) throw new BhError("BAD_REQUEST", "输入必须是 [{id,p}, ...] 数组");
  return parsed as RawItem[];
}

function openStore(parsed: { values: { db?: string } }): Store {
  const dbPath = parsed.values.db ?? resolve(process.cwd(), "data", "bh.sqlite");
  return new Store(dbPath);
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

function usage(): void {
  console.log(`BH 多重检验调整 CLI

用法:
  bh preview <items.json|内联JSON>             仅校验并预览，不写库
  bh import <familyId> <items...> [--key K]    原子导入（冻结为新版本）
  bh family <familyId> [--version N] [--csv]   查看冻结族排序表
  bh decide <familyId> --alpha A [--version N] [--csv]  按阈值判定拒绝集合
  bh item <familyId> <itemId> [--version N]    查询单条调整值与来源秩
  bh diff <familyId> --alpha A [--from N] [--to N]      比较两版本
  bh export <familyId> --out f.json|f.csv [--version N] 导出 JSON/CSV
  bh list                                      列出所有族

通用选项:
  --db <path>   SQLite 文件（默认 ./data/bh.sqlite）
`);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    usage();
    return;
  }

  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      alpha: { type: "string" },
      version: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      key: { type: "string" },
      db: { type: "string" },
      csv: { type: "boolean" },
      out: { type: "string" },
    },
  });
  const pos = parsed.positionals;

  if (command === "preview") {
    const items = loadItems(pos[0] ?? "");
    const validated = validateItems(items);
    const result = runBh(items);
    print({
      ok: true,
      m: validated.length,
      sortedTable: familyToJson("", 0, result).sortedTable,
    });
    return;
  }

  if (command === "list") {
    const store = openStore(parsed);
    print({ families: store.listFamilies() });
    store.close();
    return;
  }

  if (command === "import") {
    const familyId = pos[0];
    if (!familyId || !pos[1]) throw new BhError("BAD_REQUEST", "用法: bh import <familyId> <items>");
    const store = openStore(parsed);
    const items = loadItems(pos[1]);
    const { version, reused } = store.importFamily(familyId, items, parsed.values.key);
    print({ ok: true, familyId, version, m: items.length, reused });
    store.close();
    return;
  }

  if (command === "family") {
    const store = openStore(parsed);
    const stored = store.loadFamily(pos[0], parsed.values.version ? Number(parsed.values.version) : undefined);
    if (parsed.values.csv) {
      console.log(familyToCsv(pos[0], Number(stored.meta.version), stored.result));
    } else {
      print(familyToJson(pos[0], Number(stored.meta.version), stored.result));
    }
    store.close();
    return;
  }

  if (command === "decide") {
    if (!parsed.values.alpha) throw new BhError("MISSING_FIELD", "需要 --alpha");
    const store = openStore(parsed);
    const stored = store.loadFamily(pos[0], parsed.values.version ? Number(parsed.values.version) : undefined);
    const report = decide({
      familyId: pos[0],
      version: Number(stored.meta.version),
      result: stored.result,
      alphaInput: parsed.values.alpha,
    });
    if (parsed.values.csv) console.log(reportToCsv(report));
    else print(report);
    store.close();
    return;
  }

  if (command === "item") {
    const store = openStore(parsed);
    const stored = store.loadFamily(pos[0], parsed.values.version ? Number(parsed.values.version) : undefined);
    const row = stored.result.byId.get(pos[1]);
    if (!row) throw new BhError("ITEM_NOT_FOUND", `无编号 ${pos[1]}`);
    print({
      id: row.id,
      inputP: row.raw,
      pFraction: fracToString(row.p),
      rank: row.rank,
      adjustedPDisplay: toDisplay(row.adj).text,
      adjustedPFraction: fracToString(row.adj),
      sourceRank: row.sourceRank,
    });
    store.close();
    return;
  }

  if (command === "diff") {
    if (!parsed.values.alpha) throw new BhError("MISSING_FIELD", "需要 --alpha");
    const store = openStore(parsed);
    const toStored = store.loadFamily(pos[0], parsed.values.to ? Number(parsed.values.to) : undefined);
    const toV = Number(toStored.meta.version);
    const fromStored = store.loadFamily(
      pos[0],
      parsed.values.from ? Number(parsed.values.from) : toV > 1 ? toV - 1 : undefined
    );
    print(
      diffVersions(
        { version: Number(fromStored.meta.version), result: fromStored.result },
        { version: toV, result: toStored.result },
        parsed.values.alpha
      )
    );
    store.close();
    return;
  }

  if (command === "export") {
    if (!parsed.values.out) throw new BhError("MISSING_FIELD", "需要 --out <file>");
    const store = openStore(parsed);
    const stored = store.loadFamily(pos[0], parsed.values.version ? Number(parsed.values.version) : undefined);
    const v = Number(stored.meta.version);
    const isCsv = parsed.values.out.toLowerCase().endsWith(".csv");
    const content = isCsv
      ? familyToCsv(pos[0], v, stored.result)
      : JSON.stringify(familyToJson(pos[0], v, stored.result), null, 2);
    writeFileSync(parsed.values.out, isCsv ? "\uFEFF" + content : content, "utf8");
    console.log(`已导出 ${parsed.values.out}`);
    store.close();
    return;
  }

  throw new BhError("BAD_REQUEST", `未知命令：${command}`);
}

try {
  main();
} catch (err) {
  if (err instanceof BhError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
    process.exitCode = 1;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
}
