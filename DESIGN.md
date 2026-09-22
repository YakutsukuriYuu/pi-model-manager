# pi-model-manager 设计

## 定位

`/models` 是一个统一的模型目录与切换界面。它读取 Pi 当前运行时已经注册的全部模型，不默认改写 `models.json`，也不接管其他 Provider。

## 来源与权限

| 来源 | 展示 | 修改 | 删除 |
| --- | --- | --- | --- |
| Pi 内置 Provider | 是 | 否 | 否 |
| `models.json` / 其他注册来源 | 是 | 否 | 否 |
| 本插件创建的 Provider | 是 | 是 | 是 |

运行时 `ModelRegistry` 暴露的是合并后的 Provider，因此外部非内置来源统一显示为 `Registry`，不猜测具体文件来源。

## UI

入口为 `/models`，不替换 Pi 原生 `/model`。

- 宽终端：Provider、模型、详情三栏
- 窄终端：模型列表和详情上下排列
- `/` 搜索
- `Tab` / `f` 切换 Provider 筛选
- `r` 刷新动态 Provider
- `Enter` 切换当前会话模型
- `Esc` / `q` 关闭

## Provider 生命周期

Provider 向导使用独立 ID，例如 `pi-auto-company`，避免覆盖 `openai`、`anthropic` 等现有 Provider。

```text
/models add → 输入名称/Base URL/API 类型 → 注册 Provider
/login pi-auto-company → Pi 原生认证
/models → 刷新并发现模型
```

API Key 使用 Pi 原生认证存储；普通配置只保存 endpoint、API 类型和用户模型覆盖。

## 模型元数据优先级

```text
用户覆盖 > API 返回 > 插件推断 > 默认值
```

`/models` 第一阶段不修改元数据，后续只允许编辑本插件拥有的模型。

## 刷新策略

模型目录走 Pi 的动态 Provider 协议，分两种时机：

```text
启动（缓存优先，allowNetwork=false）
  → 从 Pi 持久化的目录恢复模型，不发网络请求

按需刷新（/models 按 R，allowNetwork=true）
  → 请求上游 /models，成功则发布并持久化
```

规则：

- 刷新失败只上报错误，不清空已有模型。
- 未登录时静默跳过，不报错。
- `--offline` 下不发任何请求。
- 发现成功后通过 `context.publish({ persist })` 持久化，避免每次启动都依赖网络。

## 扩展加载约束

只使用 Pi 为扩展提供的裸模块别名：

```text
@earendil-works/pi-coding-agent
@earendil-works/pi-ai
@earendil-works/pi-tui
```

不要 import `@earendil-works/pi-ai/api/*` 这类子路径，也不要用 `createProvider()`。
安装后的插件目录没有 `node_modules`，Pi 只别名固定几个裸导入，
子路径会导致 `Cannot find module` 而让整个扩展加载失败。
注册 Provider 统一使用配置形式：`pi.registerProvider(id, config)`，
由 Pi 自己解析 `api` 对应的流式实现。

## 分阶段实现

1. 统一只读目录、搜索、筛选、详情和切换（已完成）
2. 标准 Provider 添加、动态发现和刷新（已完成基础版本）
3. Provider 编辑/删除、自定义 Header 和认证状态
4. 自定义模型和元数据覆盖
5. 导入、克隆、禁用和批量操作
6. 健康检查、能力筛选和批量操作
