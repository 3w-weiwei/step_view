# MCP Testing Guide

## Scope

本文件用于测试当前软件内嵌的 MCP 服务，包括：

- Streamable HTTP MCP 服务
- stdio MCP 服务
- V1 / V2 工具
- 资源读取
- 与当前 Electron 工作台状态的联动

## Current Entry Points

### HTTP MCP

- URL: `http://127.0.0.1:3765/mcp`
- Health: `http://127.0.0.1:3765/health`

### stdio MCP

- Command: `npm run mcp:stdio`

## Test Modes

建议按 4 种方式测试：

1. 健康检查
2. Inspector 交互测试
3. 官方 SDK 客户端测试
4. 端到端工作台测试

---

## 1. 健康检查

先启动 Electron：

```powershell
npm start
```

然后检查 HTTP 服务：

```powershell
Invoke-RestMethod http://127.0.0.1:3765/health
```

预期返回：

```json
{
  "ok": true,
  "name": "step-workbench-mcp",
  "transport": "streamable-http",
  "port": 3765
}
```

### 判定标准

- 成功：能返回 `ok: true`
- 失败：端口未监听，说明 Electron 内嵌 MCP 没有启动

---

## 2. Inspector 测试

推荐先用 Inspector 进行人工验证。

### HTTP 模式

```powershell
npx @modelcontextprotocol/inspector
```

在 Inspector 中填写：

- Transport: `Streamable HTTP`
- URL: `http://127.0.0.1:3765/mcp`

### stdio 模式

在 Inspector 中填写：

- Transport: `stdio`
- Command: `npm.cmd`
- Args: `run mcp:stdio`

### 注意

`stdio` 模式下没有运行中的 Electron renderer，所以以下工具预期不可用：

- `assembly.capture_view`
- `assembly.capture_part_mask`
- `assembly.capture_step_preview`
- 阶段 2 的交互命令工具在 headless 下也不可实际执行

这属于**预期行为**。

---

## 3. 官方 SDK 客户端测试

推荐使用官方 TypeScript SDK 的 Node client 来做集成测试。

### 3.1 HTTP 客户端测试脚本

新建临时脚本 `test-mcp-http.js`：

```js
const fs = require("fs");
const { Client } = require("@modelcontextprotocol/sdk/client");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

(async () => {
  const client = new Client({
    name: "local-http-test",
    version: "0.1.0",
  });

  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:3765/mcp")
  );

  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:");
  console.log(tools.tools.map((tool) => tool.name));

  const summary = await client.callTool({
    name: "assembly.get_current_summary",
    arguments: {},
  });
  console.log("\nSUMMARY:");
  console.log(summary.structuredContent);

  const tree = await client.callTool({
    name: "assembly.get_tree",
    arguments: { maxDepth: 2 },
  });
  console.log("\nTREE:");
  console.log(JSON.stringify(tree.structuredContent, null, 2));

  const colorMap = await client.callTool({
    name: "assembly.get_color_map",
    arguments: { mode: "display" },
  });
  console.log("\nCOLOR MAP:");
  console.log(colorMap.structuredContent);

  const capture = await client.callTool({
    name: "assembly.capture_view",
    arguments: { width: 1024, height: 768, fit: true },
  });
  console.log("\nCAPTURE:");
  console.log(capture.structuredContent);

  const image = await client.readResource({
    uri: capture.structuredContent.resourceUri,
  });

  fs.writeFileSync("mcp-capture.png", Buffer.from(image.contents[0].blob, "base64"));
  console.log("\nSaved mcp-capture.png");

  await transport.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

运行：

```powershell
node test-mcp-http.js
```

### 3.2 stdio 客户端测试脚本

```js
const { Client } = require("@modelcontextprotocol/sdk/client");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

