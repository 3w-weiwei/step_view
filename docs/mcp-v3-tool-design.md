# MCP V3 精简工具设计文档

## 1. 设计目标

本文定义面向 VLM 智能体的 MCP 精简工具集。

目标不是把所有内部功能都暴露成 MCP，而是只提供智能体真正需要的高层能力：

- 获取模型上下文
- 获取候选关系
- 获取视觉证据包
- 验证 VLM 假设

本文默认输入模型为 `STEP/TSEP` 装配模型。

## 2. 设计原则

### 2.1 对外少而高层

不再把大量细粒度 viewer 操作和调试工具直接暴露为 MCP。

### 2.2 软件负责候选与验证

软件输出：

- 几何事实
- 结构化候选
- 视觉证据
- 验证结果

### 2.3 VLM 负责经验判断与解释

VLM 输出：

- 连接关系判断
- 子装配判断
- 基座判断
- 夹持判断
- 序列建议

### 2.4 所有视觉证据都必须可回查

图片必须配套：

- color map
- object id / face id
- capture metadata

### 2.5 优先围绕 feature group，而不是单个 face

对外工具的语义对象应优先是：

- feature group
- relation candidate
- grasp candidate

而不是 `face pair`。

## 3. 对外最小工具集

建议对外只保留以下 4 个工具。

## 4. 工具一：`assembly.get_model_context`

### 4.1 作用

提供当前模型的结构化上下文，作为智能体分析的入口。

### 4.2 输入

```json
{
  "projectId": "optional-uuid",
  "includeFaces": true,
  "includeColorMaps": true,
  "maxFaceCountPerPart": 256
}
```

### 4.3 输出

```json
{
  "projectId": "uuid",
  "projectName": "demo-assembly",
  "assembly": {
    "rootId": "root",
    "partCount": 24,
    "faceCount": 1320,
    "bounds": {
      "center": { "x": 0, "y": 0, "z": 0 },
      "size": { "x": 100, "y": 80, "z": 60 }
    }
  },
  "tree": {
    "id": "root",
    "name": "Assembly",
    "children": []
  },
  "parts": [
    {
      "partId": "part-1",
      "name": "Bracket",
      "bbox": {},
      "center": {},
      "size": {},
      "tags": ["structure_like"],
      "faces": [
        {
          "faceId": "face-1",
          "name": "Face 1",
          "geometry": {
            "type": "plane"
          },
          "center": {},
          "normal": {},
          "area": 123.4
        }
      ]
    }
  ],
  "colorMaps": {
    "display": [],
    "partMask": [],
    "faceMask": []
  }
}
```

### 4.4 用途

- 给 VLM 提供整体装配上下文
- 给候选分析提供 part/face 基础信息
- 给后续视觉证据回查提供对象索引

## 5. 工具二：`assembly.get_relation_candidates`

### 5.1 作用

提供候选关系，而不是最终结论。

该工具应负责召回：

- part-part relation candidates
- feature-group candidates
- base candidates
- subassembly candidates
- grasp candidates

### 5.2 输入

```json
{
  "projectId": "optional-uuid",
  "partIds": ["optional-part-id"],
  "topK": 32,
  "includeBaseCandidates": true,
  "includeSubassemblyCandidates": true,
  "includeGraspCandidates": true
}
```

### 5.3 输出

```json
{
  "projectId": "uuid",
  "relationCandidates": [
    {
      "candidateId": "rel-1",
      "partAId": "part-1",
      "partBId": "part-2",
      "featureGroupA": {
        "featureId": "fg-a-1",
        "kind": "hole_group",
        "faceIds": ["f1", "f2", "f3"]
      },
      "featureGroupB": {
        "featureId": "fg-b-1",
        "kind": "shaft_group",
        "faceIds": ["f4", "f5", "f6"]
      },
      "relationType": "insertable_coaxial_candidate",
      "sharedAxis": {
        "origin": {},
        "direction": {}
      },
      "ruleEvidence": [
        "coaxial_like",
        "radius_match_like",
        "support_face_present"
      ],
      "score": 0.84
    }
  ],
  "baseCandidates": [
    {
      "partId": "part-8",
      "score": 0.73,
      "reasons": ["large_volume", "high_connectivity", "spatially_central"]
    }
  ],
  "subassemblyCandidates": [
    {
      "candidateId": "subasm-1",
      "partIds": ["part-3", "part-4", "part-5"],
      "score": 0.77,
      "reasons": ["dense_internal_relations", "weak_external_relations"]
    }
  ],
  "graspCandidates": [
    {
      "candidateId": "grasp-1",
      "partId": "part-2",
      "featureGroup": {
        "featureId": "grip-band-1",
        "kind": "cylindrical_grip_band",
        "faceIds": ["f20", "f21"]
      },
      "recommendedGripperTypes": ["parallel_jaw", "soft_jaw"],
      "approachDirections": [
        { "x": 1, "y": 0, "z": 0 }
      ],
      "avoidFaceIds": ["f30", "f31"],
      "score": 0.68
    }
  ]
}
```

