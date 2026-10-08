// HTTP API：导入族、预览校验、调整值、按 alpha 判定、来源查询、版本比较、导出。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Store, prepareItems } from "./store.ts";
import { parseDecimal, DecimalError } from "./decimal.ts";
import { FamilyError } from "./bh.ts";
import {
  buildAdjustedTable,
  buildDecideReport,
  compareVersions,
  decideReportToCsv,
  adjustedTableToCsv,
} from "./report.ts";
import { adjFraction } from "./bh.ts";

interface ApiError {
  error: { code: string; message: string };
}

function send(res: ServerResponse, status: number, body: unknown, csv = false): void {
  if (csv) {
    res.writeHead(status, { "content-type": "text/csv; charset=utf-8" });
    res.end(body as string);
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } } satisfies ApiError);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function mapError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof HttpError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err instanceof DecimalError) {
    return { status: 422, code: err.code, message: err.message };
  }
  if (err instanceof FamilyError) {
    return { status: 422, code: err.code, message: err.message };
  }
  const anyErr = err as any;
  if (anyErr && typeof anyErr.code === "string" && anyErr.name === "ImportError") {
    return { status: 422, code: anyErr.code, message: anyErr.message };
  }
  return { status: 500, code: "INTERNAL", message: String(err) };
}

export function createApiServer(store: Store) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const fmt = url.searchParams.get("format");

      // POST /families  { familyId, items:[{id,p}] }  导入（幂等）
      if (method === "POST" && path === "/families") {
        const body = await readBody(req);
        const { record, created } = store.importFamily(body.familyId, body.items);
        send(res, created ? 201 : 200, {
          familyId: record.familyId,
          version: record.version,
          m: record.m,
          algorithmVersion: record.algorithmVersion,
          created,
        });
        return;
      }

      // POST /validate  预览校验，不落库
      if (method === "POST" && path === "/validate") {
        const body = await readBody(req);
        const items = prepareItems(body.items);
        send(res, 200, { ok: true, m: items.length });
        return;
      }

      // GET /families/:id  最新版本信息 + 调整值表（原输入顺序）
      const famMatch = path.match(/^\/families\/([^/]+)$/);
      if (method === "GET" && famMatch) {
        const fam = mustGet(store, famMatch[1], url.searchParams.get("version"));
        const table = buildAdjustedTable(fam);
        if (fmt === "csv") {
          send(res, 200, adjustedTableToCsv(table), true);
        } else {
          send(res, 200, {
            familyId: fam.familyId,
            version: fam.version,
            algorithmVersion: fam.algorithmVersion,
            m: fam.m,
            createdAt: fam.createdAt,
            items: table,
          });
        }
        return;
      }

      // GET /families/:id/decide?alpha=0.05[&format=csv]
      const decideMatch = path.match(/^\/families\/([^/]+)\/decide$/);
      if (method === "GET" && decideMatch) {
        const fam = mustGet(store, decideMatch[1], url.searchParams.get("version"));
        const alphaRaw = url.searchParams.get("alpha");
        if (alphaRaw === null) throw new HttpError(400, "MISSING_ALPHA", "缺少 alpha 参数");
        const alpha = parseDecimal(alphaRaw);
        const report = buildDecideReport(fam, alpha, alphaRaw);
        if (fmt === "csv") {
          send(res, 200, decideReportToCsv(report), true);
        } else {
          send(res, 200, report);
        }
        return;
      }

      // GET /families/:id/items/:itemId  某项来源与调整值
      const itemMatch = path.match(/^\/families\/([^/]+)\/items\/([^/]+)$/);
      if (method === "GET" && itemMatch) {
        const fam = mustGet(store, itemMatch[1], url.searchParams.get("version"));
        const row = fam.sorted.find((r) => r.id === decodeURIComponent(itemMatch[2]));
        if (!row) throw new HttpError(404, "ITEM_NOT_FOUND", "编号不存在于该族");
        send(res, 200, {
          familyId: fam.familyId,
          version: fam.version,
          id: row.id,
          rank: row.rank,
          pOriginal: row.pOriginal,
          adjustedFraction: adjFraction(row),
          sourceRank: row.sourceRank,
        });
        return;
      }

      // GET /families/:id/compare?from=1&to=2&alpha=0.05
      const cmpMatch = path.match(/^\/families\/([^/]+)\/compare$/);
      if (method === "GET" && cmpMatch) {
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        const alphaRaw = url.searchParams.get("alpha");
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
          throw new HttpError(400, "INVALID_VERSION", "from/to 必须是整数版本号");
        }
        if (alphaRaw === null) throw new HttpError(400, "MISSING_ALPHA", "缺少 alpha 参数");
        const alpha = parseDecimal(alphaRaw);
        const older = mustGet(store, cmpMatch[1], String(from));
        const newer = mustGet(store, cmpMatch[1], String(to));
        if (older.version >= newer.version) {
          throw new HttpError(400, "INVALID_VERSION", "from 必须小于 to");
        }
        send(res, 200, compareVersions(older, newer, alpha, alphaRaw));
        return;
      }

      // GET /health
      if (method === "GET" && path === "/health") {
        send(res, 200, { ok: true });
        return;
      }

      throw new HttpError(404, "NOT_FOUND", `未知路由: ${method} ${path}`);
    } catch (err) {
      const mapped = mapError(err);
      sendError(res, mapped.status, mapped.code, mapped.message);
    }
  });
}

function mustGet(store: Store, familyId: string, versionParam: string | null) {
  let version: number | undefined;
  if (versionParam !== null) {
    version = Number(versionParam);
    if (!Number.isInteger(version) || version < 1) {
      throw new HttpError(400, "INVALID_VERSION", "version 必须是正整数");
    }
  }
  const fam = store.getFamily(decodeURIComponent(familyId), version);
  if (!fam) throw new HttpError(404, "FAMILY_NOT_FOUND", `检验族不存在: ${familyId}`);
  return fam;
}