(async () => {
  const client = new Client({
    name: "local-stdio-test",
    version: "0.1.0",
  });

  const transport = new StdioClientTransport({
    command: "npm.cmd",
    args: ["run", "mcp:stdio"],
  });

  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:");
  console.log(tools.tools.map((tool) => tool.name));

  const summary = await client.callTool({
    name: "assembly.get_current_summary",
    arguments: {},
  });
  console.log(summary.structuredContent);

  await transport.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

运行：

```powershell
node test-mcp-stdio.js
```

### 判定标准

- `listTools` 返回完整工具列表
- `assembly.get_current_summary` 成功
- HTTP 模式下截图工具成功
- stdio 模式下截图工具失败但错误信息合理

---

## 4. 端到端工作台测试

这是最重要的测试，因为部分工具依赖当前活动工作台。

### 步骤

1. `npm start`
2. 导入或打开一个 `ready` 项目
3. 进入工作台页面
4. 在 Inspector 或 HTTP 客户端中依次调用工具

### 推荐测试顺序

#### 基础只读

- `assembly.get_current_summary`
- `assembly.get_tree`
- `assembly.get_part`
- `assembly.get_color_map`
- `assembly.get_selection`

#### 截图与资源

- `assembly.capture_view`
- `assembly.capture_part_mask`
- `resources/read`:
  - `assembly://session/current/manifest`
  - `assembly://session/current/tree`
  - `assembly://session/current/color-map/display`
  - `assembly://session/current/view/beauty.png`
  - `assembly://session/current/view/id-mask.png`

#### 阶段 2 交互

- `assembly.isolate_parts`
- `assembly.clear_isolation`
- `assembly.set_section_plane`
- `assembly.clear_section_plane`

#### V2 推理

- `assembly.get_base_part_candidates`
- `assembly.get_mating_candidates`
- `assembly.get_relative_transform`
- `assembly.get_insertion_candidates`
- `assembly.check_interference`
- `assembly.plan_sequence`
- `assembly.explain_step`
- `assembly.capture_step_preview`

#### V2 资源

- `assembly://session/current/base-part-candidates`
- `assembly://session/current/mating-candidates`
- `assembly://session/current/plan`
- `assembly://session/current/sequence/{sequenceId}/step/{stepIndex}`
- `assembly://session/current/sequence/{sequenceId}/step/{stepIndex}/preview.png`

---

## Expected Results By Tool

### `assembly.get_current_summary`

应返回：

- 当前打开项目的 `projectId`
- `partCount / faceCount / solidCount`
- 当前 selection / section / isolation / camera

### `assembly.capture_view`

应返回：

- `resourceUri`
- `mimeType: image/png`
- 正确的宽高

资源读取得到的是当前视图截图。

### `assembly.capture_part_mask`

应返回：

- 当前视图对应的零件 mask 图
- 配合 `assembly.get_color_map` 可做颜色映射

### `assembly.isolate_parts`

执行后再次调用：

- `assembly.get_current_summary`
- `assembly.get_selection`

应看到当前工作台 isolation 状态变化。

### `assembly.set_section_plane`

执行后再次截图，应看到剖切效果变化。

### `assembly.get_base_part_candidates`

预期返回若干候选：

- 体积大、支撑面大、连接度高的零件分数更高

### `assembly.get_mating_candidates`

预期返回：

- 零件对
- 候选面
- relation
- score

### `assembly.plan_sequence`

预期返回：

- `basePartCandidates`
- `precedenceGraph`
- `candidateSequences`

### `assembly.explain_step`

预期返回：

- 该步的自然语言解释
- 配合面
- 位姿变化
- 插入方向
- 证据

### `assembly.capture_step_preview`

预期返回：

- `resourceUri`
- 一张 before / after 对比图

---

## Regression Checklist

每次修改 MCP 或 viewer 后，至少检查：

- `GET /health` 正常
- `listTools` 正常
- `assembly.get_current_summary` 正常
- `assembly.capture_view` 正常
- `assembly.capture_part_mask` 正常
- `assembly.get_base_part_candidates` 正常
- `assembly.plan_sequence` 正常
- `assembly.explain_step` 正常
- `assembly.capture_step_preview` 正常

---

## Known Current Limitations

### stdio 模式限制

- 无 Electron renderer
- 无截图
- 无 step preview
- 无真实交互执行

### 几何推理限制

- 当前配合识别仍以平面候选为主
- 圆柱 / 同轴路径已接入，但是否命中取决于 STEP 面分组
- 干涉检测当前是 AABB 代理，不是 swept-volume

### Step preview 限制

- 当前是“沿插入轴回退”的比较图
- 不是完整动画重演
- 还没有箭头与配合面 overlay

---

## Failure Diagnosis

### `GET /health` 失败

可能原因：

- Electron 未启动
- MCP HTTP 服务未正常挂载
- 端口被占用

### `assembly.capture_view` 失败

可能原因：

- 当前不在工作台页面
- 当前没有活动 viewer
- renderer capture bridge 未注册

### `assembly.isolate_parts` / `set_section_plane` 失败

可能原因：

- 当前不在工作台页面
- projectId 与当前活动项目不一致
- partId 不存在

### `assembly.capture_step_preview` 失败

可能原因：

- 当前不在工作台页面
- 当前 viewer 不支持 step preview
- sequenceId / stepIndex 无法解析

---

## Recommendation

日常开发时建议这样测：

1. `npm start`
2. 打开一个 `ready` 项目进入工作台
3. 先跑健康检查
4. 再用 Inspector 验证工具
5. 最后用 SDK 客户端脚本验证自动化链路

如果需要，把这份文档转成 CI checklist 或加入自动化脚本也很方便。