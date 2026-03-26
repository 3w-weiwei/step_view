const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:3765/mcp";
const HEALTH_URL = process.env.MCP_HEALTH_URL || "http://127.0.0.1:3765/health";
const OUTPUT_ROOT = process.env.MCP_OUTPUT_DIR || path.join(process.cwd(), "mcp-test-output");
const WAIT_TIMEOUT_MS = Number(process.env.MCP_WAIT_TIMEOUT_MS || 60000);
const PROJECT_STORE = path.join(process.cwd(), "project-data");

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }
    } catch (_error) {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`MCP health endpoint was not ready within ${timeoutMs}ms: ${url}`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeName(value, fallback) {
  const normalized = String(value || fallback || "artifact")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback || "artifact";
}

function unwrapToolResult(result, toolName) {
  if (result?.isError) {
    const message = (result.content || [])
      .map((item) => item?.text)
      .filter(Boolean)
      .join("\n") || `${toolName} returned an MCP error.`;
    throw new Error(`${toolName} failed: ${message}`);
  }

  const structuredContent = result?.structuredContent ?? result?.result?.structuredContent;
  if (structuredContent === undefined) {
    throw new Error(`${toolName} returned no structuredContent.`);
  }
  return structuredContent;
}

function resolveProjectId() {
  if (process.env.MCP_PROJECT_ID) {
    return process.env.MCP_PROJECT_ID;
  }

  const candidates = fs.readdirSync(PROJECT_STORE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PROJECT_STORE, entry.name, "manifest.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => JSON.parse(fs.readFileSync(manifestPath, "utf8")))
    .filter((manifest) => manifest.status === "ready")
    .sort((left, right) => (left.faceCount || Number.MAX_SAFE_INTEGER) - (right.faceCount || Number.MAX_SAFE_INTEGER));

  return candidates[0]?.projectId || null;
}

function collectImageEntries(bundle) {
  return Object.entries(bundle.images || {}).flatMap(([category, entries]) =>
    (entries || []).map((entry, index) => ({
      category,
      index,
      ...entry,
    })),
  );
}

async function saveBundleImages(client, bundle, outputDir) {
  const savedFiles = [];
  for (const entry of collectImageEntries(bundle)) {
    if (!entry.resourceUri) {
      continue;
    }
    const resource = await client.readResource({ uri: entry.resourceUri });
    const content = resource.contents?.[0];
    if (!content?.blob) {
      continue;
    }
    const extension = entry.mimeType === "image/jpeg" ? "jpg" : "png";
    const fileName = `${sanitizeName(entry.category, "bundle")}_${String(entry.index + 1).padStart(2, "0")}_${sanitizeName(entry.name, "image")}.${extension}`;
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(content.blob, "base64"));
    savedFiles.push(filePath);
  }
  return savedFiles;
}

function pickCandidate(candidates) {
  return (
    candidates.relationCandidates?.[0]?.candidateId ||
    candidates.graspCandidates?.[0]?.candidateId ||
    candidates.baseCandidates?.[0]?.candidateId ||
    candidates.subassemblyCandidates?.[0]?.candidateId ||
    null
  );
}

(async () => {
  ensureDir(OUTPUT_ROOT);
  const health = await waitForHealth(HEALTH_URL, WAIT_TIMEOUT_MS);
  console.log("HEALTH:", health);

  const projectId = resolveProjectId();
  if (!projectId) {
    throw new Error("No ready project found for MCP evidence-bundle testing.");
  }
  console.log("PROJECT:", projectId);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(OUTPUT_ROOT, `evidence-bundle-${timestamp}`);
  ensureDir(outputDir);

  const client = new Client({
    name: "step-workbench-evidence-test",
    version: "0.1.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    console.log("TOOLS:", toolNames);

    const modelContextResult = await client.callTool({
      name: "assembly.get_model_context",
      arguments: {
        projectId,
        includeFaces: true,
        includeColorMaps: true,
        maxFaceCountPerPart: 24,
      },
    });
    const modelContext = unwrapToolResult(modelContextResult, "assembly.get_model_context");
    fs.writeFileSync(
      path.join(outputDir, "model-context.json"),
      JSON.stringify(modelContext, null, 2),
    );

    const relationCandidatesResult = await client.callTool({
      name: "assembly.get_relation_candidates",
      arguments: {
        projectId,
        topK: 12,
        includeBaseCandidates: true,
        includeSubassemblyCandidates: true,
        includeGraspCandidates: true,
      },
    });
    const candidates = unwrapToolResult(relationCandidatesResult, "assembly.get_relation_candidates");
    fs.writeFileSync(
      path.join(outputDir, "relation-candidates.json"),
      JSON.stringify(candidates, null, 2),
    );

    const candidateId = pickCandidate(candidates);
    if (!candidateId) {
      throw new Error("No candidateId available for evidence bundle capture.");
    }

    console.log("SELECTED CANDIDATE:", candidateId);

    const evidenceBundleResult = await client.callTool({
      name: "assembly.capture_evidence_bundle",
      arguments: {
        projectId,
        candidateId,
        includeGlobalViews: true,
        includeLocalViews: true,
        includeSectionViews: false,
        includePartMask: true,
        includeFaceMask: true,
        includeOverlay: true,
        includeTransparentContext: false,
        width: 720,
        height: 540,
      },
    }, undefined, { timeout: 180000 });
    const evidenceBundle = unwrapToolResult(evidenceBundleResult, "assembly.capture_evidence_bundle");
    fs.writeFileSync(
      path.join(outputDir, "evidence-bundle.json"),
      JSON.stringify(evidenceBundle, null, 2),
    );

    const savedFiles = await saveBundleImages(client, evidenceBundle, outputDir);

    if (candidates.relationCandidates?.[0]) {
      const relation = candidates.relationCandidates[0];
      const validationResult = await client.callTool({
        name: "assembly.validate_hypothesis",
        arguments: {
          projectId,
          hypothesis: {
            type: "relation",
            relationCandidateId: relation.candidateId,
            partAId: relation.partAId,
            partBId: relation.partBId,
          },
        },
      });
      const validation = unwrapToolResult(validationResult, "assembly.validate_hypothesis");
      fs.writeFileSync(
        path.join(outputDir, "validation.json"),
        JSON.stringify(validation, null, 2),
      );
    }

    console.log("OUTPUT DIR:", outputDir);
    console.log("SAVED IMAGE COUNT:", savedFiles.length);
    savedFiles.forEach((filePath) => console.log("IMAGE:", filePath));
  } finally {
    await transport.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
