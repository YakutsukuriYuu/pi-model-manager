# pi-model-manager

统一查看、发现和切换 Pi 中的模型。当前版本提供只读模型目录，并开始支持由本插件创建的标准 Provider。已有 Provider 不会被覆盖。

## 安装

通过 Pi 安装 GitHub 仓库：

```bash
pi install git:github.com/YakutsukuriYuu/pi-model-manager
```

本地测试：

```bash
pi -e ./index.ts
```

## 使用

安装或通过本地路径加载后，在 Pi 中执行：

```text
/models
```

添加一个由本插件管理的 Provider：

```text
/models add
```

添加完成后执行：

```text
/login pi-auto-<name>
/models
```

插件会通过标准 `/models` 接口发现模型。快捷键：

- `↑/↓`：移动
- `Enter`：选择当前模型
- `/`：搜索
- `Tab` / `f`：切换 Provider 筛选
- `a`：添加 Provider
- `r`：刷新模型目录
- `Esc` / `q`：关闭

## 刷新行为

- 启动时是缓存优先：Pi 用上次持久化的目录，不发网络请求。
- 按 `r` 时才请求上游 `/models`，成功后发现并持久化。
- 刷新失败只报错，不会清空已有模型。
- 未执行 `/login` 前静默跳过，不报错。
- `--offline` 下不发任何请求。

## 开发

```bash
npm install
npm run check   # typecheck + 单元测试
```

测试覆盖发现接口的三种返回格式、各协议的请求头与 URL 规则，以及刷新/离线/失败/中止时的行为。

## 当前边界

- 内置 Provider 和其他扩展注册的模型显示为只读。
- `/models add` 支持 `openai-completions`、`openai-responses`、`anthropic-messages` 和 `google-generative-ai`。
- Provider 元数据保存到 `~/.pi/agent/pi-model-manager.json`；API Key 交给 Pi 的 `/login` 和 auth 存储处理。
- 当前版本还没有模型字段编辑、Provider 删除和自定义 Header 编辑界面。
- 运行时无法可靠暴露模型最初来自哪个配置文件，因此外部 Provider 标记为 `Registry`。
