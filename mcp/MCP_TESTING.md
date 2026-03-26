# MCP Testing Guide

## Scope

本文档用于测试当前软件内嵌的 HTTP MCP 服务，重点验证新的高层 VLM 接口：

- `assembly.get_model_context`
- `assembly.get_relation_candidates`
- `assembly.capture_evidence_bundle`
- `assembly.validate_hypothesis`

当前推荐以 `HTTP MCP` 为主进行测试。`stdio MCP` 仍可用于只读结构化数据验证，但不适合作为证据包抓图的主链路。

## Current Entry Points

### HTTP MCP

- URL: `http://127.0.0.1:3765/mcp`
- Health: `http://127.0.0.1:3765/health`

### stdio MCP

- Command: `npm run mcp:stdio`

## Recommended Test Flow

### 1. Launch Electron App

```powershell
npm start
```

### 2. Check Health Endpoint

```powershell
Invoke-RestMethod http://127.0.0.1:3765/health
```

Expected response:

```json
{
  "ok": true,
  "name": "step-workbench-mcp",
  "transport": "streamable-http",
  "port": 3765
}
```

### 3. Run the End-to-End Evidence Bundle Test

```powershell
npm run mcp:test:evidence:http
```

This script will:

1. Wait for the MCP health endpoint to become ready
2. Connect to the local HTTP MCP server using the official SDK
3. Call `assembly.get_model_context`
4. Call `assembly.get_relation_candidates`
5. Pick a high-priority candidate automatically
6. Call `assembly.capture_evidence_bundle`
7. Read all returned image resources and save them locally
8. Call `assembly.validate_hypothesis` for the top relation candidate

Output directory:

- `mcp-test-output/evidence-bundle-<timestamp>/`

Expected artifacts:

- `model-context.json`
- `relation-candidates.json`
- `evidence-bundle.json`
- `validation.json` when a relation candidate exists
- Multiple `.png` or `.jpg` image files captured through MCP resources

## Manual Inspector Test

You can also inspect the MCP service manually.

### Start Inspector

```powershell
npx @modelcontextprotocol/inspector
```

Use:

- Transport: `Streamable HTTP`
- URL: `http://127.0.0.1:3765/mcp`

### Recommended Manual Call Order

1. `assembly.get_model_context`
2. `assembly.get_relation_candidates`
3. Pick one returned `candidateId`
4. `assembly.capture_evidence_bundle`
5. Read returned bundle image resources
6. `assembly.validate_hypothesis`

## What Counts as Success

A successful end-to-end run should satisfy all of the following:

- The health endpoint returns `ok: true`
- `listTools` includes the four high-level MCP tools
- `assembly.get_model_context` returns a non-empty parts list
- `assembly.get_relation_candidates` returns at least one candidate on the sample project
- `assembly.capture_evidence_bundle` returns image resource links
- The external client can read those image resources and save image files locally
- `assembly.validate_hypothesis` returns a structured validation result

## Troubleshooting

### The evidence bundle tool says there is no active workbench

The renderer now attempts to auto-prepare a workbench when `capture-evidence-bundle` is requested. If this still fails:

- Make sure the Electron app window is open
- Make sure at least one project is in `ready` state
- Retry after the app fully finishes loading

### The health endpoint is up but no images are saved

Check:

- Whether the selected project is `ready`
- Whether the app has a visible window and renderer context
- Whether the output JSON contains `resourceUri` entries under `images`

### `stdio` mode works but `capture_evidence_bundle` fails

This is expected. The evidence bundle path depends on the live renderer, so the primary test route is HTTP MCP running inside Electron.

## Notes

- Evidence bundle capture now prefers `isolation + overlay + face-mask + optional section views`
- The current implementation is intended to provide VLM-ready evidence, not final industrial truth
- If you need reproducible regression testing later, convert one or two known `ready` projects into fixed golden test cases
