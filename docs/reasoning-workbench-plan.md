# 装配推理工作区设计方案

## 目标

在现有 `STEP Workbench` 中新增一个独立的 `装配推理` 工作区，用于承接 MCP V2 推理能力。该工作区需要满足以下目标：

1. 将 V2 推理内容从当前模型工作台操作中拆分出来，形成单独导航。
2. 让用户按“发现关系 -> 查看计划 -> 查看步骤 -> 可视化验证”的路径理解装配过程。
3. 复用现有 `workbench`、`viewer`、`project-service` 和 `analysis-v2`，避免引入第二套页面或协议客户端。
4. 在界面内直接展示装配候选、装配顺序、步骤说明、插入方向、干涉结果和步骤预览，不再依赖 Inspector 才能查看。

## 设计原则

1. 不把 MCP tool 名称直接暴露成主导航。
2. 用户看到的是“任务流”，不是“协议接口列表”。
3. 推理结果与 3D viewer 同屏联动，减少上下文跳转。
4. 允许逐步增强，先有清晰结构，再补更强可视化。

## 信息架构

### 一级模式

工作台顶部新增模式切换：

- `模型工作台`
- `装配推理`

两者共用同一个项目、同一个 viewer、同一个 route。

### 二级导航

当模式为 `装配推理` 时，左侧导航切换为：

1. `推理总览`
   - 展示项目状态
   - 展示最近一次分析摘要
   - 提供“刷新分析”入口
2. `约束发现`
   - 基准件候选
   - 配合候选
   - 插入方向候选
3. `姿态校验`
   - 相对位姿
   - 干涉检查
4. `装配计划`
   - 候选序列
   - precedence graph
5. `步骤讲解`
   - 步骤摘要
   - 证据
   - before/after 预览

## 数据模型

在现有 `workbench` 状态下新增：

```js
{
  workspaceMode: "model" | "reasoning",
  reasoningPanel: "summary" | "constraints" | "transform" | "plan" | "steps",
  reasoning: {
    status: "idle" | "loading" | "ready" | "error",
    error: "",
    refreshedAt: "",
    data: {
      basePartCandidates: [],
      matingCandidates: [],
      plan: null,
      insertionCandidatesByPart: {},
      relativeTransform: null,
      interference: null,
      stepExplanation: null,
      stepPreview: null
    },
    selection: {
      basePartId: null,
      assemblingPartId: null,
      sequenceId: null,
      stepIndex: null
    },
    overlay: {
      focusPartIds: [],
      basePartId: null,
      assemblingPartId: null,
      baseFaceIds: [],
      assemblingFaceIds: [],
      insertionAxis: null,
      interferenceBoxes: []
    }
  }
}
```

## 数据流

### 主进程

新增一组 IPC handler，由 renderer 直接调用主进程获取推理结果：

- `reasoning:summary`
- `reasoning:constraints`
- `reasoning:transform`
- `reasoning:plan`
- `reasoning:step`
- `reasoning:step-preview`

这些 handler 不通过 HTTP MCP 自己回调自己，而是直接复用 `mcp/analysis-v2.js` 和已有项目数据。

### Renderer

Renderer 只消费结构化结果，不处理协议细节：

1. 进入 `装配推理` 模式时自动请求总览与计划。
2. 用户选择具体零件或步骤时，再按需请求位姿、插入候选、干涉检查和步骤预览。
3. 每次选择都同步刷新 viewer overlay。

## 视觉与布局

### 页面结构

沿用现有 `workbench-body` 三栏布局：

- 左栏：模式相关导航
- 中栏：面板内容
- 右栏：3D viewer

### 推理模式中的 viewer 叠加

推理模式启用以下联动视觉：

1. `base part` 高亮为冷蓝色
2. `assembling part` 高亮为琥珀色
3. `mating faces` 以更强面高亮显示
4. `insertion axis` 以箭头显示
5. `interference` 以红色盒或边框显示
6. `step preview` 在侧栏中显示 before / after 对比图

### 内容卡片

#### 推理总览

- 当前项目
- 基准件候选数量
- 配合候选数量
- 候选序列数量
- 当前选中序列 / 步骤

#### 约束发现

- 基准件候选列表
- 配合候选列表
- 选中零件的插入方向列表

#### 姿态校验

- 相对位姿卡片
- 干涉检查结果
- 受影响零件列表

#### 装配计划

- sequence list
- sequence confidence
- step list
- precedence edges 摘要

#### 步骤讲解

- 标题
- 摘要
- base / assembling part
- mating faces
- insertion axis
- confidence
- evidence
- before/after 预览图

## 交互规则

1. 切换到 `装配推理` 时，不改变用户当前模型选择与相机。
2. 在推理面板中点击候选项时，viewer 自动切换到对应推理 overlay。
3. 点击步骤时：
   - 自动设置 `sequenceId`
   - 自动设置 `stepIndex`
   - 自动刷新 explanation
   - 自动刷新 preview
4. 返回 `模型工作台` 时，清空推理 overlay，但保留推理缓存。
5. 推理失败时，保留上一次成功结果，并显示错误提示。

## 实现分期

### Phase 1：结构落地

- 增加 `workspaceMode`
- 拆分模型导航与推理导航
- 增加推理状态容器
- 增加推理面板骨架

### Phase 2：数据接入

- 在 `main.js` 增加 reasoning IPC
- 在 `preload.js` 暴露 reasoning API
- 在 `app.js` 中实现推理数据加载与缓存

### Phase 3：viewer 联动

- 给 `mesh-viewer.js` 增加 reasoning overlay 状态
- 实现重点零件高亮
- 实现插入方向箭头
- 实现干涉框可视化

### Phase 4：步骤体验完善

- 接入步骤详情
- 接入步骤预览
- 增加交互反馈、空状态和错误状态

## 主要改动文件

- `docs/reasoning-workbench-plan.md`
- `main.js`
- `preload.js`
- `app.js`
- `mesh-viewer.js`
- `ui.css`

## 验收标准

1. 用户可以在工作台中看到独立的 `装配推理` 模式切换。
2. 推理模式下有独立导航，而不是与显示/剖切/测量混在一起。
3. 用户可以查看基准件、配合候选、装配顺序和步骤详情。
4. 用户点击推理项后，viewer 会同步高亮相关零件并显示插入方向或干涉范围。
5. 用户可以在界面内直接看到步骤预览，不需要手动读 `resourceUri`。
