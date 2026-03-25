# MCP V2 Design

## Objective

MCP V2 的目标是让模型不只“看到装配体”，还能够围绕当前 STEP 装配结果推理出：

- 基体件候选
- 候选配合关系
- 相对位姿变化
- 候选插入方向
- 候选装配顺序
- 单步装配解释
- 某一步装配前后对比图

## Core Principle

不要让 VLM 只靠截图猜装配关系。

V2 的核心是结构化装配推理工具：

1. `assembly.get_base_part_candidates`
2. `assembly.get_mating_candidates`
3. `assembly.get_relative_transform`
4. `assembly.get_insertion_candidates`
5. `assembly.check_interference`
6. `assembly.plan_sequence`
7. `assembly.explain_step`
8. `assembly.capture_step_preview`

## Runtime Architecture

```text
Electron Main
  -> project-service
  -> occt-sidecar
  -> mcp/runtime
       -> mcp/analysis-v2
       -> mcp/bridge
  -> renderer
```

职责：

- `project-service`
  - 项目与缓存读取
- `occt-sidecar`
  - 真实 mesh / face / bbox 数据
- `mcp/analysis-v2`
  - 启发式装配分析
- `mcp/runtime`
  - 将分析能力暴露成 MCP 工具和资源
- `renderer`
  - 当前视图、mask、交互状态、step preview 截图

## V2 Tool Set

### 1. `assembly.get_base_part_candidates`

返回最可能作为基体的零件候选。

### 2. `assembly.get_mating_candidates`

返回零件对之间的候选配合关系与候选配合面。

### 3. `assembly.get_relative_transform`

返回两个零件之间的相对位姿。

### 4. `assembly.get_insertion_candidates`

返回指定零件的候选插入方向。

### 5. `assembly.check_interference`

返回给定位姿下的代理干涉结果。

### 6. `assembly.plan_sequence`

返回候选装配顺序与 precedence graph。

### 7. `assembly.explain_step`

返回某一装配步骤的解释：

- 基准件
- 待装件
- 候选配合面
- 位姿变化
- 插入方向
- 证据

### 8. `assembly.capture_step_preview`

返回某一步的装配前后对比图。

当前实现：

- 临时隔离基准件与待装件
- 将待装件沿插入轴回退到 `before`
- 截取 `before / after`
- 合成为单张 comparison image

## V2 Resources

推荐模型优先消费这些资源：

- `assembly://session/current/base-part-candidates`
- `assembly://session/current/mating-candidates`
- `assembly://session/current/plan`
- `assembly://session/current/sequence/{sequenceId}/step/{stepIndex}`
- `assembly://session/current/sequence/{sequenceId}/step/{stepIndex}/preview.png`

含义：

- `base-part-candidates`
  - 基体候选列表
- `mating-candidates`
  - 候选配合关系
- `plan`
  - 候选装配序列与 precedence graph
- `step/{stepIndex}`
  - 某一步的可解释结构化说明
- `step/{stepIndex}/preview.png`
  - 某一步的前后对比图

## Current Method Boundaries

当前 V2 是启发式装配分析，不是严格 CAD 约束求解器。

优点：

- 能在现有 mesh / face / bbox 上快速落地
- 能给 VLM 提供结构化证据

局限：

- 平面关系仍然是主路径
- 干涉检测目前是 AABB 代理
- 位姿是启发式，不是严格约束求解真值
- `capture_step_preview` 当前基于平移回退，不是完整装配动画重演

## Stronger Geometry Constraints Added

这次增强已经补了两点：

1. face geometry classification
   - `plane`
   - `cylinder`
   - `unknown`

2. coaxial cylinder candidate
   - 在 `get_mating_candidates` 中加入圆柱同轴候选

这意味着当前配合候选不再只看平面，还开始识别圆柱类轴向关系。

## Suggested Code Structure

```text
mcp/
  bridge.js
  http-server.js
  stdio-server.js
  runtime.js
  analysis-v2.js
  MCP_V1_SPEC.md
  MCP_V2_SPEC.md
  mcp-v1-schemas.json
  mcp-v2-schemas.json
```

## Next Recommended Step

V3 推荐继续补：

- face type 扩展到 `cone`
- 孔轴 / 同轴 / 孔销关系
- `assembly.explain_plan`
- 更真实的 swept-volume 干涉检测
- step preview 的方向箭头和高亮配合面覆盖层
