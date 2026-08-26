# dsh-poor-router 穷鬼路由器

**DeepSeek Harness 的免费/廉价 LLM 池路由器**——把你够得着的每一个免费额度记账、盯健康、自动绕障，带 Web 面板与实时改道指示灯。

[English](README.md)

## 穷鬼宣言

这个插件是设计给穷鬼的——**富哥请走**。

众所周知，穷鬼有两个特点：一个是「穷」，另一个就是「鬼」。

穷，所以付费 API 的价格表看一眼就默默关掉；鬼，所以哪里有免费额度，哪里就有我们的身影。NVIDIA 的赠送金、Qwen 的体验金、GLM 的 flash 档、OpenRouter 的 `:free` 通道……免费的 API 到处都有，可每家的额度偏偏都烧到一半就断流——你正写到关键处，它咽气了；你慌忙换一个重试，换到的那个也奄奄一息。一晚上下来，时间全花在给各家免费 API 收尸上。

于是，穷鬼路由器堂堂登场——

- **它不施舍，只记账。** 每个免费条目烧了多少、还剩几口气、今天几点钟开始闹脾气，笔笔在案。
- **它不祈祷，只采样。** 谁此刻健康、谁在装死，Beta 后验加 Thompson 采样说了算，玄学退散。
- **它不认命，只改道。** 这一家断流，同档的下一家无缝顶上——你的会话根本不知道刚才发生过什么。
- **它不花钱。** 除非全部免费模型集体阵亡，逃生舱才放行限额内的最便宜付费模型救场——而且花出去每一分钱都会发短信向你报丧。

富哥们有预算告警、有专属客户经理、有 SLA。

我们有什么？我们有**整个免费互联网**。

## 为什么做这个

免费额度是散落的：NVIDIA 的赠送金、Qwen 的体验金、GLM 的 flash 档、OpenRouter 的 `:free` 通道……每一家倒下的时间点都不一样。本插件把它们当成**一个池子**来经营：计量你实际发出的每一笔，学习每个条目"此刻"的健康状况，在请求失败前悄悄换马——让你的会话活过额度死掉的时刻。

## 功能

- **自动台账** — 按条目计量：调用/成功/失败/中止、TTFT EMA、Token 入出（含推理 token）。首次出现的模型自动登记入 `pool.json`。
- **TS 自适应路由** — 每条目 Beta 后验（成功/失败），高斯近似采样，TTFT 惩罚（`3000ms/ttft`），当前小时桶双倍权重。
- **时段桶 v2** — 拥堵只看今天的桶（本地时区 `YYYY-MM-DD:HH` 键），7 天滚动清理。不再有陈旧失败造成的"永久拥堵"幽灵。
- **同质量 tier 阶梯** — 给模型标 `tier: S/A/B/C`；改道优先同级圈，逐级降 A→B→C，最后才考虑升级。档位面板可改，即时落盘。
- **执行者池** — 廉价高额度模型标 `role: executor`；辅助/小请求甩给剩余额度最厚者。每第 6 笔 epsilon 探索一个没用过的免费模型（同级圈另有 34% 概率纳入新面孔）。
- **真钱护栏** — 付费模型标 `paid: true` 配单价与日上限；从一切候选名单排除，只在**全部**免费候选死亡时经逃生舱可达——最便宜者优先，过半发短信告警（经 `text_me`）。
- **供应商熔断** — AUTH/QUOTA 级失败冷却 10 分钟，429 冷却 90 秒；冷却状态跨重启持久化。
- **复盘取证** — 改道史环形 50 条落盘、TS 采样记录、持久化日志，处处可见。
- **Web 面板** — 设置页仪表盘：可用性排行（后验均值×延迟惩罚）、供应商分组折叠台账（展开可编辑到期日/用量/质量档）、最近改道、TS 记录。输入框 ⚡ 徽章 ~5 秒内显示最近改道去向，可开关。

## 一次路由决策的路径

```
llm/stream 钩子
├─ 辅助/小请求？ ──► 执行者池（剩余额度最厚者优先）
│                     └─ 每第6笔 ──► epsilon 探索未用过的免费模型
├─ 供应商冷却中？ ──► pickAlt()：同级圈 → 降级 A/B/C → 逃生舱（付费·限额内·最便宜）
├─ 模型冷却中？   ──► pickAlt()
└─ 本时桶拥堵？   ──► pickAlt()   （今天桶内失败率 >60% 且 n≥4）

pickAlt() 用 Thompson 采样 × TTFT 惩罚选人；
34% 概率把未用过的新面孔塞进同级采样窗口。
每次决策都进环形日志；配置永不回写。
```

## 安装

### 从 GitHub（推荐）

```sh
dsh plugin --profile web add github:yishengdaxiaonengjihui/dsh-poor-router
```

或手动：profile 的 `package.json` 加 `"dsh-poor-router": "github:yishengdaxiaonengjihui/dsh-poor-router"`，`dsh.profile.bundles` 列表加 `"dsh-poor-router"`，然后 `pnpm install`。

### 本地 link

```sh
# 在 <DSH_HOME>/profiles/web/package.json 的 dependencies 里：
"dsh-poor-router": "link:D:/某目录/dsh-poor-router"
```

重启 DSH 生效。客户端半由 client-modules 自动打包注入页面。

## 配置

模型相关的一切都在 `pool.json` 里。插件数据目录默认 `<工作目录>/poor-router/`，可在 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: poor-router
  name: dsh-poor-router
  config:
    dataDir: 'D:/我的数据/poor-router'   # 三个数据文件的基目录
    # 或逐一指定：
    # poolPath: '...'
    # statePath: '...'
    # importPath: '...'
    layerRules:                          # 可选：按 id 前缀定默认层级
      - { match: 'deepseek-official/', layer: 'backbone' }
      - { match: 'tokenrouter/', layer: 'matchstick' }
```

条目（entry）关键字段：

| 字段 | 含义 |
|---|---|
| `id` | `provider/model` —— 必须能对上 harness 提议的调用 |
| `expiresAt` | ISO 日期；紧急度排序 + 面板倒计时 |
| `grantRemaining` / `grantUnit` | 执行者池预算 |
| `tier` | `S/A/B/C` 质量阶梯（面板可改） |
| `role` | `"executor"` 加入辅助请求池 |
| `layer` | `backbone`（战略储备不动用）/ `burn` / `matchstick` |
| `paid` + `priceIn/OutYuanPerM` + `dailyCapYuan` | 真钱护栏 |
| `escapeHatch` | 允许作为最后手段的付费模型 |

## Agent 工具

插件注册两个会话工具：

- `pool_status` —— 全量快照（summary + 逐条目统计）。
- `pool_control` —— 手动干预：`setTier`、`setRouting`、`setAdaptive`、`setBadge`、`setExpiry`、`setGrant`、`setDisabled`、`clearProviderCooldown`、`reloadPool` 等。

## FAQ

**改道会永久改变我配置的模型吗？**
不会。路由按请求无状态：每笔请求仍从配置的模型出发，最多只影响这一笔。

**所有免费模型同时死了怎么办？**
逃生舱启动——限额内的最便宜付费模型顶上，你会收到短信，任何一家恢复后自动回归正常。

**没有 Web GUI 能用吗？**
能。工具链无头可用；面板和指示灯只是没有渲染位置而已。

## 许可证

[MIT](LICENSE)
