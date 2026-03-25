# MCP V1 Design

## Goal

为桌面装配体查看软件提供一个 MCP 服务，让 VLM 可以通过标准化工具理解当前装配体状态，并执行轻量交互。

首版目标：

- 获取当前装配体摘要
- 获取装配树与零件信息
- 获取颜色映射
- 获取当前视图截图与零件 ID mask
- 获取当前选择状态
- 控制隔离与剖切
- 执行距离 / 角度测量

## Recommended Architecture

采用三层结构：

1. `Electron Main` 作为 MCP tool core 编排层
2. `Renderer` 作为截图与当前视图状态提供者
3. `OCCT / Project Service` 作为装配与几何数据源

推荐 Transport：

- 主线路：`Streamable HTTP`
- 兼容线路：`stdio`

推荐原因：

- 你的 VLM 调用不仅要拿结构化 JSON，还要拿图片与当前 UI 状态
- 这些能力天然和运行中的 Electron 进程耦合
- HTTP 更适合本地多客户端接入、调试和资源拉取
- `stdio` 可以作为 Claude Desktop / 本地代理兼容层

MCP 口径参考：

- Tools: https://modelcontextprotocol.io/docs/concepts/tools
- Resources: https://modelcontextprotocol.io/docs/concepts/resources
- Transports: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

## Runtime Roles

### 1. Electron Main

职责：

- 挂载 MCP server
- 管理会话与当前活动项目
- 调用 `project-service.js`
- 调用 `occt-sidecar.js`
- 向 renderer 发起截图 / 当前视图状态请求

### 2. Renderer

职责：

- 输出当前视图截图
- 输出零件 ID mask 图
- 输出当前 camera / selection / section / isolation 状态

### 3. Data Layer

职责：

- 提供当前项目 manifest
- 提供 assembly tree / mesh / face / color mapping
- 执行测量、剖切、显隐控制

## V1 Tool List

建议使用点式命名，保持稳定、可搜索、易审计。

### Read-only Tools

#### `assembly.get_current_summary`

用途：

- 返回当前活动装配体的摘要信息，适合作为 VLM 的第一跳工具

输入：

- 无

输出：

- `projectId`
- `projectName`
- `modelName`
- `status`
- `partCount`
- `assemblyCount`
- `faceCount`
- `solidCount`
- `geometryMode`
- `parserMode`
- `selection`
- `section`

#### `assembly.get_tree`

用途：

- 返回装配树，用于模型理解层级关系

输入：

- `projectId?`
- `maxDepth?`
- `includeMeshRefs?`
- `includeHidden?`

输出：

- 根节点
- 每个节点的 `id / name / kind / children / meshRefs / bbox / topology`

#### `assembly.get_part`

用途：

- 返回单个零件或装配节点的详细信息

输入：

- `projectId?`
- `partId`

输出：

- 零件基础属性
- bbox
- topology
- meshRefs
- 可选 face summary

#### `assembly.get_color_map`

用途：

- 返回当前装配体的颜色映射，供 VLM 将截图中的颜色区域映射到零件

输入：

- `projectId?`
- `mode`: `display | id-mask`

输出：

- `entries[]`
- 每项包含 `colorHex / nodeId / partId / name`

#### `assembly.get_selection`

用途：

- 返回当前工作台选中状态

输入：

- 无

输出：

- 当前选中节点
- faceId
- 命中点
- 法向
- 选择类型

#### `assembly.capture_view`

用途：

- 返回当前视图截图

输入：

- `projectId?`
- `width?`
- `height?`
- `fit?`
- `background?`

输出：

- `resourceUri`
- `mimeType`
- `width`
- `height`
- `sha256?`

#### `assembly.capture_part_mask`

用途：

- 返回按唯一颜色编码的零件 mask 图

输入：

- `projectId?`
- `width?`
- `height?`
- `fit?`

输出：

- `resourceUri`
- `mimeType`
- `width`
- `height`
- `mapResourceUri`

### Interaction Tools

#### `assembly.isolate_parts`

输入：

- `projectId?`
- `partIds[]`

输出：

- 当前隔离后的状态摘要

#### `assembly.clear_isolation`

输入：

- `projectId?`

输出：

- 当前显示状态摘要

#### `assembly.set_section_plane`

输入：

- `projectId?`
- `axis`: `x | y | z`
- `offset`
- `enabled?`

输出：

- 当前剖切平面状态

#### `assembly.clear_section_plane`

输入：

- `projectId?`

输出：

- 当前剖切状态

### Analysis Tools

#### `assembly.measure_distance`

