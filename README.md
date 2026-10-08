# BH 多重检验调整与拒绝集合核验后端

本地运行的 TypeScript + Node.js + SQLite 服务，对一族**用户已提供的原始 p 值**执行
Benjamini–Hochberg（BH）逐步向上调整，输出调整后 p 值与给定显著性水平 alpha 下的拒绝集合。
仅提供 API 与 CLI，无前端、无 Docker、无外部在线依赖。

## 概念与边界

- **检验族（family）**：一次导入的 1–10000 条带唯一编号的 p 值。族内全部输入都参与
  分母 m，**不会**先剔除大的 p 值，也不会只用显著结果的数量作为分母。
- 本服务只整理用户已给出的 p 值：不拟合模型、不做方差分析、不实施任何检验。
- 调整后的 p 值**不是**"某假设为真的概率"，拒绝集合也不构成此类陈述。

## 精确判定

- p 值与 alpha 以 `[0,1]` 十进制字符串输入，最多 12 位小数；拒绝科学计数法、NaN、
  隐式空值（`null`/缺失/空字符串均报错）。
- 内部统一转换为 `SCALE = 10^12` 的整数比例，关键比较与调整全部使用 **BigInt**，
  判定不依赖任何显示舍入。
- 调整值以**既约分数**（如 `4/75`）与显示小数（最多 12 位）两种形式输出。

## 算法（算法版本 `BH-1.0`）

1. 将 m 个 p 从小到大排序；p 相同按编号字典序排列，保证稳定可复现。秩 i 从 1 开始。
2. **逐级判定（step-up）**：找到满足 `p(i) <= i*alpha/m` 的最大 i；若存在，前 i 项
   **全部**拒绝（不要求此前每个位置都单独通过），否则全部保留。等于门槛算通过。
3. **调整值**：从末尾向前递推 `adj(m) = min(1, m*p(m)/m)`，
   `adj(i) = min(1, m*p(i)/i, adj(i+1))`，再还原到原输入顺序。
   相同原 p 必得相同调整值；每项记录最小值实际来源的秩，并列时取较小秩。
4. 报告区分"某项自己的门槛比较是否通过"与"是否被最终拒绝集合覆盖"。

## 统计解释（务必阅读）

- BH 程序在**相互独立或满足正相关（PRDS）**的检验统计量下，将错误发现率
  FDR（即错误拒绝数占拒绝总数的比例的期望）控制在 `m0/m * alpha <= alpha`。
- FDR 是**期望意义**上的控制：本服务**不**承诺"本次拒绝集合中错误拒绝数一定低于
  某个整数"，单次实现中该比例可以超过 alpha。
- 对**任意相关结构**，BH 的保证不成立（需 BY 修正等更保守方法）；本服务不实现 BY，
  也不宣称任意相关下有相同保证。

## 安装与运行（Windows 本地）

要求 Node.js >= 22（使用内置 `node:sqlite`，无原生编译依赖）。

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # tsc 类型检查并编译到 dist/
npm test           # node:test 运行全部测试
npm start          # 启动 API（默认 127.0.0.1 + 自动空闲端口；PORT=8080 可指定）
npm run demo       # 运行内置演示（两个已知示例）
```

数据目录为项目内 `data/`（默认 `data/bh.sqlite`，可用环境变量 `BH_DB` 覆盖）。
重启后按原族读取，不同 alpha 可反复查询同一冻结版本。

## CLI

```powershell
npm run cli -- import fam1 --file items.json     # 导入族（幂等：相同内容复用版本）
npm run cli -- validate --file items.json        # 仅预览校验，不落库
npm run cli -- adjust fam1 [--version 1] [--format csv]
npm run cli -- decide fam1 --alpha 0.05 [--format csv]
npm run cli -- source fam1 H2                    # 某项的秩/调整值/来源秩
npm run cli -- compare fam1 --from 1 --to 2 --alpha 0.05
npm run cli -- demo
```

`items.json` 格式：`[{"id":"H1","p":"0.01"}, ...]` 或 `{"items":[...]}`。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/families` | 导入族 `{familyId, items:[{id,p}]}`；幂等，内容变化产生新版本 |
| POST | `/validate` | 预览校验 `{items}`，不落库 |
| GET | `/families/:id[?version=N][&format=csv]` | 族信息与调整值表（原输入顺序） |
| GET | `/families/:id/decide?alpha=0.05[&format=csv]` | 排序表、门槛、局部比较、截止秩、拒绝集合 |
| GET | `/families/:id/items/:itemId` | 某项秩、调整值（既约分数）、来源秩 |
| GET | `/families/:id/compare?from=1&to=2&alpha=0.05` | 版本比较：新增拒绝/恢复保留/未变/增删项 |
| GET | `/health` | 健康检查 |

错误统一为 `{"error":{"code","message"}}`，HTTP 状态：400 参数缺失/版本非法，
404 资源不存在，422 输入校验失败。

**错误码**：`EMPTY_VALUE`（空值）、`INVALID_FORMAT`（非法十进制/科学计数法）、
`TOO_MANY_DECIMALS`（超过 12 位小数）、`OUT_OF_RANGE`、`EMPTY_ID`、`DUPLICATE_ID`、
`FAMILY_SIZE`（族大小越界）、`EMPTY_FAMILY_ID`、`INVALID_JSON`、`MISSING_ALPHA`、
`INVALID_VERSION`、`FAMILY_NOT_FOUND`、`ITEM_NOT_FOUND`。

任何一项输入非法（非法十进制、重复编号等）都会**整体拒绝**导入，不发布残缺族。

## 冻结族与版本

- 每次内容变化（增/删/改 p 值）产生新版本；旧版本的 m、秩、调整值与拒绝集合
  **冻结**，不会被悄悄改写。
- 相同编号用于跨版本对应；`compare` 报告新增拒绝、恢复保留与未变项目。
- 同一冻结族可查询多个 alpha，复用已存的排序与调整值，不会按阈值重新挑选行。

## 测试

`npm test` 覆盖：已知示例 `p=[0.01,0.04,0.03,0.2]`（调整值 `[1/25,4/75,4/75,1/5]`，
alpha=0.05 只拒第一项）、逐级判定示例（秩 1 未单独通过但三项全拒）、全零、全一、
单项、重复 p、门槛精确相等、输入重排、增加不显著项、最大精度字符串、
随机族对独立穷举 `min_{j>=i} m*p(j)/j` 的核对、两种拒绝集合计算一致性、
alpha 单调性（alpha 增加不会使已拒绝项恢复保留）、幂等导入与版本冻结、整体拒绝。

## 限制

- 仅接受用户提供的 p 值；不负责 p 值的统计来源与模型假设是否成立。
- 不提供任意相关结构下的 FDR 保证（未实现 Benjamini–Yekutieli 修正）。
- `node:sqlite` 在 Node 25 仍带 ExperimentalWarning，功能可用；如需消除警告可加
  `--no-warnings` 或等待其稳定。
- 单进程服务，面向本地单机使用，未做并发写优化与鉴权。
