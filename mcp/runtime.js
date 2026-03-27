const { randomUUID } = require("crypto");
const { McpServer, ResourceTemplate } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod/v4");
const {
  buildModelContextToolPayload,
  buildAnalysisCandidates,
  buildRelationCandidatesToolPayload,
  buildEvidenceTarget,
  validateHypothesis,
} = require("./analysis-v3");

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function dataUrlToBase64(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid data URL.");
  }
  return {
    mimeType: match[1],
    base64: match[2],
  };
}

function extensionFromMimeType(mimeType) {
  return mimeType === "image/jpeg" ? "jpeg" : "png";
}

function sanitizeArtifactName(value, fallback) {
  const normalized = String(value || fallback || "artifact")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback || "artifact";
}

function hueToRgb(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function hslToHex(h, s, l) {
  const hue = (((h % 1) + 1) % 1);
  let r;
  let g;
  let b;

  if (s === 0) {
    r = l;
    g = l;
    b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToRgb(p, q, hue + 1 / 3);
    g = hueToRgb(p, q, hue);
    b = hueToRgb(p, q, hue - 1 / 3);
  }

  const toHex = (value) => Math.round(value * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function indexToPaletteHex(index) {
  return hslToHex((((index * 137.508) % 360) + 360) % 360 / 360, 0.74, 0.52);
}

const artifactCache = new Map();

function createMcpRuntime(adapter) {

  async function resolveProject(projectId) {
    const rendererState = adapter.getRendererState ? await adapter.getRendererState() : null;
    const activeProjectId = projectId || rendererState?.currentProjectId || null;

    if (activeProjectId) {
      const details = await adapter.getProjectDetails(activeProjectId);
      if (details?.manifest) {
        return details;
      }
    }

    const projects = await adapter.listProjects();
    const fallback = projects.find((item) => item.status === "ready") || projects[0] || null;
    if (!fallback) {
      throw new Error("No available project.");
    }

    const details = await adapter.getProjectDetails(fallback.projectId);
    if (!details?.manifest) {
      throw new Error("Cannot load active project details.");
    }
    return details;
  }

  async function buildColorMap(projectId, mode) {
    const details = await resolveProject(projectId);
    const rendererState = adapter.getRendererState ? await adapter.getRendererState() : null;
    const rendererColorMaps = rendererState?.colorMaps || {};
    const cached = rendererColorMaps[mode];
    if (cached?.length) {
      return deepClone(cached);
    }

    if (mode === "face-mask" || mode === "face-mask-palette") {
      let faceIndex = 0;
      return (details.assembly?.nodes || [])
        .filter((node) => node.kind === "part")
        .flatMap((node) =>
          (node.faces || []).map((face) => {
            const currentIndex = faceIndex;
            faceIndex += 1;
            return {
              faceId: face.id,
              faceName: face.name,
              nodeId: node.id,
              partId: node.id,
              partName: node.name,
              colorHex: mode === "face-mask-palette" ? indexToPaletteHex(currentIndex) : `#${String(currentIndex + 1).padStart(6, "0")}`,
            };
          }),
        );
    }

    return (details.assembly?.nodes || [])
      .filter((node) => node.kind === "part")
      .map((node, index) => ({
        colorHex:
          mode === "id-mask"
            ? `#${String(index + 1).padStart(6, "0")}`
            : mode === "id-mask-palette"
              ? indexToPaletteHex(index)
              : node.color || "#8aa6d1",
        nodeId: node.id,
        partId: node.id,
        name: node.name,
      }));
  }

  async function buildColorMaps(projectId) {
    return {
      display: await buildColorMap(projectId, "display"),
      partMask: await buildColorMap(projectId, "id-mask-palette"),
      partMaskRaw: await buildColorMap(projectId, "id-mask"),
      partMaskPalette: await buildColorMap(projectId, "id-mask-palette"),
      faceMask: await buildColorMap(projectId, "face-mask-palette"),
      faceMaskRaw: await buildColorMap(projectId, "face-mask"),
      faceMaskPalette: await buildColorMap(projectId, "face-mask-palette"),
    };
  }

  function cacheBinaryArtifact(uri, mimeType, base64, metadata = {}) {
    artifactCache.set(uri, {
      uri,
      mimeType,
      base64,
      generatedAt: new Date().toISOString(),
      ...metadata,
    });
  }

  function cacheImageArtifact(bundleId, category, entry, index) {
    const safeName = sanitizeArtifactName(entry.name || `${category}_${entry.preset || entry.axis || index + 1}`, `${category}_${index + 1}`);
    const { mimeType, base64 } = dataUrlToBase64(entry.dataUrl);
    const ext = extensionFromMimeType(mimeType);
    const resourceUri = `assembly://session/current/bundle/${bundleId}/${safeName}.${ext}`;

    cacheBinaryArtifact(resourceUri, mimeType, base64, {
      width: entry.width || null,
      height: entry.height || null,
      bundleId,
      category,
    });

    return {
      name: safeName,
      resourceUri,
      mimeType,
      width: entry.width || null,
      height: entry.height || null,
      preset: entry.preset || null,
      axis: entry.axis || null,
      offset: entry.offset ?? null,
      label: entry.label || null,
    };
  }

  async function readArtifactResource(uri) {
    const cached = artifactCache.get(uri);
    if (!cached) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return cached;
  }

  async function buildModelContextPayload(projectId, options = {}) {
    const details = await resolveProject(projectId);
    const payload = buildModelContextToolPayload(details, options);
    if (options.includeColorMaps === true) {
      payload.colorMaps = await buildColorMaps(details.manifest.projectId);
    }
    return payload;
  }

  async function buildRelationCandidatesPayload(projectId, options = {}) {
    const details = await resolveProject(projectId);
    return buildRelationCandidatesToolPayload(details, options);
  }

  async function captureEvidenceBundlePayload(projectId, options = {}) {
    if (!adapter.executeRendererCommand) {
      throw new Error("Evidence bundle capture requires an active renderer.");
    }

    const details = await resolveProject(projectId);
    const candidates = buildAnalysisCandidates(details, {
      partIds: options.partIds,
      topK: options.topK,
    });
    const target = buildEvidenceTarget(details, options, candidates);
    const bundleResult = await adapter.executeRendererCommand({
      action: "capture-evidence-bundle",
      projectId: details.manifest.projectId,
      target,
      timeoutMs: 60000,
      includeGlobalViews: options.includeGlobalViews !== false,
      includeLocalViews: options.includeLocalViews !== false,
      includeSectionViews: options.includeSectionViews === true,
      includePartMask: options.includePartMask !== false,
      includeFaceMask: options.includeFaceMask !== false,
      includeOverlay: options.includeOverlay !== false,
      includeTransparentContext: options.includeTransparentContext === true,
      width: options.width,
      height: options.height,
    });

    const bundleId = randomUUID();
    const images = {};
    const resourceLinks = [];

    Object.entries(bundleResult.images || {}).forEach(([category, entries]) => {
      images[category] = (entries || []).map((entry, index) => {
        const cached = cacheImageArtifact(bundleId, category, entry, index);
        resourceLinks.push({
          type: "resource_link",
          uri: cached.resourceUri,
          name: cached.name,
          mimeType: cached.mimeType,
        });
        return cached;
      });
    });

    return {
      content: [
        {
          type: "text",
          text: `Generated evidence bundle with ${resourceLinks.length} image artifacts.`,
        },
        ...resourceLinks,
      ],
      structuredContent: {
        projectId: details.manifest.projectId,
        bundleId,
        target: bundleResult.target || target,
        images,
        colorMaps: bundleResult.colorMaps || {},
        metadata: bundleResult.metadata || {},
      },
    };
  }

  async function validateHypothesisPayload(projectId, hypothesis, checks = {}) {
    const details = await resolveProject(projectId);
    const partIds = [
      ...(hypothesis?.partIds || []),
      ...(hypothesis?.subassemblyPartIds || []),
      hypothesis?.partAId,
      hypothesis?.partBId,
      hypothesis?.basePartId,
      hypothesis?.movingPartId,
      hypothesis?.assemblingPartId,
      hypothesis?.referencePartId,
      hypothesis?.partId,
    ].filter(Boolean);

    const candidates = buildAnalysisCandidates(details, {
      partIds: partIds.length ? [...new Set(partIds)] : undefined,
      topK: 32,
    });
    const result = validateHypothesis(details, hypothesis, {
      candidates,
      checks,
    });

    return {
      projectId: details.manifest.projectId,
      hypothesis,
      result,
    };
  }

  const server = new McpServer({
    name: "step-workbench-mcp",
    version: "0.3.0",
  });

  server.registerTool("assembly.get_model_context", {
    description: "Return lightweight or scoped model context for staged VLM retrieval.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      partIds: z.array(z.string()).optional(),
      includeFaces: z.boolean().optional(),
      includeColorMaps: z.boolean().optional(),
      maxFaceCountPerPart: z.number().int().min(1).max(2048).optional(),
      maxDepth: z.number().int().min(1).max(64).optional(),
      summaryOnly: z.boolean().optional(),
    },
  }, async ({ projectId, partIds, includeFaces, includeColorMaps, maxFaceCountPerPart, maxDepth, summaryOnly }) => {
    const payload = await buildModelContextPayload(projectId, {
      partIds,
      includeFaces,
      includeColorMaps,
      maxFaceCountPerPart,
      maxDepth,
      summaryOnly,
    });
    return {
      content: [{ type: "text", text: "Loaded " + payload.parts.length + " parts from " + payload.projectName + "." }],
      structuredContent: payload,
    };
  });

  server.registerTool("assembly.get_relation_candidates", {
    description: "Return scoped relation candidates with optional evidence and candidate-type filtering.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      partIds: z.array(z.string()).optional(),
      topK: z.number().int().min(1).max(128).optional(),
      facePairLimit: z.number().int().min(1).max(12).optional(),
      candidateTypes: z.array(z.string()).optional(),
      includeEvidence: z.boolean().optional(),
      evidenceLimit: z.number().int().min(1).max(32).optional(),
      includeBaseCandidates: z.boolean().optional(),
      includeSubassemblyCandidates: z.boolean().optional(),
      includeGraspCandidates: z.boolean().optional(),
    },
  }, async ({
    projectId,
    partIds,
    topK,
    facePairLimit,
    candidateTypes,
    includeEvidence,
    evidenceLimit,
    includeBaseCandidates,
    includeSubassemblyCandidates,
    includeGraspCandidates,
  }) => {
    const payload = await buildRelationCandidatesPayload(projectId, {
      partIds,
      topK,
      facePairLimit,
      candidateTypes,
      includeEvidence,
      evidenceLimit,
      includeBaseCandidates,
      includeSubassemblyCandidates,
      includeGraspCandidates,
    });
    const totalCount =
      (payload.relationCandidates?.length || 0) +
      (payload.baseCandidates?.length || 0) +
      (payload.subassemblyCandidates?.length || 0) +
      (payload.graspCandidates?.length || 0);
    return {
      content: [{ type: "text", text: "Returned " + totalCount + " scoped candidates." }],
      structuredContent: payload,
    };
  });

  server.registerTool("assembly.capture_evidence_bundle", {
    description: "Capture a bundle of VLM-ready visual evidence for a candidate or focused parts.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      candidateId: z.string().optional(),
      partIds: z.array(z.string()).optional(),
      focusFaceIds: z.array(z.string()).optional(),
      includeGlobalViews: z.boolean().optional(),
      includeLocalViews: z.boolean().optional(),
      includeSectionViews: z.boolean().optional(),
      includePartMask: z.boolean().optional(),
      includeFaceMask: z.boolean().optional(),
      includeOverlay: z.boolean().optional(),
      includeTransparentContext: z.boolean().optional(),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      topK: z.number().int().min(1).max(128).optional(),
    },
  }, async (input) => captureEvidenceBundlePayload(input.projectId, input));

  server.registerTool("assembly.validate_hypothesis", {
    description: "Validate a VLM-generated relation, subassembly, base, grasp, or assembly-step hypothesis.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      hypothesis: z.object({
        type: z.string(),
        candidateId: z.string().optional(),
        relationCandidateId: z.string().optional(),
        graspCandidateId: z.string().optional(),
        partId: z.string().optional(),
        partAId: z.string().optional(),
        partBId: z.string().optional(),
        partIds: z.array(z.string()).optional(),
        subassemblyPartIds: z.array(z.string()).optional(),
        basePartId: z.string().optional(),
        movingPartId: z.string().optional(),
        assemblingPartId: z.string().optional(),
        referencePartId: z.string().optional(),
        gripFaceIds: z.array(z.string()).optional(),
        fixedPartIds: z.array(z.string()).optional(),
        insertionDirection: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
        transform: z.object({
          translation: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
          quaternion: z.object({ x: z.number(), y: z.number(), z: z.number(), w: z.number() }).optional(),
        }).optional(),
        partName: z.string().optional(),
      }).passthrough(),
      checks: z.record(z.string(), z.boolean()).optional(),
    },
  }, async ({ projectId, hypothesis, checks }) => {
    const payload = await validateHypothesisPayload(projectId, hypothesis, checks);
    return {
      content: [{ type: "text", text: payload.result.summary }],
      structuredContent: payload,
    };
  });

  server.registerResource("bundle-image", new ResourceTemplate("assembly://session/current/bundle/{bundleId}/{name}.{ext}", {}), {
    mimeType: "image/png",
    description: "Cached evidence-bundle image resource.",
  }, async (_uri, variables) => {
    const uri = `assembly://session/current/bundle/${variables.bundleId}/${variables.name}.${variables.ext}`;
    const cached = await readArtifactResource(uri);
    return {
      contents: [{
        uri,
        mimeType: cached.mimeType,
        blob: cached.base64,
      }],
    };
  });

  return server;
}

module.exports = {
  createMcpRuntime,
};










