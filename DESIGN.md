# pi-model-manager 设计

## 定位

管理 **Pi 自己的模型配置** `~/.pi/agent/models.json`。

用户提供 Base URL + API Key，插件从上游拉取模型列表并写入该文件。不引入第二套配置文件，不注册 `pi-auto-*` 之类的影子 Provider。

## 为什么不注册动态 Provider

早期实现用 `pi.registerProvider()` 注册动态 Provider，问题有三个：

1. 需要 `createProvider()` 和 `@earendil-works/pi-ai/api/*` 子路径。扩展只被别名了少数裸模块名，安装后的插件目录没有 `node_modules`，子路径解析失败导致整个扩展加载失败。
2. 动态 Provider 的模型是运行时的，不体现在用户的配置里，用户看不到也改不了。
3. 认证被迫走 `/login`，与用户「直接给 apiKey」的期望不符。

写 `models.json` 则没有这些问题：Pi 原生读取该文件，写入后刷新即生效，用户看到的和 Pi 用的是同一份数据。

## 模块

```text
index.ts               命令注册 + 与 Pi 的桥接（认证解析、保存校验）
src/models-json.ts     models.json 读写（保留未知键、原子写、备份、回滚）
src/discovery.ts       上游模型发现与解析
src/ui/frame.ts        统一的边框 / 表格 / 列宽布局
src/ui/manager.ts      四个界面与输入状态机
```

`src/ui/manager.ts` 里的纯函数（行构建、草稿校验、草稿套用、请求头解析、密钥脱敏）单独导出，便于测试，不需要跑 TUI。

## 界面

四个界面，都是「一个列表 + 一行按键提示」的结构，不并排挤压：

```text
接入列表 → 模型列表 → 接入表单 / 模型表单
                    → 从上游获取（多选）
```

- 文本字段用底部单行内联编辑（带 `CURSOR_MARKER` 以支持输入法）
- 枚举和布尔字段用 `←→` 原地切换
- 字段留空即删除该配置项，而不是写入空字符串

## 保存契约

```text
写入 models.json
  → registry.refresh({ allowNetwork: false })   // 不触发网络
  → registry.getError()
  → 有错则还原原文件并再次 refresh，报错给用户
```

这个回滚不是可选项。已实测确认：Pi 对 `models.json` 做**整文件** schema 校验，一个条目不合法（例如 `id` 写成数字）会让**所有** Provider 一起失效，`getError()` 返回 `Invalid models.json schema`。没有回滚的话，一次手误就会让用户失去全部模型。

`refresh({ allowNetwork: false })` 会重新加载 `models.json`，且不发起网络请求，所以保存很廉价。

## 保留未知键

Pi 的 schema 允许额外键。实测用户的 `mimo` 接入里就有另一个工具写入的 `piModelManager` 标记。

因此表单只对**它自己列出的字段**做增删（`setOrDelete`），其余键原样保留。直接替换整个 Provider 对象会破坏其它工具的状态。

## 发现规则

模型列表地址按各 SDK 实际追加的路径决定，而不是按猜测：

| 协议 | SDK 追加 | 发现地址 |
| --- | --- | --- |
| `anthropic-messages` | `/v1/messages` | `${baseUrl}/v1/models`（baseUrl 已带 `/v1` 时不重复） |
| `openai-completions` / `openai-responses` | 无版本段 | `${baseUrl}/models` |
| `google-generative-ai` | 无（baseUrl 自带 `/v1beta`） | `${baseUrl}/models` |

依据：Pi 内置的 Anthropic 接入 baseUrl 是 `https://api.anthropic.com`、MiniMax 是 `https://api.minimax.io/anthropic`，都不带 `/v1`，说明 SDK 会自己补。网关路径 (`.../anthropic`) 同样要补 `/v1`。

认证按协议选择请求头：`Authorization: Bearer` / `x-api-key` + `anthropic-version` / `x-goog-api-key`。

解析兼容 OpenAI、Anthropic、Google、OpenRouter 四种返回形态。

## 字段来源分级

一个值可能有三种来源，必须能分辨，否则无法判断该不该相信：

