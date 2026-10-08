import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as netCreateServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BhError, type ErrorCode } from "./errors.js";
import { Store } from "./store.js";
import { decide, diffVersions } from "./bh.js";
import { familyToCsv, familyToJson, reportToCsv } from "./export.js";
import { fracToString } from "./decimal.js";

/** 选择空闲端口：port=0 时由操作系统分配 */
export function pickFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = netCreateServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error("无法获取空闲端口")));
      }
    });
  });
}

interface Json {
  [k: string]: unknown;
}

function readJson(req: IncomingMessage): Promise<Json> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new BhError("BAD_REQUEST", "请求体超过 8 MiB 限制"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") return resolvePromise({});
      try {
        resolvePromise(JSON.parse(text) as Json);
      } catch {
        reject(new BhError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendCsv(res: ServerResponse, filename: string, csv: string): void {
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
  });
  res.end("\uFEFF" + csv);
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_JSON: 400,
  INVALID_DECIMAL: 400,
  OUT_OF_RANGE: 400,
  TOO_MANY_DECIMALS: 400,
  SCIENTIFIC_NOTATION_NOT_ALLOWED: 400,
  EMPTY_ID: 400,
  DUPLICATE_ID: 400,
  EMPTY_FAMILY: 400,
  TOO_MANY_TESTS: 400,
  MISSING_FIELD: 400,
  FAMILY_NOT_FOUND: 404,
  VERSION_NOT_FOUND: 404,
  ITEM_NOT_FOUND: 404,
  IMPORT_REJECTED: 400,
  BAD_REQUEST: 400,
  IDEMPOTENCY_CONFLICT: 409,
  INTERNAL: 500,
};

export interface AppContext {
  store: Store;
}

export async function createApp(ctx: AppContext): Promise<Server> {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true });
      }

      // 族集合
      if (method === "GET" && path === "/api/families") {
        return send(res, 200, { families: ctx.store.listFamilies() });
      }

      const famMatch = path.match(/^\/api\/families\/([^/]+)$/);
      if (famMatch) {
        const familyId = decodeURIComponent(famMatch[1]);
        if (method === "GET") {
          const version = url.searchParams.get("version");
          const stored = ctx.store.loadFamily(
            familyId,
            version ? Number(version) : undefined
          );
          return send(
            res,
            200,
            familyToJson(familyId, Number(stored.meta.version), stored.result)
          );
        }
        if (method === "POST") {
          const body = await readJson(req);
          const items = body.items;
          if (!Array.isArray(items)) throw new BhError("MISSING_FIELD", "缺少 items 数组");
          const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
          const { version, reused } = ctx.store.importFamily(
            familyId,
            items as never,
            key
          );
          return send(res, reused ? 200 : 201, {
            familyId,
            version,
            m: items.length,
            reused,
          });
        }
      }

      // alpha 判定
      const decideMatch = path.match(/^\/api\/families\/([^/]+)\/decide$/);
      if (decideMatch && method === "POST") {
        const familyId = decodeURIComponent(decideMatch[1]);
        const body = await readJson(req);
        if (typeof body.alpha !== "string") {
          throw new BhError("MISSING_FIELD", "缺少字符串型 alpha");
        }
        const version = typeof body.version === "number" ? body.version : undefined;
        const stored = ctx.store.loadFamily(familyId, version);
        const report = decide({
          familyId,
          version: Number(stored.meta.version),
          result: stored.result,
          alphaInput: body.alpha,
        });
        if (url.searchParams.get("format") === "csv") return sendCsv(res, "report.csv", reportToCsv(report));
        return send(res, 200, report);
      }

      // 导出
      const exportMatch = path.match(/^\/api\/families\/([^/]+)\/export$/);
      if (exportMatch && method === "GET") {
        const familyId = decodeURIComponent(exportMatch[1]);
        const version = url.searchParams.get("version");
        const stored = ctx.store.loadFamily(
          familyId,
          version ? Number(version) : undefined
        );
        const fmt = url.searchParams.get("format") === "csv" ? "csv" : "json";
        if (fmt === "csv") {
          return sendCsv(
            res,
            `family_${familyId}_v${stored.meta.version}.csv`,
            familyToCsv(familyId, Number(stored.meta.version), stored.result)
          );
        }
        return send(res, 200, familyToJson(familyId, Number(stored.meta.version), stored.result));
      }

      // 单条来源查询
      const itemMatch = path.match(/^\/api\/families\/([^/]+)\/items\/([^/]+)$/);
      if (itemMatch && method === "GET") {
        const familyId = decodeURIComponent(itemMatch[1]);
        const itemId = decodeURIComponent(itemMatch[2]);
        const version = url.searchParams.get("version");
        const stored = ctx.store.loadFamily(
          familyId,
          version ? Number(version) : undefined
        );
        const row = stored.result.byId.get(itemId);
        if (!row) throw new BhError("ITEM_NOT_FOUND", `族 ${familyId} 中无编号 ${itemId}`);
        return send(res, 200, {
          familyId,
          version: Number(stored.meta.version),
          id: row.id,
          inputP: row.raw,
          pFraction: fracToString(row.p),
          rank: row.rank,
          adjustedP: row.adj,
          adjustedPFraction: fracToString(row.adj),
          sourceRank: row.sourceRank,
        });
      }

      // 版本比较
      const diffMatch = path.match(/^\/api\/families\/([^/]+)\/diff$/);
      if (diffMatch && method === "POST") {
        const familyId = decodeURIComponent(diffMatch[1]);
        const body = await readJson(req);
        if (typeof body.alpha !== "string") {
          throw new BhError("MISSING_FIELD", "缺少字符串型 alpha");
        }
        const toV = typeof body.toVersion === "number" ? body.toVersion : undefined;
        const fromV = typeof body.fromVersion === "number" ? body.fromVersion : undefined;
        const toStored = ctx.store.loadFamily(familyId, toV);
        const latest = toV ?? Number(toStored.meta.version);
        const fromStored = ctx.store.loadFamily(
          familyId,
          fromV ?? (latest > 1 ? latest - 1 : undefined)
        );
        const diff = diffVersions(
          { version: Number(fromStored.meta.version), result: fromStored.result },
          { version: Number(toStored.meta.version), result: toStored.result },
          body.alpha
        );
        return send(res, 200, diff);
      }

      send(res, 404, { error: { code: "BAD_REQUEST", message: `无此路由：${method} ${path}` } });
    } catch (err) {
      if (err instanceof BhError) {
        return send(res, HTTP_STATUS[err.code], {
          error: { code: err.code, message: err.message, details: err.details },
        });
      }
      console.error(err);
      send(res, 500, { error: { code: "INTERNAL", message: "内部错误" } });
    }
  });
}

async function main(): Promise<void> {
  const requestedPort = Number(process.env.PORT ?? "0");
  const port = Number.isInteger(requestedPort) && requestedPort > 0
    ? requestedPort
    : await pickFreePort();
  const dbPath = process.env.BH_DB_PATH ?? resolve(process.cwd(), "data", "bh.sqlite");
  const store = new Store(dbPath);
  const server = await createApp({ store });
  server.listen(port, "127.0.0.1", () => {
    console.log(`BH 后端已启动: http://127.0.0.1:${port}`);
    console.log(`数据文件: ${dbPath}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
