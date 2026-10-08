// SQLite 持久化：冻结检验族（含版本）、原始字符串、精确比例、排序与调整结果。
// 使用 Node 内置 node:sqlite，无原生依赖。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  ALGORITHM_VERSION,
  computeAdjusted,
  sortFamily,
  type AdjustedRow,
  type FamilyItemInput,
} from "./bh.ts";
import { parseDecimal } from "./decimal.ts";

export interface StoredItem {
  id: string;
  pOriginal: string;
  pScaled: bigint;
  inputIndex: number;
}

export interface FamilyRecord {
  familyId: string;
  version: number;
  algorithmVersion: string;
  m: number;
  createdAt: string;
  items: StoredItem[];
  sorted: AdjustedRow[];
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS families (
        family_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        algorithm_version TEXT NOT NULL,
        m INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (family_id, version)
      );
      CREATE TABLE IF NOT EXISTS items (
        family_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        p_original TEXT NOT NULL,
        p_scaled TEXT NOT NULL,
        input_index INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        adj_num TEXT NOT NULL,
        adj_den TEXT NOT NULL,
        source_rank INTEGER NOT NULL,
        PRIMARY KEY (family_id, version, item_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // 幂等导入：同一 familyId + 相同内容 -> 返回已有版本；不同内容 -> 新版本。
  importFamily(
    familyId: string,
    items: FamilyItemInput[],
  ): { record: FamilyRecord; created: boolean } {
    if (!familyId || familyId.trim() === "") {
      throw new ImportError("EMPTY_FAMILY_ID", "检验族编号不能为空");
    }
    const prepared = prepareItems(items); // 可能抛 FamilyError / DecimalError
    const hash = contentHash(familyId, prepared);
    const existing = this.db
      .prepare(
        "SELECT version, content_hash FROM families WHERE family_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(familyId) as { version: number; content_hash: string } | undefined;
    if (existing && existing.content_hash === hash) {
      return { record: this.getFamily(familyId, existing.version)!, created: false };
    }
    const version = existing ? existing.version + 1 : 1;
    const sorted = computeAdjusted(sortFamily(prepared));
    const createdAt = new Date().toISOString();
    // 事务：族与项目要么全部写入，要么整体回滚，不发布残缺族。
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO families (family_id, version, algorithm_version, m, content_hash, created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(familyId, version, ALGORITHM_VERSION, prepared.length, hash, createdAt);
      const stmt = this.db.prepare(
        "INSERT INTO items (family_id, version, item_id, p_original, p_scaled, input_index, rank, adj_num, adj_den, source_rank) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      for (const row of sorted) {
        stmt.run(
          familyId,
          version,
          row.id,
          row.pOriginal,
          row.pScaled.toString(),
          row.inputIndex,
          row.rank,
          row.adjNum.toString(),
          row.adjDen.toString(),
          row.sourceRank,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { record: this.getFamily(familyId, version)!, created: true };
  }

  getFamily(familyId: string, version?: number): FamilyRecord | null {
    const fam =
      version === undefined
        ? (this.db
            .prepare(
              "SELECT * FROM families WHERE family_id = ? ORDER BY version DESC LIMIT 1",
            )
            .get(familyId) as any)
        : (this.db
            .prepare(
              "SELECT * FROM families WHERE family_id = ? AND version = ?",
            )
            .get(familyId, version) as any);
    if (!fam) return null;
    const rows = this.db
      .prepare(
        "SELECT * FROM items WHERE family_id = ? AND version = ? ORDER BY rank",
      )
      .all(familyId, fam.version) as any[];
    const sorted: AdjustedRow[] = rows.map((r) => ({
      rank: r.rank,
      id: r.item_id,
      inputIndex: r.input_index,
      pScaled: BigInt(r.p_scaled),
      pOriginal: r.p_original,
      adjNum: BigInt(r.adj_num),
      adjDen: BigInt(r.adj_den),
      sourceRank: r.source_rank,
    }));
    const items: StoredItem[] = [...sorted]
      .sort((a, b) => a.inputIndex - b.inputIndex)
      .map((r) => ({
        id: r.id,
        pOriginal: r.pOriginal,
        pScaled: r.pScaled,
        inputIndex: r.inputIndex,
      }));
    return {
      familyId,
      version: fam.version,
      algorithmVersion: fam.algorithm_version,
      m: fam.m,
      createdAt: fam.created_at,
      items,
      sorted,
    };
  }

  listVersions(familyId: string): number[] {
    const rows = this.db
      .prepare(
        "SELECT version FROM families WHERE family_id = ? ORDER BY version",
      )
      .all(familyId) as any[];
    return rows.map((r) => r.version);
  }
}

export class ImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

// 校验并解析全部输入；任何一条非法都整体拒绝。
export function prepareItems(items: FamilyItemInput[]): StoredItem[] {
  if (!Array.isArray(items)) {
    throw new ImportError("INVALID_PAYLOAD", "items 必须是数组");
  }
  if (items.length < 1 || items.length > 10_000) {
    throw new ImportError(
      "FAMILY_SIZE",
      `检验族大小须在 1..10000，实际 ${items.length}`,
    );
  }
  const seen = new Set<string>();
  return items.map((it, idx) => {
    const id = it?.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new ImportError("EMPTY_ID", `第 ${idx + 1} 项编号为空或非法`);
    }
    if (seen.has(id)) {
      throw new ImportError("DUPLICATE_ID", `编号重复: "${id}"`);
    }
    seen.add(id);
    const pScaled = parseDecimal(it.p); // 非法十进制在此抛出，整体拒绝
    return { id, pOriginal: it.p, pScaled, inputIndex: idx };
  });
}

function contentHash(familyId: string, items: StoredItem[]): string {
  const h = createHash("sha256");
  h.update(ALGORITHM_VERSION);
  h.update(familyId);
  for (const it of items) {
    h.update(`${it.inputIndex}${it.id}${it.pScaled.toString()};`);
  }
  return h.digest("hex");
}

export function defaultDbPath(): string {
  return join(process.cwd(), "data", "bh.sqlite");
}
