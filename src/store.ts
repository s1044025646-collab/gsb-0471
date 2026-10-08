import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ALGORITHM_VERSION, runBh, type BhResult } from "./bh.js";
import { cmpFrac } from "./decimal.js";
import { BhError } from "./errors.js";
import type { Fraction, RawItem } from "./types.js";

/**
 * SQLite 持久化层。
 * 保存原始字符串、精确比例（分子/分母 BigInt 以 TEXT 存）、稳定排序秩、
 * 算法版本与冻结报告所需的全部数据。族一经导入即冻结，多 alpha 查询复用。
 */

interface FamilyRow {
  family_id: string;
  version: number;
  m: number;
  algorithm: string;
  created_at: string;
  note: string;
}

interface ItemRow {
  family_id: string;
  version: number;
  id: string;
  input_index: number;
  raw_p: string;
  num: string;
  den: string;
  rank: number;
  adj_num: string;
  adj_den: string;
  source_rank: number;
}

export interface StoredFamily {
  meta: FamilyRow;
  result: BhResult;
}

const NOTE =
  "族已冻结：仅包含导入时提供的 p 值；修改/增删产生新版本，旧版本结果不被改写。";

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS families (
        family_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        m INTEGER NOT NULL,
        algorithm TEXT NOT NULL,
        created_at TEXT NOT NULL,
        note TEXT NOT NULL,
        PRIMARY KEY (family_id, version)
      );
      CREATE TABLE IF NOT EXISTS items (
        family_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        id TEXT NOT NULL,
        input_index INTEGER NOT NULL,
        raw_p TEXT NOT NULL,
        num TEXT NOT NULL,
        den TEXT NOT NULL,
        rank INTEGER NOT NULL,
        adj_num TEXT NOT NULL,
        adj_den TEXT NOT NULL,
        source_rank INTEGER NOT NULL,
        PRIMARY KEY (family_id, version, id),
        UNIQUE (family_id, version, rank)
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        idempotency_key TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  listFamilies(): Array<{ familyId: string; latestVersion: number; versions: number }> {
    const rows = this.db
      .prepare(
        `SELECT family_id, COUNT(*) AS versions, MAX(version) AS latest
         FROM families GROUP BY family_id`
      )
      .all() as Array<{ family_id: string; versions: number; latest: number }>;
    return rows.map((r) => ({
      familyId: r.family_id,
      latestVersion: r.latest,
      versions: r.versions,
    }));
  }

  getLatestVersion(familyId: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM families WHERE family_id = ?")
      .get(familyId) as { v: number | null } | undefined;
    return row?.v == null ? null : Number(row.v);
  }

  /**
   * 原子导入：先在事务外计算 BH（任何输入错误直接抛出），
   * 再在事务内整体写入，失败回滚，绝不发布残缺族。
   * 幂等：相同 idempotencyKey 的重复请求返回首次结果。
   */
  importFamily(
    familyId: string,
    items: RawItem[],
    idempotencyKey?: string
  ): { version: number; reused: boolean } {
    if (idempotencyKey) {
      const existing = this.db
        .prepare("SELECT family_id, version FROM idempotency WHERE idempotency_key = ?")
        .get(idempotencyKey) as { family_id: string; version: number } | undefined;
      if (existing) {
        if (existing.family_id !== familyId) {
          throw new BhError(
            "IDEMPOTENCY_CONFLICT",
            `幂等键 ${idempotencyKey} 已用于族 ${existing.family_id}，不能复用于 ${familyId}`
          );
        }
        return { version: Number(existing.version), reused: true };
      }
    }

    const result = runBh(items); // 输入不合法在此抛出
    const latest = this.getLatestVersion(familyId);
    const version = (latest ?? 0) + 1;
    const now = new Date().toISOString();

    const insFam = this.db.prepare(
      "INSERT INTO families (family_id, version, m, algorithm, created_at, note) VALUES (?,?,?,?,?,?)"
    );
    const insItem = this.db.prepare(
      `INSERT INTO items (family_id, version, id, input_index, raw_p, num, den, rank, adj_num, adj_den, source_rank)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insIdem = this.db.prepare(
      "INSERT INTO idempotency (idempotency_key, family_id, version, created_at) VALUES (?,?,?,?)"
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      insFam.run(familyId, version, result.m, ALGORITHM_VERSION, now, NOTE);
      result.inputOrder.forEach((id, idx) => {
        const row = result.byId.get(id)!;
        insItem.run(
          familyId,
          version,
          id,
          idx,
          row.raw,
          row.p.num.toString(),
          row.p.den.toString(),
          row.rank,
          row.adj.num.toString(),
          row.adj.den.toString(),
          row.sourceRank
        );
      });
      if (idempotencyKey) insIdem.run(idempotencyKey, familyId, version, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { version, reused: false };
  }

  loadFamily(familyId: string, version?: number): StoredFamily {
    const v = version ?? this.getLatestVersion(familyId);
    if (v == null) throw new BhError("FAMILY_NOT_FOUND", `检验族不存在：${familyId}`);
    const meta = this.db
      .prepare("SELECT * FROM families WHERE family_id = ? AND version = ?")
      .get(familyId, v) as FamilyRow | undefined;
    if (!meta) throw new BhError("VERSION_NOT_FOUND", `族 ${familyId} 不存在版本 ${v}`);
    const itemRows = this.db
      .prepare("SELECT * FROM items WHERE family_id = ? AND version = ? ORDER BY rank")
      .all(familyId, v) as unknown as ItemRow[];
    if (itemRows.length !== meta.m) {
      throw new BhError("INTERNAL", "持久化数据不完整：条目数与 m 不一致");
    }

    const toFrac = (n: string, d: string): Fraction => ({ num: BigInt(n), den: BigInt(d) });
    const rows = itemRows.map((r) => ({
      id: r.id,
      raw: r.raw_p,
      rank: r.rank,
      p: toFrac(r.num, r.den),
      adj: toFrac(r.adj_num, r.adj_den),
      sourceRank: r.source_rank,
    }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const orderRows = this.db
      .prepare(
        "SELECT id FROM items WHERE family_id = ? AND version = ? ORDER BY input_index"
      )
      .all(familyId, v) as Array<{ id: string }>;

    // 从持久化精确比例重建后再做一次单调性核对
    for (let i = 0; i < rows.length; i++) {
      if (cmpFrac(rows[i].adj, rows[i].p) < 0) {
        throw new BhError("INTERNAL", "存储的调整值小于原 p");
      }
      if (i > 0 && cmpFrac(rows[i].adj, rows[i - 1].adj) < 0) {
        throw new BhError("INTERNAL", "存储的调整值不单调");
      }
    }

    return {
      meta,
      result: { m: meta.m, rows, byId, inputOrder: orderRows.map((r) => r.id) },
    };
  }
}
