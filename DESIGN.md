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

刷新成功后更新运行时目录；刷新失败时保留旧模型并提示 Provider 错误。刷新动作通过 Pi 的 `ModelRegistry.refresh()` 触发，不主动发送模型请求。

## 分阶段实现

1. 统一只读目录、搜索、筛选、详情和切换（已完成）
2. 标准 Provider 添加、动态发现和刷新（已完成基础版本）
3. Provider 编辑/删除、自定义 Header 和认证状态
4. 自定义模型和元数据覆盖
5. 导入、克隆、禁用和批量操作
6. 健康检查、能力筛选和批量操作
