# BH 多重检验调整与拒绝集合核验后端

纯本地运行的 **Benjamini–Hochberg（BH）多重假设检验** 结果整理服务，提供 HTTP API 与命令行（CLI）。
使用 TypeScript + Node.js（内置 `node:sqlite`）+ SQLite，**不依赖 Docker、WSL、付费服务或任何在线 API**。

本服务**只整理用户已经提供的 p 值**：不拟合模型、不做方差分析、不执行统计检验、不剔除大 p 值、
不把调整后 p 值解释为“假设为真的概率”。

---

## 1. 环境要求

- Windows，PowerShell 7（或任意终端）
- Node.js **>= 22.5**（开发机实测 v25.5.0；需要内置 `node:sqlite`，用 `--experimental-sqlite` 开启）
- npm（随 Node 安装）

## 2. 安装、构建、测试、启动、演示

```powershell
npm install        # 安装 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 编译测试并运行 node:test（20 个用例）
npm start          # 启动 HTTP 服务（默认自动选空闲端口）
npm run demo       # 端到端演示（导入、多 alpha、版本对比、JSON/CSV 导出）
```

启动后控制台打印实际监听地址，例如 `http://127.0.0.1:56894`，仅绑定 `127.0.0.1`。

环境变量：

- `PORT`：指定端口；不设或为 `0` 时自动选择空闲端口（默认）。
- `BH_DB_PATH`：SQLite 文件路径；默认 `<项目目录>/data/bh.sqlite`（数据目录在项目内，自动创建）。

CLI（构建后 `node --experimental-sqlite dist/cli.js <命令>`，也可用 `npx bh`）：

```text
bh preview  <items.json|内联JSON>                    仅校验+预览，不写库
bh import   <familyId> <items.json> [--key K]        原子导入，冻结为新版本
bh family   <familyId> [--version N] [--csv]         查看冻结族排序表
bh decide   <familyId> --alpha 0.05 [--version N] [--csv]  按阈值判定
bh item     <familyId> <itemId> [--version N]        查单条调整值与来源秩
bh diff     <familyId> --alpha 0.05 [--from N] [--to N]    比较两个版本
bh export   <familyId> --out result.csv|result.json [--version N]
bh list                                             列出所有族
```

快速体验：

```powershell
node --experimental-sqlite dist/cli.js preview examples/items.json
node --experimental-sqlite dist/cli.js import demo examples/items.json
node --experimental-sqlite dist/cli.js decide demo --alpha 0.05
node --experimental-sqlite dist/cli.js item demo g2
node --experimental-sqlite dist/cli.js export demo --out demo.csv
```

## 3. HTTP API

所有请求/响应均为 JSON（导出接口支持 CSV）。错误响应统一为
`{"error":{"code":"...","message":"...","details":...}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/families` | 列出全部族及版本 |
| POST | `/api/families/:id` | 导入一族（同 id 再导入 = 新版本）；body 可带 `idempotencyKey` |
| GET | `/api/families/:id?version=N` | 读取冻结族排序表 |
| POST | `/api/families/:id/decide` | body `{"alpha":"0.05","version":1}`；可加 `?format=csv` |
| GET | `/api/families/:id/items/:itemId?version=N` | 查询单条来源 |
| POST | `/api/families/:id/diff` | body `{"alpha","fromVersion","toVersion"}` |
| GET | `/api/families/:id/export?format=csv&version=N` | 导出 JSON/CSV |

导入 body：`{"items":[{"id":"g1","p":"0.01"}, ...], "idempotencyKey":"可选"}`。

错误码：`INVALID_JSON`、`INVALID_DECIMAL`、`SCIENTIFIC_NOTATION_NOT_ALLOWED`、
`TOO_MANY_DECIMALS`、`OUT_OF_RANGE`、`EMPTY_ID`、`DUPLICATE_ID`、`EMPTY_FAMILY`、
`TOO_MANY_TESTS`、`MISSING_FIELD`、`FAMILY_NOT_FOUND`、`VERSION_NOT_FOUND`、
`ITEM_NOT_FOUND`、`IDEMPOTENCY_CONFLICT`、`BAD_REQUEST`、`INTERNAL`。

## 4. 输入规则（严格校验）

- p 值与 alpha 均为 **`[0,1]` 区间的十进制字符串**，最多 **12 位小数**。
- 接受 `"0.01"`、`"1"`、`".5"`、`"0"`；**拒绝**科学计数（`1e-3`）、`NaN`、`Infinity`、
  空串、null、数字类型、隐式空值。
- 每族 **1–10000** 条；编号必须**非空且在族内唯一**。
- 任一输入不合法则整批拒绝（事务回滚），**不会产生残缺族**。

## 5. 算法说明（精确判定）

### 5.1 精确数值