输入：

- `projectId?`
- `from`
- `to`

其中 `from/to` 支持：

- `point`
- `nodeId`
- `faceId`

输出：

- 距离值
- 单位
- 使用的锚点坐标

#### `assembly.measure_angle`

输入：

- `projectId?`
- `faceAId`
- `faceBId`

输出：

- 夹角值
- 法向

## Resource URI Design

建议使用自定义 `assembly://` scheme。

### Session-scoped Resources

- `assembly://session/current/manifest`
- `assembly://session/current/tree`
- `assembly://session/current/color-map/display`
- `assembly://session/current/color-map/id-mask`
- `assembly://session/current/selection`
- `assembly://session/current/section`
- `assembly://session/current/view/beauty.png`
- `assembly://session/current/view/id-mask.png`
- `assembly://session/current/view/state.json`

### Project-scoped Resources

- `assembly://project/{projectId}/manifest`
- `assembly://project/{projectId}/tree`
- `assembly://project/{projectId}/mesh-summary`
- `assembly://project/{projectId}/part/{partId}`
- `assembly://project/{projectId}/face/{faceId}`
- `assembly://project/{projectId}/capture/beauty.png`
- `assembly://project/{projectId}/capture/id-mask.png`
- `assembly://project/{projectId}/color-map/display`
- `assembly://project/{projectId}/color-map/id-mask`

### Recommended Resource Semantics

- 图片资源统一用 `mimeType: image/png`
- 结构资源统一用 `mimeType: application/json`
- 大图不要默认内嵌到 tool 结果里，优先返回 `resource_link`
- `capture_*` tools 默认返回 `resource_link`

## Context Package for VLM

建议 VLM 首选消费以下组合：

1. `assembly.get_current_summary`
2. `assembly.capture_view`
3. `assembly.capture_part_mask`
4. `assembly.get_color_map`
5. `assembly.get_tree`

这样模型拿到：

- 一张真实渲染图
- 一张 ID mask 图
- 一份颜色到零件的映射
- 一份装配树

这是“看懂当前装配体”的最小闭环。

## JSON Schema Bundle

配套 schema 文件：

- [mcp-v1-schemas.json](/d:/0Learn/myself/vibe-coding/test-codex/mcp-v1-schemas.json)

内容包括：

- 公共类型
- 工具输入 schema
- 工具输出 schema

建议服务启动时直接从这个 bundle 构造 MCP tool definitions。

## Suggested Code Structure

```text
mcp/
  core/
    runtime.js
    session-state.js
    tool-registry.js
    resource-registry.js
    schema-loader.js
  server/
    http-server.js
    stdio-server.js
    auth.js
    origin-check.js
  bridges/
    electron-main-adapter.js
    renderer-capture-adapter.js
    project-service-adapter.js
    occt-adapter.js
  tools/
    get-current-summary.js
    get-tree.js
    get-part.js
    get-color-map.js
    get-selection.js
    capture-view.js
    capture-part-mask.js
    isolate-parts.js
    clear-isolation.js
    set-section-plane.js
    clear-section-plane.js
    measure-distance.js
    measure-angle.js
  resources/
    manifest.js
    tree.js
    color-map.js
    selection.js
    section.js
    capture-view.js
  schemas/
    mcp-v1-schemas.json
```

如果你不想一次拆太细，首版也可以先收敛成：

```text
mcp/
  runtime.js
  http-server.js
  stdio-server.js
  tools.js
  resources.js
  schemas.js
```

## First Implementation Order

### Phase 1

- `assembly.get_current_summary`
- `assembly.get_tree`
- `assembly.get_color_map`
- `assembly.capture_view`
- `assembly.capture_part_mask`

### Phase 2

- `assembly.get_selection`
- `assembly.isolate_parts`
- `assembly.clear_isolation`
- `assembly.set_section_plane`
- `assembly.clear_section_plane`

### Phase 3

- `assembly.measure_distance`
- `assembly.measure_angle`

## Security Notes

对本地 HTTP MCP 服务建议：

- 只绑定 `127.0.0.1`
- 校验 `Origin`
- 每次启动生成 session token
- 对会改变显示状态的 tools 增加显式 allowlist
- 工具调用在 UI 中留下可见痕迹

## Recommended V1 Decision

这版建议你就这样定：

- 主 Transport：`Streamable HTTP`
- 兼容 Transport：`stdio`
- Tool 以动态动作和轻量查询为主
- Resource 负责大 JSON、截图和 mask
- 当前软件中的 Electron Main 作为 MCP 编排核心

