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
↑↓ 选择   Enter 进入   n 新建   r 重载   d 删除   Esc 关闭
```

列表里既有 `models.json` 里的接入（来源显示「配置」，可编辑可删除），也有 Pi 内置接入（来源显示「内置」，可以进入查看、给它们写配置覆盖）。

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
↑↓ 选择   Enter 使用   e 编辑接入   a 添加模型   f 获取模型   d 删除   Esc 返回
```

- `Enter` 把该模型设为当前会话模型
- `e` 编辑接入（Base URL、API Key、协议、authHeader、请求头）
- `a` 手动添加一个模型
- `f` 重新从上游获取，自动填上上下文窗口，并补齐缺失的模型
- `d` 删除模型配置

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
