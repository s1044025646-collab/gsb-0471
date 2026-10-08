import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApp } from "../src/server.js";
import type { Server } from "node:http";

let store: Store;
let server: Server;
let base: string;

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "bh-api-"));
  store = new Store(join(dir, "api.sqlite"));
  server = await createApp({ store });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
  store.close();
});

async function j(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  if (text && (res.headers.get("content-type") ?? "").includes("application/json")) {
    json = JSON.parse(text);
  }
  return { status: res.status, json, text };
}

test("健康检查与导入-判定-查询-比较完整流程", async () => {
  const health = await j("GET", "/health");
  assert.equal(health.status, 200);

  const bad = await j("POST", "/api/families/demo", {
    items: [
      { id: "a", p: "0.1" },
      { id: "a", p: "0.2" },
    ],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "DUPLICATE_ID");

  const imp = await j("POST", "/api/families/demo", {
    items: [
      { id: "a", p: "0.01" },
      { id: "b", p: "0.04" },
      { id: "c", p: "0.03" },
      { id: "d", p: "0.2" },
    ],
  });
  assert.equal(imp.status, 201);
  assert.equal(imp.json.version, 1);

  const decision = await j("POST", "/api/families/demo/decide", { alpha: "0.05" });
  assert.equal(decision.status, 200);
  assert.deepEqual(decision.json.rejectedIds, ["a"]);
  assert.equal(decision.json.cutoffRank, 1);

  const item = await j("GET", "/api/families/demo/items/b");
  assert.equal(item.json.adjustedPFraction, "4/75");

  await j("POST", "/api/families/demo", {
    items: [
      { id: "a", p: "0.01" },
      { id: "b", p: "0.04" },
      { id: "c", p: "0.03" },
      { id: "d", p: "0.2" },
      { id: "e", p: "0.99" },
    ],
  });
  const diff = await j("POST", "/api/families/demo/diff", { alpha: "0.05" });
  assert.deepEqual(diff.json.added.map((x: { id: string }) => x.id), ["e"]);

  const csv = await j("POST", "/api/families/demo/decide?format=csv", { alpha: "0.05" });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^﻿?rank,id,p,/);
  assert.ok(csv.text.includes("a"));
});

test("科学计数法返回 400 且带专用错误码", async () => {
  const r = await j("POST", "/api/families/sci", {
    items: [{ id: "a", p: "1e-3" }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "SCIENTIFIC_NOTATION_NOT_ALLOWED");
});