| 来源 | 含义 | 界面标记 |
| --- | --- | --- |
| `upstream` | 网关自己声明的 | 无标记 |
| `catalog` | Pi 内置目录（1000+ 条）补齐 | `*` |
| `guess` | 按模型名推断 | `?` |

优先级：`upstream > catalog > 留空`。`guess` 只用于思考/图片能力。

**内置目录不覆盖上游值。** 目录里记的是厂商原生上限，而网关可能限得更低——实测同一个 `claude-sonnet-5`，用户网关声明 1M，而内置 `anthropic` 条目也写 1M，但 `gpt-5.6-sol` 网关给 1.05M 而 Pi 直接接入时故意用 272k 以落在便宜计费档位。上下文窗口影响压缩阈值和计价，不能默默改。

内置索引会**排除 models.json 里已定义的 Provider**：那是用户自己的配置，用它当参考等于把旧值洗成「Pi 说的」，没有任何新信息。

## 接入列表的可见范围

第一版把「你的接入」等同于「models.json 里的接入」,于是用 `/login` 登录的 deepseek、kimi-coding 这些**完全不显示** —— 但用户的预期是「我登录了就应该看得到」。

现在的规则是并集：

```text
显示  = models.json 里有配置  ∪  Pi 报告已配置凭据
隐藏  = 两者都没有（这才是纯噪声）
```

凭据来源用 `getProviderAuthStatus()` 读,而不是自己解析 `auth.json`。好处是 `/login`、`--api-key`、环境变量、`models.json` 里的 `$ENV_VAR`/`!command` 全部统一,且**插件不接触密钥本身**。

同时修了一个计数错误：模型数只统计了配置里的模型,所以已登录的内置接入显示 `模型 0`，看起来像空条目。现在凡是展示中的非配置行都从 Pi 目录取真实数量。

顺带一提：登录过的接入不需要写 `models.json` 就已经可用。插件的价值在于能 `f` 用同一份凭据去上游发现**更多**模型（实测：deepseek 能解析出 key、endpoint、api，去请求 `https://api.deepseek.com/models`）。

## 底部区域：提示与键位分离

早期实现里状态信息会**替换**键位提示，结果是操作一次之后就再也看不到按什么键。现在分两行：

```text
text  ← 操作结果 / 当前提问（notice）
text  ← 键位提示（footer，总是渲染）
```

临时信息（tone=dim）4 秒后自动清掉，避免一条「已保存」永远挂在那里变成家具；错误和警告不清，直到下一个操作替换。

键位提示用 `hintLines()` 排版，最多两行。单行渲染在窄终端会静默截断，而被截掉的总是最后一个 —— 通常恰好是「怎么退出」。两行也装不下时，会截断中间并保留最后一条提示。

## 列表视口

列表必须有视口。一次性渲染全部行会让选中行被挤出屏幕，光标看不见也找不回来 —— 69 个模型就会出现。

规则：

```text
可见行数 = clamp(终端行数 / 2 - 3, 4, 18)
窗口 = 以选中行为中心，在列表两端夹紧
```

为什么是终端一半而不是全部：非 overlay 的 `ctx.ui.custom()` 组件会**替换编辑器**，而不是接管整屏（`showExtensionCustom` 把组件加进 `editorContainer`），上方还留着对话记录。所以不能假设自己拥有整个终端高度。Pi 自带的模型选择器用的是同一个公式（居中选择后 clamp），只是它固定 10 行。

列表被截断时，表头下面会多一行 `第 33-49 项 / 共 69 项`。没有这一行，被限额的列表看起来就只是被截断了，无法知道下面还有内容。

## 光标不能只靠颜色

选中行有背景色，但浅色主题下 `selectedBg` 很淡，且终端可能不支持颜色。所以表格预留了一个 2 列的标记栏，渲染 `›`：颜色是辅助，字形才是保证。

## 接入列表的可见范围

默认只列出 `models.json` 里有配置的接入。Pi 自带的接入没有用户的东西可管，列出来只是噪声。需要给内置模型写覆盖时按 `b` 展开，此时模型数从 Pi 的目录取。

