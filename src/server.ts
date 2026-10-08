// 服务器入口：默认自动选择空闲端口（PORT 环境变量可指定）。

import { createApiServer } from "./api.ts";
import { Store, defaultDbPath } from "./store.ts";

const store = new Store(process.env.BH_DB ?? defaultDbPath());
const server = createApiServer(store);

const preferred = process.env.PORT ? Number(process.env.PORT) : 0; // 0 = 空闲端口

server.listen(preferred, "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : preferred;
  console.log(`BH 服务已启动: http://127.0.0.1:${port}`);
});

process.on("SIGINT", () => {
  server.close();
  store.close();
  process.exit(0);
});