### 5.4 用途

- 让 VLM 基于候选做判断，而不是凭空猜测
- 把复杂装配问题转化为可排序的候选空间

## 6. 工具三：`assembly.capture_evidence_bundle`

### 6.1 作用

针对某个候选或某组零件，输出一组稳定、可回查、适合 VLM 分析的视觉证据。

### 6.2 输入

```json
{
  "projectId": "optional-uuid",
  "candidateId": "optional-candidate-id",
  "partIds": ["optional-part-id"],
  "focusFaceIds": ["optional-face-id"],
  "includeGlobalViews": true,
  "includeLocalViews": true,
  "includeSectionViews": true,
  "includePartMask": true,
  "includeFaceMask": true,
  "includeOverlay": true,
  "includeTransparentContext": true,
  "width": 1024,
  "height": 768
}
```

### 6.3 输出

```json
{
  "projectId": "uuid",
  "bundleId": "bundle-1",
  "target": {
    "candidateId": "rel-1",
    "partIds": ["part-1", "part-2"],
    "focusFaceIds": ["f1", "f2", "f4", "f5"]
  },
  "images": {
    "globalBeautyViews": [
      { "preset": "front", "resourceUri": "assembly://..." },
      { "preset": "top", "resourceUri": "assembly://..." },
      { "preset": "iso", "resourceUri": "assembly://..." }
    ],
    "globalPartMaskViews": [
      { "preset": "front", "resourceUri": "assembly://..." }
    ],
    "localOverlayViews": [
      { "preset": "focus", "resourceUri": "assembly://..." }
    ],
    "localFaceMaskViews": [
      { "preset": "focus", "resourceUri": "assembly://..." }
    ],
    "sectionViews": [
      { "axis": "x", "offset": 12.5, "resourceUri": "assembly://..." }
    ]
  },
  "colorMaps": {
    "partMask": [],
    "faceMask": []
  },
  "metadata": {
    "isolationEnabled": true,
    "sectionEnabled": true,
    "transparentContext": true,
    "width": 1024,
    "height": 768
  }
}
```

### 6.4 证据包内容建议

建议按如下层次组织：

- `globalBeautyViews`
- `globalPartMaskViews`
- `localOverlayViews`
- `localFaceMaskViews`
- `sectionViews`
- `optionalTransparentContextViews`

### 6.5 重要约束

1. 所有图片都必须能回查到 `partId` 或 `faceId`
2. 遮挡问题优先通过隔离和剖切解决
3. 透明图只做辅助，不做唯一证据
4. 爆炸图如果存在，只做辅助视图

## 7. 工具四：`assembly.validate_hypothesis`

### 7.1 作用

验证 VLM 提出的假设，而不是替 VLM 再猜一次。

它是闭环中最重要的“验证器”。

### 7.2 支持验证的假设类型

- 连接关系
- 子装配关系
- 基座选择
- 夹持方案
- 单步装配动作
- 局部序列关系

### 7.3 输入

```json
{
  "projectId": "optional-uuid",
  "hypothesis": {
    "type": "assembly_step",
    "basePartId": "part-1",
    "movingPartId": "part-2",
    "relationCandidateId": "rel-1",
    "featureGroupAId": "fg-a-1",
    "featureGroupBId": "fg-b-1",
    "graspCandidateId": "grasp-1",
    "insertionDirection": { "x": 0, "y": 0, "z": 1 }
  },
  "checks": {
    "relationConsistency": true,
    "interference": true,
    "insertionFeasibility": true,
    "graspClearance": true,
    "baseStability": true
  }
}
```