注意这里曾经有个错误：计数只统计了配置里的模型，所以内置接入全部显示 `模型 0`，看起来就像「一堆空的接入」。这也是用户看到的实际现象。现在展开时才去取真实数量。

## 编辑能力与三种写入目标

「来源」列不只是展示信息,它决定了编辑写到哪:

| 来源 | 存储位置 | 编辑目标 | 删除 |
| --- | --- | --- | --- |
| 配置 | `providers[x].models[]` | 该条目 | 删条目 |
| 覆盖 | `providers[x].modelOverrides[y]` | 覆盖项 | 删覆盖项 |
| 内置 | 无（Pi 生成） | 新建覆盖项 | 无可删 |

Pi 的内置目录是生成的元数据,不能改。编辑内置模型必须走 `modelOverrides`,由 Pi 按字段合并到目录模型之上（源码里 `applyModelOverride` 逐字段 `??`）。已实测：覆盖后 `contextWindow` 生效,而 `input`/`reasoning`/`cost` 等未覆盖字段全部保留。

## 编辑时的两个坑（已在实现里避开）

### 1. 不能把目录值预填成覆盖内容

内置模型的表单如果预先填入目录值（如 `contextWindow: 128000`）,那么「打开就保存」也会把这些数字写成显式覆盖 —— 等于把模型钉死在今天的数值上,以后 Pi 更新目录也不会生效。

所以编辑覆盖时,表单只反映覆盖项本身,上方单列一行「当前生效」告知实际值。这与发现流程的原则一致：**只写用户明确设过的字段。**

### 2. 清空最后一个覆盖会让 Provider 条目变成空对象

Pi 会拒绝一个什么都不配置的 Provider 条目（报 `must specify ...`）。如果清空最后一个覆盖后留下 `{"builtin": {}}`,保存会被 schema 拦下并回滚。因此 `pruneEmptyProvider` 在覆盖清空时直接删掉 Provider 条目。

同理,删除一个带覆盖的配置模型时会一并删掉它的覆盖项,不然会留下一条永远不生效的死配置。

## 字段编辑的替换语义

内联编辑时,第一个输入字符会**替换**预填的旧值。这是刻意的:预填 `1000` 时接上 `200000` 会得到 `1000200000`,而这个错值会被当成事实写入。要逐字修改先按 Backspace。页脚会按状态提示这条规则。

## 手动填写 vs 自动获取

实测用户网关（OpenAI 兼容）的响应：

```text
字段: id, object, created, owned_by, name, context_length, supported_endpoints
76 个模型，全部带 context_length
```

所以对这类网关上下文完全可自动获取，`f` 一键就补齐了，不需要手填。对只剩 id 的接口（如官方 OpenAI），则靠内置目录兜底。

## 覆盖已有条目的门禁

默认只新增，不碰已有条目。要改写已有条目必须按 `u` 显式选择，因为那会改变上下文窗口从而改变成本。这是刻意的不对称：

```text
新增          → 默认勾选
值不同（既有）→ 默认不勾选，按 u 才勾
值相同（既有）→ 不勾选，也无意义
```

## 只写有来源的字段

模型条目不写默认值，因为填入的默认值会被当成事实：

```json
{ "id": "only-an-id" }
{ "id": "m", "contextWindow": 1000000, "maxTokens": 65536 }
```

缺失字段交给 Pi 的默认值，用户随后可在表单里改。

## 认证

不自己解析 apiKey，而是问 Pi：

```text
getProviderAuthStatus()   仅报告来源与是否可用（不返回密钥）
getProviderAuth()         解析出真正要用的 apiKey / headers / baseUrl
```

覆盖 `models.json` 字面值、`$ENV_VAR`、`!command`、`/login` 的 auth.json，以及 `--api-key`。

发现模型时优先用 `getProviderAuth()` 返回的 `baseUrl`（订阅型 OAuth 的 endpoint 来自凭据，而不是目录），这与一次真实请求的取址一致。

## 边界

- 不修改 Pi 内置目录，只能通过写配置覆盖。
- 不做批量操作、健康检查、延迟测试。
- 上游没有模型列表接口时只能手动添加。
- `models.json` 的注释在重写后会丢失（已检测并提示，且有备份）。
