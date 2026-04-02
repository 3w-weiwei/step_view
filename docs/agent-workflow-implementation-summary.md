# 智能体流程实现总结（当前项目）

本文基于当前代码实现，梳理项目中“智能体流程”的实际工作链路，便于后续维护和迭代。

---

## 1. 总览：两条智能体相关主链路

当前项目里与智能体相关的流程可以分为两条：

1. **内置 VLM 智能体流程（主流程）**
  - 用户在工作台输入任务指令
  - 主进程驱动多轮“工具调用 + 视觉观察 + 模型决策”闭环
  - 最终回写时间线、建议、焦点对象并联动 3D Viewer
2. **MCP 对外工具流程（外部接入）**
  - 通过 HTTP MCP 服务暴露 `assembly.`* 工具
  - 外部智能体可以调用模型上下文、候选关系、证据包与假设验证能力

---

## 2. 前端入口与状态容器（Renderer）

前端核心在 `app.js`，关键状态位于 `state.workbench.reasoning.data.agentAnalysis`：

- 运行状态：`idle | running | ready | error`
- 过程日志：`processLog`
- 工具阶段：`toolStages`
- 分析时间线：`timeline`
- 最终结论：`summary / confidence / suggestions`
- 统计与证据：`usage / evidence / contextStats`

界面上有两个相关入口：

- **模型工作台 -> 智能体流程（agent 面板）**：用于发起 VLM 分析、查看工具调用过程。
- **装配推理工作区（reasoning 模式）**：用于查看约束、位姿、计划、步骤等结构化推理结果。

此外，Renderer 会监听主进程进度事件：

- `onVlmAgentProgress`：持续更新“运行中/完成”状态和过程数据。

---

## 3. VLM 智能体主流程（主进程）

主入口在 `main.js` 的 IPC：

- `ipcMain.handle("vlm:analyze", ...)` -> `runVlmAgentAnalysis(payload)`

### 3.1 启动前准备

`runVlmAgentAnalysis` 主要先做：

1. 校验项目可推理（项目存在、状态 ready、装配数据可用）
2. 解析 VLM 配置（API Key、Base URL、Model、超时）
3. 构造轻量上下文：
  - `buildModelContext(...)`
  - `buildAnalysisCandidates(...)`
4. 记录会话日志（jsonl）
5. 确保 renderer 已进入对应项目工作台
6. 抓取初始观察图（默认多视角）

### 3.2 多轮 Tool-Loop

系统提示词中定义了工具调用协议（mode=tool/final），智能体每轮只能调用一个工具。

主循环逻辑：

1. 调用 VLM（`/chat/completions` + `response_format=json_object`）
2. 解析智能体决策 JSON（tool 或 final）
3. 若 `mode=tool`：
  - 校验工具名与参数（白名单 + 参数清洗）
  - 执行工具（分析类或显示控制类）
  - 获取新的观察结果（截图或结构化结果）
  - 将结果作为下一轮输入继续推理
4. 若 `mode=final`：
  - 归一化输出（summary/confidence/focus/timeline/suggestions）
  - 结束流程并返回结果

若超过最大步数仍未 final，会触发强制收敛请求。

### 3.3 工具执行层（executeAgentTool）

工具分两类：

1. **分析类工具（不改显示）**
  - `get_model_context`
  - `get_relation_candidates`
2. **显示/交互类工具（驱动 Viewer）**
  - `focus_parts`
  - `hide_parts`
  - `set_part_opacity`
  - `set_face_map`
  - `move_parts`
  - `reset_display`
  - `reset_translation`
  - `capture_views`

显示类工具通过主进程桥接到 Renderer 执行（见第 4 节）。

---

## 4. 主进程与 Renderer 的桥接机制

桥接位于 `mcp/bridge.js` + `preload.js` + `app.js`：

1. 主进程发请求：
  - `requestRendererCommand(...)`
  - `requestRendererCapture(...)`
2. Renderer 注册处理器：
  - `registerMcpCommandHandler`
  - `registerMcpCaptureHandler`
3. Renderer 执行后回传：
  - `mcp:command:response`
  - `mcp:capture:response`

在 `app.js` 中，`executeMcpCommand(...)` 负责把“agent-* action”映射到实际 viewer 状态变更与截图行为。

---

## 5. 结构化推理链路（Reasoning IPC）

除了 VLM Tool-Loop，项目还实现了一套结构化推理接口（`reasoning-service.js`）：

- `reasoning:summary`
- `reasoning:constraints`
- `reasoning:transform`
- `reasoning:plan`
- `reasoning:step`
- `reasoning:step-preview`

其能力由 `mcp/analysis-v2.js` 提供底层计算（候选、位姿、插入方向、干涉、序列计划等），前端在“装配推理”工作区展示并与 overlay 联动。

这条链路的定位是：

- 提供稳定结构化结果
- 支撑 Viewer 可视化高亮（base/assembling/mating faces/insertion/interference）
- 为 VLM 智能体提供先验快照（`reasoningSnapshot`）

---

## 6. MCP 对外能力（HTTP 服务）

项目启动时会拉起 MCP HTTP 服务（`mcp/http-server.js`），核心 runtime 在 `mcp/runtime.js`。

当前对外主工具：

- `assembly.get_model_context`
- `assembly.get_relation_candidates`
- `assembly.capture_evidence_bundle`
- `assembly.validate_hypothesis`

这让外部智能体也能复用本项目的数据与验证能力，而不必直接操作 UI。

---

## 7. 数据闭环（项目当前实现思路）

当前智能体闭环已经落地为：

1. **上下文检索**：结构化模型与候选召回
2. **显示控制与观测**：多轮 viewer 操作 + 截图
3. **模型决策**：VLM 基于文本与图像持续迭代
4. **最终归一化输出**：summary / timeline / focus / suggestions
5. **界面联动呈现**：过程日志、工具阶段、焦点高亮、步骤证据

可概括为：

**“结构化候选 + 视觉观测 + 多轮工具调用 + 最终结论回写”**

---

## 8. 关键实现文件索引

- 前端工作台与智能体 UI：`app.js`
- 主进程编排与 VLM tool-loop：`main.js`
- preload IPC 暴露：`preload.js`
- Renderer/主进程桥：`mcp/bridge.js`
- 推理服务聚合：`mcp/reasoning-service.js`
- 几何/候选/计划算法：`mcp/analysis-v2.js`
- V3 上下文与候选封装：`mcp/analysis-v3.js`
- MCP runtime 工具注册：`mcp/runtime.js`
- MCP HTTP 服务：`mcp/http-server.js`

---

## 9. 当前能力边界（按现实现）

已实现：

- VLM 多轮工具调用流程（含参数校验、错误回退、强制收敛）
- 显示控制工具与截图工具联动
- 结构化推理视图（约束/位姿/计划/步骤）
- MCP 对外工具服务

未看到明确实现（需要后续确认/扩展）：

- 真正物理级抓取可行性求解（当前更多是候选与启发式）
- 完整工艺规划执行器（当前是分析与建议导向）

---

## 10. 一句话结论

当前项目的“智能体流程”已经从单次问答升级为**可执行的 Agent Tool-Loop**：

- 能调用显示控制工具改变场景
- 能抓图观察结果再继续推理
- 能输出可联动 UI 的阶段化装配结论
- 并通过 MCP 向外部智能体提供同样的分析能力

