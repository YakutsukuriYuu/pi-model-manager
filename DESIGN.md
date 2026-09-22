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

## 只写上游报告过的字段

模型条目只写上游真正给出的信息：

```json
{ "id": "only-an-id" }
{ "id": "m", "name": "M", "contextWindow": 100000, "maxTokens": 8000 }
```

不填默认值，因为填入的默认值会被当成事实（例如给 1M 上下文的模型写死 128k）。缺失的字段交给 Pi 的默认值，用户随后可以在表单里改。

从模型 ID 推断的能力（`vision`、`reasoning`）在界面上标 `?`，表示是猜测。

## 认证

不自己解析 apiKey，而是用 `registry.getProviderAuth(providerId)`：

```text
models.json apiKey 字面值
$ENV_VAR 引用
!command 命令
/login 存入 auth.json 的凭据
```

四种来源由 Pi 统一解析，插件不用重复实现。

## 边界

- 不修改 Pi 内置目录，只能通过写配置覆盖。
- 不做批量操作、健康检查、延迟测试。
- 上游没有模型列表接口时只能手动添加。
- `models.json` 的注释在重写后会丢失（已检测并提示，且有备份）。
