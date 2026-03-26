# 面级颜色映射 + VLM 装配分析扩展报告

## 结论

当前系统已经具备升级到“面级颜色映射 + VLM 分析”的基础，只是现有链路仍停留在：

1. 用 `analysis-v2.js` 做规则候选召回。
2. 用 `part-level id-mask` 做零件级颜色映射。
3. 用 `reasoning workspace` 展示规则推理结果。

真正缺失的是：

- 面级颜色映射与面级 mask
- 面级候选局部截图与 overlay
- VLM 候选重排与解释模块
- MCP 中对应的 face-level tool / resource

我的建议不是推翻现有规则推理，而是改成“两阶段分析”：

1. 规则引擎负责召回候选面
2. VLM 负责基于 face-mask + beauty 图 + 候选 overlay 做重排和解释

这样比纯规则更灵活，也比让 VLM 直接从原始截图猜装配关系更稳。

## 当前系统评估

### 已有能力

当前代码库已经有完整的面级拓扑元数据：

- `face.id`
- `face.name`
- `triangleFirst / triangleLast`
- `bounds / center / normal`
- `area / longestEdge`
- `geometry.type`
- `geometry.axisOrigin / axisDirection / radius`

关键实现：

- [occt-sidecar.js](/d:/0Learn/myself/vibe-coding/test-codex/occt-sidecar.js#L240)
- [occt-sidecar.js](/d:/0Learn/myself/vibe-coding/test-codex/occt-sidecar.js#L292)
- [occt-sidecar.js](/d:/0Learn/myself/vibe-coding/test-codex/occt-sidecar.js#L323)
- [occt-sidecar.js](/d:/0Learn/myself/vibe-coding/test-codex/occt-sidecar.js#L460)

viewer 已支持面级拾取和面级高亮：

- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L319)
- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L363)
- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L531)
- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L592)

当前 MCP 和截图链路已支持零件级颜色映射：

- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L666)
- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L840)
- [mcp/runtime.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/runtime.js#L119)
- [mcp/runtime.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/runtime.js#L397)

当前规则推理能力主要在：

- [mcp/analysis-v2.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/analysis-v2.js#L232)
- [mcp/analysis-v2.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/analysis-v2.js#L336)
- [mcp/analysis-v2.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/analysis-v2.js#L463)
- [mcp/analysis-v2.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/analysis-v2.js#L570)

### 当前瓶颈

#### 1. 颜色映射粒度太粗

现在颜色映射是 `part -> colorHex`，不是 `face -> colorHex`。

结果是：

- VLM 只能知道“哪个零件在这里”
- 不能稳定知道“这个零件上的哪个面在这里”
- 很难把截图区域反查到 `faceId`

#### 2. 截图语义不完整

当前只有：

- beauty 图
- part-level id-mask

缺少：

- face-level id-mask
- face-level color map
- 候选面局部 crop
- 候选面对 overlay 图

#### 3. 规则推理过于刚性

当前 `analysis-v2.js` 对配合面判断主要依赖：

- 法向夹角
- gap
- area ratio
- projected overlap
- 圆柱同轴性

这在简单场景有效，但在复杂真实模型中不够稳。

## 推荐目标架构

建议新增一条“面级视觉分析链”：

```text
OCCT face data
  -> face color encoding
  -> face-level mask capture
  -> candidate face overlay / crop
  -> VLM ranking + explanation
  -> MCP / reasoning workspace 展示
```

VLM 不直接替代规则引擎，而是做：

- 视觉定位
- 候选重排
- 配合面对解释
- 对规则结果纠偏

## 如何在现有模块中扩展

### 1. 扩展 `mesh-viewer.js`

这是最关键的改动点。

建议新增：

- `faceMaskColors: Map<faceId, colorHex>`
- `getColorMap("face-mask")`
- `capture("face-mask")`
- `captureFaceOverlay(faceIds)`
- `captureCandidatePairPreview(faceAId, faceBId)`

实现思路：

1. 参考当前 `nodeMaskColors` 机制，为每个 `brepFace.id` 分配唯一颜色。
2. 在 `buildMaterials()` 里保留 face material 粒度。
3. 在 `captureMaskFrame()` 中增加 face 模式：
   - 每个 face material 用唯一编码色输出
   - 关闭高光、透明和边线
   - 背景固定为黑色
4. 提供 `faceColorMap`，返回：
   - `faceId`
   - `meshId`
   - `nodeId`
   - `partId`
   - `partName`
   - `faceName`
   - `colorHex`

扩展点：

- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L108)
- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L363)
- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L666)
- [mesh-viewer.js](/d:/0Learn/myself/vibe-coding/test-codex/mesh-viewer.js#L840)

### 2. 扩展 `app.js`

在 renderer 与 MCP 状态发布中，把 face-level color map 一起带上。

当前 `buildMcpStatePayload()` 只有：

- `display`
- `id-mask`

建议扩展为：

```js
colorMaps: {
  display,
  "id-mask": ...,
  "face-mask": ...
}
```

扩展点：

- [app.js](/d:/0Learn/myself/vibe-coding/test-codex/app.js#L227)

同时建议在 reasoning workspace 中新增一个视觉证据区域，显示：

- face-mask 图
- 候选面 overlay 图
- face id / face name / part name

### 3. 扩展 `mcp/runtime.js`

当前 `buildColorMap(projectId, mode)` 和 `capture(projectId, mode)` 都偏零件级。

建议扩展：

- `mode = "face-mask"`
- face-level `resourceUri`
- face-level `color-map` resource

新增工具建议：

- `assembly.capture_face_mask`
- `assembly.get_face_color_map`
- `assembly.capture_candidate_overlay`

新增资源建议：

- `assembly://session/current/color-map/face-mask`
- `assembly://session/current/view/face-mask.png`
- `assembly://session/current/candidate-overlay/{candidateId}.png`

扩展点：

- [mcp/runtime.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/runtime.js#L119)
- [mcp/runtime.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/runtime.js#L139)
- [mcp/runtime.js](/d:/0Learn/myself/vibe-coding/test-codex/mcp/runtime.js#L658)

### 4. 保持 `analysis-v2.js` 做“候选召回”

我不建议把 VLM 逻辑直接写进 `analysis-v2.js`。

更合理的做法是：

- `analysis-v2.js` 继续负责几何规则候选召回
- 新增 `analysis-vlm.js` 做 VLM 重排与解释

也就是说，`analysis-v2.js` 的角色变成：

- 召回 topK 候选
- 给每个候选附带规则证据
- 输出面级结构化上下文

### 5. 新增 `mcp/analysis-vlm.js`

建议新增一个独立模块：

- `mcp/analysis-vlm.js`

职责：

1. 接收规则候选
2. 生成 VLM 输入包
3. 调用 VLM
4. 返回重排后的候选与解释

推荐输入：

```js
{
  projectId,
  candidatePairs: [...],
  beautyImage,
  faceMaskImage,
  candidateOverlayImage,
  faceColorMap,
  partTree,
  optionalRuleEvidence,
}
```

推荐输出：

```js
{
  rankedCandidates: [
    {
      faceAId,
      faceBId,
      vlmScore,
      finalScore,
      explanation,
      visualEvidence: []
    }
  ]
}
```

## 推荐分析流程

### Phase 1：先做 face-level 基础设施

先完成：

- face-level color map
- face-mask capture
- MCP 暴露

这是根基，不建议跳过。

### Phase 2：补候选视觉证据

再做：

- candidate overlay
- face crop
- isolated candidate preview

### Phase 3：引入 VLM 候选重排

建议只让 VLM 在规则召回的 topK 候选中重排，而不是直接从全局图像猜配合。

推荐融合方式：

```text
finalScore =
  ruleScore * 0.45 +
  geometryConsistency * 0.20 +
  vlmScore * 0.35
```

### Phase 4：把 VLM 输出接进 reasoning workspace

在 `步骤讲解` 或新的 `视觉证据` 面板中展示：

- beauty 图
- face-mask 图
- 候选面对 overlay
- VLM explanation
- VLM confidence

## 为什么这种扩展最适合当前代码库

因为你现在已经有：

- 面级拓扑元数据
- 面级拾取
- 面级高亮
- 零件级 mask
- MCP 资源链路
- reasoning workspace

所以这次扩展不需要推翻现有系统，只需要：

1. 把颜色映射从零件级扩到面级
2. 新增一个 VLM 分析模块
3. 让 MCP 和 reasoning workspace 消费这套新结果

## 风险与控制

### 风险 1：face 数量多，mask 图复杂

解决：

- mask 图给程序用，不给人直接读
- 配合 faceColorMap 反查 faceId
- 增加局部 crop，减少 VLM 处理范围

### 风险 2：VLM 幻觉

解决：

- 只在规则 topK 候选内重排
- 保留规则 hard filter
- 输出 `supported / rejected / unsure`

### 风险 3：性能开销增加

解决：

- face-mask 按需生成
- color map 做缓存
- overlay 图只对当前候选生成

## 最终建议

最推荐的落地路线是：

1. `mesh-viewer.js` 增加 `face-mask` 和 `faceColorMap`
2. `app.js` / `mcp/runtime.js` 把 face-level 资源暴露出来
3. 新增 `mcp/analysis-vlm.js`
4. 让 `analysis-v2.js` 负责候选召回，`analysis-vlm.js` 负责候选重排与解释
5. 在 reasoning workspace 中把“规则证据 + VLM 证据 + 面级高亮”统一展示

这是和你当前架构最兼容、风险最低、效果也最可控的方案。