### 7.4 输出

```json
{
  "projectId": "uuid",
  "result": {
    "valid": false,
    "status": "needs_revision",
    "score": 0.42,
    "summary": "Insertion direction is plausible, but grasp clearance is insufficient.",
    "checks": {
      "relationConsistency": {
        "ok": true,
        "score": 0.82,
        "reasons": ["coaxial_like", "support_face_match_like"]
      },
      "interference": {
        "ok": true,
        "score": 0.71,
        "collisionCount": 0
      },
      "insertionFeasibility": {
        "ok": true,
        "score": 0.64,
        "travelDistance": 18.3
      },
      "graspClearance": {
        "ok": false,
        "score": 0.18,
        "reasons": ["outer_shell_blocks_parallel_jaw_access"]
      },
      "baseStability": {
        "ok": true,
        "score": 0.69,
        "reasons": ["large_support_face", "low_center_shift"]
      }
    },
    "risks": [
      "thread_region_should_be_avoided",
      "gripper_access_path_is_uncertain"
    ],
    "nextEvidenceNeeded": [
      "section_view_y",
      "local_grasp_overlay"
    ]
  }
}
```

### 7.5 用途

- 防止 VLM 输出“看起来像对，但几何上不成立”的结论
- 帮助智能体形成“提出假设 -> 验证 -> 修正”的闭环

## 8. 证据包标准建议

为了让智能体能稳定工作，`capture_evidence_bundle` 建议遵守以下标准。

### 8.1 必选证据

- global beauty view
- local overlay view
- local face-mask
- color map

### 8.2 按需证据

- part-mask
- section view
- transparent context
- exploded helper view
- single-part grasp view

### 8.3 视图命名建议

- `global_front`
- `global_top`
- `global_iso`
- `local_overlay_focus`
- `local_face_mask_focus`
- `section_x_mid`
- `grasp_iso_part_only`

### 8.4 metadata 建议

每张图建议附带：

- `cameraPreset`
- `cameraPosition`
- `target`
- `isolationEnabled`
- `sectionState`
- `transparentContext`
- `partIds`
- `focusFaceIds`

## 9. 当前内部能力与对外暴露的边界

以下能力建议保留在内部，不再直接作为高层 MCP 工具暴露：

- 单独的 `capture_view`
- 单独的 `capture_face_mask`
- 单独的 `capture_part_mask`
- 单独的 `get_relative_transform`
- 单独的 `check_interference`
- viewer 交互类工具
- isolate / clear-isolation
- set-section / clear-section

这些能力仍然有价值，但更适合作为高层工具的内部实现细节。

## 10. 当前版本不建议对外直接暴露的内容

### 10.1 单纯 viewer 操作

例如：

- 选择对象
- 隔离对象
- 剖切开关
- 透明度切换

这些更适合在 UI 内部或工具内部调用。

### 10.2 过细的 face pair 接口

如果继续暴露大量 `face pair` 接口，会把智能体的注意力锁死在错误层级上。

### 10.3 过于“结论导向”的规则输出

例如直接输出“最终基座”或“最终序列”，会让智能体失去自主推理空间，也容易被旧规则误导。

## 11. 推荐的智能体调用流程

建议智能体按如下顺序调用：

1. `assembly.get_model_context`
2. `assembly.get_relation_candidates`
3. 对高价值候选调用 `assembly.capture_evidence_bundle`
4. 基于证据做 VLM 推理
5. 调用 `assembly.validate_hypothesis`
6. 若验证失败，则回到第 3 步请求补充证据
7. 输出推荐方案、备选方案和风险说明

## 12. 后续扩展建议

后续如果需要增强，可在不破坏最小工具集的前提下扩展：

- `feature-group` 专用 schema
- `analysis geometry` 简化表达
- `thread_region` / `avoid_grip_region` 标注
- `subassembly_state` 表达
- `sequence_state_transition` 表达
- `fixture_primitive_library` 表达

## 13. 一句话总结

MCP V3 的核心设计原则是：

`对外只暴露上下文、候选、证据、验证四类高层能力，把 viewer 细节和规则细节收回到内部实现。`
