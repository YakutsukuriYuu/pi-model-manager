# pi-model-manager

直接管理 Pi 自己的模型配置 `~/.pi/agent/models.json` 的 TUI 插件。

你只需要提供 **Base URL** 和 **API Key**，插件负责把上游的模型列表拉取出来写进配置。

## 安装

```bash
pi install git:github.com/YakutsukuriYuu/pi-model-manager
```

试用（不写入设置）：

```bash
pi -e git:github.com/YakutsukuriYuu/pi-model-manager
```

## 使用

```text
/models
```

### 接入列表

```text
↑↓/PgUp/PgDn/Home/End 选择   Enter 进入   n 新建   b 内置   r 重载   d 删除   Esc 关闭
```

列表显示**属于你的接入**:

- 在 `models.json` 里配置过的
- 用 `/login` 登录过、或通过环境变量/`--api-key` 提供凭据的

两者取并集。既没配置又没凭据的 Pi 内置接入不显示 —— 它们里没有你的东西。

```text
 Pi 模型配置 · 已配置 1 · 已登录 4 · 模型 29
  接入                    协议                  认证       来源    模型
› commandcode            openai-completions   环境变量   配置      15
  deepseek               内置                  已登录     内置       2
  kimi-coding            内置                  已登录     内置       4
```

「认证」列告诉你凭据从哪来：

| 显示 | 含义 |
| --- | --- |
| 已登录 | `auth.json`（`/login` 保存的 API key 或订阅令牌） |
| 环境变量 | `models.json` 里写的 `$ENV_VAR` 引用 |
| 配置 | `models.json` 里的字面值或 `!command` |
| 本次运行 | `--api-key` 传入 |
| 未登录 | 没有任何可用凭据 |

用 `/login` 登录的接入**不需要写进 `models.json`**：Pi 已经给它配好了模型。你可以进入它看看，还能按 `f` 用你登录的凭据去上游把**更多**模型拉下来（实测：登录的 deepseek 能解析出凭据、endpoint、协议，`f` 会去请求 `https://api.deepseek.com/models`）。

需要看 Pi 自带但你没用过的接入时按 `b`。

### 新建接入

按 `n`，依次填写：

```text
接入 ID  →  名称（可空）  →  协议（←→ 切换）  →  Base URL  →  API Key
```

按 `Ctrl+S` 保存，回到该接入后按 `f` 从上游获取模型：

```text
发现 12 个，其中 3 个是新的（已勾选）
```

勾选后按 `Enter` 写入配置。**已有的模型不会被改写，只新增勾选项。**

### 模型列表

```text
↑↓/PgUp/PgDn/Home/End 选择   Enter 使用   e 编辑模型   a 添加模型   f 获取模型   p 编辑接入   d 删除   Esc 返回
```

列表有视口，光标永远在屏幕内。行数超过可见范围时，表头下面会显示位置：

```text
  模型                    上下文     输出  能力      来源
  第 33-49 项 / 共 69 项
  model-32                 160k      16k  文本      配置
› model-40                 168k      16k  文本      配置
  ★ model-42               170k      16k  文本      配置
```

`›` 是光标，`★` 是当前会话正在用的模型。长列表用 `PgUp`/`PgDn` 翻页，`Home`/`End` 跳到首尾。

- `Enter` 把该模型设为当前会话模型
- `↑↓` 移动（首尾循环），`PgUp`/`PgDn` 翻页，`Home`/`End` 跳首尾
- `e` 编辑选中模型的字段（上下文窗口、最大输出、思考、图片、显示名）
- `a` 手动添加一个模型
- `f` 重新从上游获取，自动填上上下文窗口，并补齐缺失的模型
- `p` 编辑接入（Base URL、API Key、协议、authHeader、请求头）
- `d` 删除该模型的配置

### 所有字段都能改

表单里有专门输入行的字段（模型 ID、名称、上下文、输出、思考、图片、接入的 Base URL / API Key / 协议 / authHeader / 请求头）直接改。其余字段通过**「其它字段」**这一行以 JSON 编辑：

```text
  其它字段       {"cost":{"input":3,"output":15,…},"thinkingLevelMap":{…}}
```

包括：

| 层级 | 可在此设置的键 |
| --- | --- |
| 模型 | `cost`、`thinkingLevelMap`、`samplingParams`、`promptCache`、`headers`、`compat`、`api`、`baseUrl` |
| 接入 | `compat`、`modelOverrides`、`oauth` 等 |

规则：

- 清空这一行即删除所有这些键
- 写在这里的键会**整体替换**旧值，所以删掉某个键就是真的从文件里删掉
- 已有专门输入行的键写在这里会被拒绝（避免两个地方改同一个值）
- 未知键允许通过；Pi 本身允许额外键
- 编辑长值时显示的是**尾部**（你正在输入的那一端）

## 底部两行

提示信息和键位提示**分别占一行**，不会互相覆盖：

```text
 删除模型 deepseek/deepseek-v4-pro 的配置？     ← 上一个操作/当前提问
 y 确认删除   其他键 取消                        ← 键位提示，始终存在
```

临时信息（如「已保存」）4 秒后自动消失；错误和警告会一直留着直到下一个操作。

键位提示放不下时会折成两行；如果两行还装不下，会截断中间并**保留最后一个提示**（通常是 `Esc` 返回）—— 单调截断时丢的恰好是它。

## 归属：配置 / 覆盖 / 继承

每个模型都有一个归属，它决定了编辑和删除的作用位置：