十进制字符串解析为整数比例（分子/分母），约分为既约分数；**关键比较与调整全部用 BigInt
分数交叉相乘完成，判定不依赖显示舍入**。响应同时给出既约分数（如 `4/75`）与显示小数；
除不尽时显示小数按 12 位四舍五入（仅用于展示）。

### 5.2 稳定排序

按 p 升序；p 相同时按编号 UTF-16 码元字典序。秩 `i` 从 1 开始。全部输入都参与，`m`
为整族大小，不剔除大 p 值，也不用“显著结果数量”作分母。

### 5.3 拒绝集合（截止秩法）

找到满足

```text
p(i) <= i * alpha / m
```

的**最大秩 i**（等于门槛算通过）：若存在则排序后前 i 项**全部拒绝**——即使前面某些秩自身
比较未通过（典型见示例 2）；不存在则全部保留。报告中同时给出每项的 `ownPass`（自身门槛比较）
与 `rejected`（是否被最终集合覆盖），二者明确区分。

### 5.4 调整后 p 值（从后向前单调修正）

```text
adj(m) = min(1, m*p(m)/m)
adj(i) = min(1, m*p(i)/i, adj(i+1))
```

不是“每个 p 简单乘 m”。实现中还：

- 对相同 p 的秩块强制相同调整值（块内取最小）；
- 记录每项最小值实际来源的秩，**来源并列时固定取较小秩**；
- 校验不变量：`adj(i) >= p(i)`，且调整值随排序 p 单调不减；
- 用**独立穷举每个后缀的 `min m*p(j)/j`** 交叉核对递推结果；
- 断言逐项 `adj <= alpha` 与截止秩法得到**完全相同**的拒绝集合。

### 5.5 两个题目示例

1. `p=[0.01,0.04,0.03,0.2]`，原顺序调整值 = `[0.04, 4/75, 4/75, 0.2]`，
   `alpha=0.05` 截止秩 1，仅拒绝第一项。
2. `p=[0.02,0.03,0.04]`，`alpha=0.05`：秩 1 门槛 `0.0166…`，`0.02` 自身**不通过**；
   但秩 3 通过（`0.04 <= 0.05`），截止秩 3，**三项全部拒绝**。

## 6. 冻结族、多 alpha 与版本

- 族一经导入即**冻结**：对同一族可查询任意多个 alpha，全部复用原始 `m`、秩与调整值，
  不会按阈值重新挑选参与检验的行。
- 修改、增加或删除 p 值再次导入会生成**新版本**；旧版本的 `m`、秩、结果永久保留不改写。
- 版本比较按编号对应，报告 `newlyRejected`（新增拒绝）、`restored`（恢复保留）、
  `unchangedRejected/unchangedRetained`，以及条目级 `added/removed/changed`。
- 相同 `idempotencyKey` 的重复导入返回首个版本（幂等）；幂等键跨族复用返回
  `409 IDEMPOTENCY_CONFLICT`。
- SQLite 持久化原始字符串、精确分子/分母（BigInt 以 TEXT 存储）、稳定秩、调整值、
  来源秩与算法版本；重启后仍可按原族在不同阈值下读取结果。

## 7. 统计解释（FDR 含义与限制）

BH 在 p 值**相互独立或满足特定正相关（PRDS）**的条件下，把错误发现率
（False Discovery Rate，被拒绝假设中错误拒绝所占比例的**期望值**）控制在
`(m0/m)·alpha <= alpha`。请注意：

- 这是**期望层面**的保证，**不是**“本次拒绝集合里错误数一定少于某个整数”；
- 调整后 p 值**不是**“该假设为真的概率”；
- 任意（含任意负）相关性结构下不保证同一界值，需要更保守的方法（如 BY）。

## 8. 项目结构

```text
src/
  decimal.ts   十进制字符串 -> BigInt 既约分数、比较、显示
  bh.ts        校验、稳定排序、BH 调整、截止秩、版本比较、不变量核对
  store.ts     SQLite 原子导入/冻结版本/幂等/重启恢复
  export.ts    JSON / CSV 导出
  server.ts    零依赖 node:http API（空闲端口选择）
  cli.ts       命令行
tests/         node:test：算法、存储、HTTP 共 20 个用例
demos/         端到端演示
examples/      示例输入
data/          运行后生成的 SQLite 数据目录（已 gitignore）
```

## 9. 主要假设与限制

- 仅支持单侧 BH（标准 Simes 式门槛）；未实现 q 值插页之外的 BY/bonferroni/holm。
- 调整值上限为 1；显示小数最多 12 位，精确判定始终以分数为准。
- 服务仅监听 `127.0.0.1`，无鉴权（设计为本机工具）；请求体上限 8 MiB。
- 编号区分大小写，按 UTF-16 码元字典序作为相同 p 的固定次序。
- `node:sqlite` 在当前 Node 版本仍带实验性警告，功能稳定但 API 以后可能调整。