| 来源 | 存在哪里 | 按 `e` | 按 `d` |
| --- | --- | --- | --- |
| **配置** | `models.json` 的 `models` | 直接编辑 | 删除条目 |
| **覆盖** | `models.json` 的 `modelOverrides` | 编辑覆盖项 | 删除覆盖项 |
| **继承** | Pi 的内置目录（不是你的） | **接管**成你的配置 | 不可删（先接管） |

### 接管

Pi 的内置模型存在生成出来的目录里，不能改。所以编辑一个继承模型时，插件先把它**接管**成你的一条完整配置：

```text
 接管 deepseek-chat
 保存后成为你的完整配置；清空某项不再跟随 Pi 目录，而是回到 Pi 默认（上下文 128k）
  模型 ID        deepseek-chat
  上下文窗口     131072
  最大输出       8192
```

接管后它就和其它配置模型完全一样：可改、可删，不再有继承关系。

- 按 `t` 可以**批量接管**该接入下所有继承模型（会先问你）
- 接管是**可逆**的：删掉这条配置，它会重新变回「继承」
- 一个注意点：接管会把当前生效的值写死。清空某个字段不会回到目录值，而是回到 Pi 的默认值（上下文 128k）——表单会提醒这一点

### 接入的协议也可能继承

接入条目里省略了 `api` 时，协议从 Pi 的内置接入继承。列表会显示**实际生效的协议**并标 `*`：

```text
 接入                   协议                    认证       来源    模型
› xiaomi-token-plan-cn  openai-responses*       已登录     配置       8
```

`*` = 继承。进接入按 `p` 就能把协议显式写下来，不再继承。

编辑字段时：Enter 开始编辑，**第一个输入字符会替换旧值**（否则在 `1000` 后面接 `200000` 会变成 `1000200000`），要逐字改先按 Backspace。

## API Key 的写法

`API Key` 怎么写就怎么存，Pi 原生支持三种形式：

```text
sk-abc123...       字面值（明文存在 models.json 里）
$MY_API_KEY        环境变量引用
!op read 'op://…'  执行命令取值
```

插件会按 Pi 的规则解析它们（包括 `/login` 保存的凭据），不需要额外配置。

明文写入时注意 `models.json` 里有密钥，建议改用环境变量或命令形式。

## 写入安全

`models.json` 属于 Pi，不是插件私有文件，所以写入做了这些保护：

- **校验后回滚**：写完后让 Pi 重新加载，如果 Pi 判定 schema 不合法就立刻还原原文件。Pi 是整文件校验的，一个条目不合法会导致**所有** Provider 失效，所以这一步必须有。
- **自动备份**：每次写入前把原内容存到 `models.json.bak`。
- **保留未知键**：只修改表单里列出的字段，其它键原样保留（例如其它工具写入的 `piModelManager` 标记）。
- **权限 0600**，原子写入。
- **注释提醒**：Pi 允许 `models.json` 带注释（JSONC），但重写会丢失注释，因此读取时会检测并在有注释时提示。

## 上下文窗口从哪来

会按优先级自动获取，**不需要手填**：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 上游 `/models` | 网关自己声明的值，最权威。识别 `context_length`、`context_window`、`inputTokenLimit`、`max_context_length` 等字段 |
| 2 | Pi 内置目录 | 上游没给时，按模型 ID 从 Pi 自带的 1000+ 条目录里补齐 |
| 3 | 模型名推断 | 仅用于思考/图片能力，界面标 `?` |

界面上的标记含义：

```text
1000k     上游明确返回
1000k*    来自 Pi 内置目录（上游没给）
思考?      按模型名推断，不是任何人的声明
```

**上游已声明的值不会被内置目录覆盖。** 内置目录记的是厂商原生上限，而网关可能限得更低；上下文窗口会直接影响压缩阈值和计价档位，不能猜着改。

如果你的网关确实不返回上下文（例如官方 OpenAI 的 `/models` 只给 id），就靠第 2 层兜底；两层都没命中时才留空，交给 Pi 的默认值。

## 发现规则

按各 SDK 的真实行为推导模型列表地址：

| 协议 | 模型列表地址 |
| --- | --- |
| `anthropic-messages` | `${baseUrl}/v1/models`（SDK 自己会补 `/v1`，网关路径同样处理） |
| `openai-completions` | `${baseUrl}/models` |
| `openai-responses` | `${baseUrl}/models` |
| `google-generative-ai` | `${baseUrl}/models`（baseUrl 通常已含 `/v1beta`） |

认证头按协议选择：`Authorization: Bearer`、`x-api-key` + `anthropic-version`、`x-goog-api-key`。

能识别 OpenAI、Anthropic、Google 以及 OpenRouter 风格的返回格式，并且**只写有来源的字段**，不凭空造数字。

### 获取界面

```text
[ ] 模型                    上下文   输出    能力        状态
[x] vendor/big-model        1000k    65536   文本        新增
[ ] claude-sonnet-5         1000k*   —       思考        不同
[ ] vendor/other            200k     —       文本        已存在
```

- 只有**新增**的默认勾选
- `u` 勾选新增 + 值不同的（会改写已有条目，所以不默认选）
- `a` 全选 / 全不选
- `Space` 单独勾选

## 开发

```bash
npm install
npm run check    # 类型检查 + 单元测试
```

测试覆盖：`models.json` 读写与回滚、未知键保留、JSONC 读取、注释检测、发现接口的四种返回格式、各协议 URL 与请求头、以及表单草稿的字段增删语义。

## 已知边界

- 不修改 Pi 内置目录的模型，只能通过写配置来覆盖（与 Pi 的 `models.json` 语义一致）。
- 没有批量操作，也没有模型健康检查。
- 上游没有模型列表接口时只能手动添加模型。
