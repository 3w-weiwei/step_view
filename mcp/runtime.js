const { McpServer, ResourceTemplate } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod/v4");
const {
  buildBasePartCandidates,
  buildMatingCandidates,
  buildRelativeTransform,
  buildInsertionCandidates,
  checkInterference,
  buildSequencePlan,
} = require("./analysis-v2");

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

function buildTree(nodeMap, nodeId, maxDepth, depth = 0) {
  const node = nodeMap.get(nodeId);
  if (!node) {
    return null;
  }

  const payload = {
    id: node.id,
    name: node.name,
    kind: node.kind,
    pathNames: node.pathNames,
    meshRefs: node.meshRefs || [],
    bbox: node.bbox || null,
    topology: node.topology || null,
    children: [],
  };

  if (maxDepth == null || depth < maxDepth - 1) {
    payload.children = node.children
      .map((childId) => buildTree(nodeMap, childId, maxDepth, depth + 1))
      .filter(Boolean);
  }

  return payload;
}

function createMcpRuntime(adapter) {
  const captureCache = new Map();

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

  async function buildSummary(projectId) {
    const details = await resolveProject(projectId);
    const rendererState = adapter.getRendererState ? await adapter.getRendererState() : null;
    return {
      projectId: details.manifest.projectId,
      projectName: details.manifest.projectName,
      modelName: details.manifest.modelName || details.assembly?.meta?.sourceModelName || details.manifest.projectName,
      status: details.manifest.status,
      parserMode: details.manifest.parserMode,
      geometryMode: details.manifest.geometryMode,
      partCount: details.manifest.partCount || 0,
      assemblyCount: details.manifest.assemblyCount || 0,
      faceCount: details.manifest.faceCount || 0,
      solidCount: details.manifest.solidCount || 0,
      selection: rendererState?.selection || null,
      section: rendererState?.section || null,
      isolation: rendererState?.isolation || [],
      camera: rendererState?.camera || null,
    };
  }

  async function buildTreePayload(projectId, maxDepth) {
    const details = await resolveProject(projectId);
    const nodeMap = new Map((details.assembly?.nodes || []).map((node) => [node.id, node]));
    return buildTree(nodeMap, details.assembly.rootId, maxDepth);
  }

  async function buildPartPayload(projectId, partId) {
    const details = await resolveProject(projectId);
    const node = (details.assembly?.nodes || []).find((item) => item.id === partId);
    if (!node) {
      throw new Error(`Node not found: ${partId}`);
    }
    return deepClone(node);
  }

  async function buildColorMap(projectId, mode) {
    const details = await resolveProject(projectId);
    const rendererState = adapter.getRendererState ? await adapter.getRendererState() : null;
    const rendererColorMaps = rendererState?.colorMaps || {};
    const cached = rendererColorMaps[mode];
    if (cached?.length) {
      return { entries: deepClone(cached) };
    }

    const entries = (details.assembly?.nodes || [])
      .filter((node) => node.kind === "part")
      .map((node, index) => ({
        colorHex:
          mode === "id-mask"
            ? `#${String(index + 1).padStart(6, "0")}`
            : node.color || "#8aa6d1",
        nodeId: node.id,
        partId: node.id,
        name: node.name,
      }));

    return { entries };
  }

  async function capture(projectId, mode, options = {}) {
    const details = await resolveProject(projectId);
    const captureResult = await adapter.captureRenderer({
      mode,
      projectId: details.manifest.projectId,
      width: options.width,
      height: options.height,
      fit: options.fit,
    });

    const { mimeType, base64 } = dataUrlToBase64(captureResult.dataUrl);
    const uri =
      mode === "id-mask"
        ? "assembly://session/current/view/id-mask.png"
        : "assembly://session/current/view/beauty.png";

    captureCache.set(uri, {
      uri,
      mimeType,
      base64,
      width: captureResult.width,
      height: captureResult.height,
      generatedAt: new Date().toISOString(),
    });

    if (captureResult.colorMap?.length) {
      const colorMapUri =
        mode === "id-mask"
          ? "assembly://session/current/color-map/id-mask"
          : "assembly://session/current/color-map/display";
      captureCache.set(colorMapUri, {
        uri: colorMapUri,
        json: {
          entries: captureResult.colorMap,
        },
      });
    }

    return {
      resourceUri: uri,
      mimeType,
      width: captureResult.width,
      height: captureResult.height,
    };
  }

  async function readCaptureResource(uri, mode) {
    let cached = captureCache.get(uri);
    if (!cached) {
      if (mode === "beauty" || mode === "id-mask") {
        await capture(undefined, mode, {});
        cached = captureCache.get(uri);
      }
    }
    if (!cached) {
      throw new Error(`Resource not found: ${uri}`);
    }
    return cached;
  }

  async function executeInteraction(projectId, action, args = {}) {
    if (!adapter.executeRendererCommand) {
      throw new Error("Interactive MCP tools are not supported by this adapter.");
    }

    const details = await resolveProject(projectId);
    return adapter.executeRendererCommand({
      action,
      projectId: details.manifest.projectId,
      ...args,
    });
  }

  async function buildPlanPayload(projectId, options = {}) {
    const details = await resolveProject(projectId);
    const plan = buildSequencePlan(details, options);
    return { details, plan };
  }

  async function buildExplainStepPayload(projectId, options = {}) {
    const { details, plan } = await buildPlanPayload(projectId, options);
    const sequence =
      (options.sequenceId
        ? plan.candidateSequences.find((item) => item.sequenceId === options.sequenceId)
        : null) || plan.candidateSequences[0];

    if (!sequence) {
      throw new Error("No explainable sequence is available.");
    }

    const step =
      sequence.steps.find((item) => item.stepIndex === options.stepIndex) ||
      (typeof options.stepIndex !== "number" ? sequence.steps[0] : null);

    if (!step) {
      throw new Error(`Step ${options.stepIndex} was not found in the sequence.`);
    }

    const nodeMap = new Map((details.assembly?.nodes || []).map((node) => [node.id, node]));
    const baseNode = nodeMap.get(step.basePartId);
    const assemblingNode = nodeMap.get(step.assemblingPartId);

    return {
      projectId: details.manifest.projectId,
      sequenceId: sequence.sequenceId,
      stepIndex: step.stepIndex,
      title: `Step ${step.stepIndex}: ${assemblingNode?.name || step.assemblingPartId} -> ${baseNode?.name || step.basePartId}`,
      summary: `Use ${baseNode?.name || step.basePartId} as the reference part, then insert ${assemblingNode?.name || step.assemblingPartId} along the candidate insertion axis into its target pose.`,
      rationale: [
        `base_part=${baseNode?.name || step.basePartId}`,
        `assembling_part=${assemblingNode?.name || step.assemblingPartId}`,
        `mating_face_count=${step.matingFaces?.length || 0}`,
        `confidence=${step.confidence}`,
      ],
      basePart: {
        partId: step.basePartId,
        name: baseNode?.name || step.basePartId,
      },
      assemblingPart: {
        partId: step.assemblingPartId,
        name: assemblingNode?.name || step.assemblingPartId,
      },
      insertionAxis: step.insertionAxis,
      matingFaces: step.matingFaces || [],
      deltaTransform: step.deltaTransform,
      transformBefore: step.transformBefore,
      transformAfter: step.transformAfter,
      confidence: step.confidence,
      evidence: step.evidence || [],
    };
  }

  async function captureStepPreview(projectId, options = {}) {
    if (!adapter.executeRendererCommand) {
      throw new Error("Step preview requires an active renderer.");
    }

    const step = await buildExplainStepPayload(projectId, options);
    const preview = await adapter.executeRendererCommand({
      action: "capture-step-preview",
      projectId: step.projectId,
      step,
      width: options.width,
      height: options.height,
      fit: options.fit,
    });

    const { mimeType, base64 } = dataUrlToBase64(preview.dataUrl);
    const uri = `assembly://session/current/sequence/${step.sequenceId}/step/${step.stepIndex}/preview.png`;
    captureCache.set(uri, {
      uri,
      mimeType,
      base64,
      width: preview.width,
      height: preview.height,
      generatedAt: new Date().toISOString(),
    });

    return {
      resourceUri: uri,
      mimeType,
      width: preview.width,
      height: preview.height,
      sequenceId: step.sequenceId,
      stepIndex: step.stepIndex,
    };
  }

  const server = new McpServer({
    name: "step-workbench-mcp",
    version: "0.1.0",
  });

  server.registerTool("assembly.get_current_summary", {
    description: "Return a summary of the currently active assembly.",
    inputSchema: {},
  }, async () => {
    const summary = await buildSummary();
    return {
      content: [{ type: "text", text: `Project ${summary.projectName} has ${summary.partCount} parts and ${summary.faceCount} faces.` }],
      structuredContent: summary,
    };
  });

  server.registerTool("assembly.get_tree", {
    description: "Return the assembly tree of the current project.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      maxDepth: z.number().int().min(1).optional(),
    },
  }, async ({ projectId, maxDepth }) => {
    const tree = await buildTreePayload(projectId, maxDepth);
    return {
      content: [{ type: "text", text: "Assembly tree returned." }],
      structuredContent: tree,
    };
  });

  server.registerTool("assembly.get_part", {
    description: "Return detailed information about one part or assembly node.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      partId: z.string(),
    },
  }, async ({ projectId, partId }) => {
    const part = await buildPartPayload(projectId, partId);
    return {
      content: [{ type: "text", text: `Node ${part.name} returned.` }],
      structuredContent: part,
    };
  });

  server.registerTool("assembly.get_color_map", {
    description: "Return the current color map for the assembly.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      mode: z.enum(["display", "id-mask"]).default("display"),
    },
  }, async ({ projectId, mode }) => {
    const colorMap = await buildColorMap(projectId, mode);
    return {
      content: [{ type: "text", text: `Returned ${colorMap.entries.length} color map entries.` }],
      structuredContent: colorMap,
    };
  });

  server.registerTool("assembly.get_selection", {
    description: "Return the current selection state from the active workbench.",
    inputSchema: {},
  }, async () => {
    const rendererState = adapter.getRendererState ? await adapter.getRendererState() : null;
    const selection = rendererState?.selection || null;
    return {
      content: [{ type: "text", text: selection ? `Current selection is ${selection.label || selection.nodeName || selection.nodeId}.` : "Nothing is selected." }],
      structuredContent: selection,
    };
  });

  server.registerTool("assembly.capture_view", {
    description: "Capture the current workbench view.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      fit: z.boolean().optional(),
    },
  }, async ({ projectId, width, height, fit }) => {
    const artifact = await capture(projectId, "beauty", { width, height, fit });
    return {
      content: [
        { type: "text", text: "Current view capture generated." },
        { type: "resource_link", uri: artifact.resourceUri, name: "Current View", mimeType: artifact.mimeType },
      ],
      structuredContent: artifact,
    };
  });

  server.registerTool("assembly.capture_part_mask", {
    description: "Capture the current workbench part ID mask.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      fit: z.boolean().optional(),
    },
  }, async ({ projectId, width, height, fit }) => {
    const artifact = await capture(projectId, "id-mask", { width, height, fit });
    return {
      content: [
        { type: "text", text: "Current part mask generated." },
        { type: "resource_link", uri: artifact.resourceUri, name: "Current Part Mask", mimeType: artifact.mimeType },
      ],
      structuredContent: artifact,
    };
  });

  server.registerTool("assembly.isolate_parts", {
    description: "Isolate the given parts in the active workbench.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      partIds: z.array(z.string()).min(1),
    },
  }, async ({ projectId, partIds }) => {
    const result = await executeInteraction(projectId, "isolate-parts", { partIds });
    return {
      content: [{ type: "text", text: `Isolated ${partIds.length} parts.` }],
      structuredContent: result,
    };
  });

  server.registerTool("assembly.clear_isolation", {
    description: "Clear the current isolation state.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
    },
  }, async ({ projectId }) => {
    const result = await executeInteraction(projectId, "clear-isolation");
    return {
      content: [{ type: "text", text: "Isolation cleared." }],
      structuredContent: result,
    };
  });

  server.registerTool("assembly.set_section_plane", {
    description: "Set the current section plane.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      axis: z.enum(["x", "y", "z"]),
      offset: z.number(),
      enabled: z.boolean().optional(),
    },
  }, async ({ projectId, axis, offset, enabled }) => {
    const result = await executeInteraction(projectId, "set-section-plane", { axis, offset, enabled });
    return {
      content: [{ type: "text", text: `Section plane set to ${axis.toUpperCase()} = ${offset}.` }],
      structuredContent: result,
    };
  });

  server.registerTool("assembly.clear_section_plane", {
    description: "Clear the current section plane.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
    },
  }, async ({ projectId }) => {
    const result = await executeInteraction(projectId, "clear-section-plane");
    return {
      content: [{ type: "text", text: "Section plane cleared." }],
      structuredContent: result,
    };
  });

  server.registerTool("assembly.get_base_part_candidates", {
    description: "Return the best base part candidates for assembly planning.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      topK: z.number().int().min(1).max(20).optional(),
    },
  }, async ({ projectId, topK }) => {
    const details = await resolveProject(projectId);
    const candidates = buildBasePartCandidates(details, { topK });
    return {
      content: [{ type: "text", text: `Returned ${candidates.length} base part candidates.` }],
      structuredContent: { projectId: details.manifest.projectId, candidates },
    };
  });

  server.registerTool("assembly.get_mating_candidates", {
    description: "Return candidate mating relations and candidate mating faces.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      partIds: z.array(z.string()).optional(),
      topK: z.number().int().min(1).max(128).optional(),
      facePairLimit: z.number().int().min(1).max(10).optional(),
    },
  }, async ({ projectId, partIds, topK, facePairLimit }) => {
    const details = await resolveProject(projectId);
    const candidates = buildMatingCandidates(details, { partIds, topK, facePairLimit });
    return {
      content: [{ type: "text", text: `Returned ${candidates.length} mating candidate pairs.` }],
      structuredContent: { projectId: details.manifest.projectId, candidates },
    };
  });

  server.registerTool("assembly.get_relative_transform", {
    description: "Return the relative transform between two parts.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      fromPartId: z.string(),
      toPartId: z.string(),
    },
  }, async ({ projectId, fromPartId, toPartId }) => {
    const details = await resolveProject(projectId);
    const transform = buildRelativeTransform(details, fromPartId, toPartId);
    return {
      content: [{ type: "text", text: `Relative transform from ${fromPartId} to ${toPartId} computed.` }],
      structuredContent: transform,
    };
  });

  server.registerTool("assembly.get_insertion_candidates", {
    description: "Return insertion candidates for a given part.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      partId: z.string(),
      referencePartId: z.string().optional(),
      topK: z.number().int().min(1).max(16).optional(),
    },
  }, async ({ projectId, partId, referencePartId, topK }) => {
    const details = await resolveProject(projectId);
    const candidates = buildInsertionCandidates(details, partId, { referencePartId, topK });
    return {
      content: [{ type: "text", text: `Returned ${candidates.length} insertion candidates.` }],
      structuredContent: { projectId: details.manifest.projectId, partId, candidates },
    };
  });

  server.registerTool("assembly.check_interference", {
    description: "Check interference between a moving part and fixed parts using proxy AABB.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      movingPartId: z.string(),
      fixedPartIds: z.array(z.string()).optional(),
      transform: z.object({
        translation: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
        quaternion: z.object({ x: z.number(), y: z.number(), z: z.number(), w: z.number() }).optional(),
      }).optional(),
    },
  }, async ({ projectId, movingPartId, fixedPartIds, transform }) => {
    const details = await resolveProject(projectId);
    const result = checkInterference(details, movingPartId, fixedPartIds, transform);
    return {
      content: [{ type: "text", text: result.hasInterference ? `Detected ${result.collisionCount} collisions.` : "No collision detected." }],
      structuredContent: result,
    };
  });

  server.registerTool("assembly.plan_sequence", {
    description: "Generate candidate assembly sequences and a precedence graph.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      rootAssemblyId: z.string().optional(),
      strategy: z.string().optional(),
      basePartId: z.string().optional(),
      maxSequences: z.number().int().min(1).max(10).optional(),
    },
  }, async ({ projectId, rootAssemblyId, strategy, basePartId, maxSequences }) => {
    const details = await resolveProject(projectId);
    const plan = buildSequencePlan(details, { rootAssemblyId, strategy, basePartId, maxSequences });
    return {
      content: [{ type: "text", text: `Generated ${plan.candidateSequences.length} candidate sequences.` }],
      structuredContent: plan,
    };
  });

  server.registerTool("assembly.explain_step", {
    description: "Explain one step from a candidate assembly sequence.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      sequenceId: z.string().optional(),
      stepIndex: z.number().int().min(1).optional(),
      rootAssemblyId: z.string().optional(),
      strategy: z.string().optional(),
      basePartId: z.string().optional(),
      maxSequences: z.number().int().min(1).max(10).optional(),
    },
  }, async ({ projectId, sequenceId, stepIndex, rootAssemblyId, strategy, basePartId, maxSequences }) => {
    const explanation = await buildExplainStepPayload(projectId, {
      sequenceId,
      stepIndex,
      rootAssemblyId,
      strategy,
      basePartId,
      maxSequences,
    });
    return {
      content: [{ type: "text", text: explanation.summary }],
      structuredContent: explanation,
    };
  });

  server.registerTool("assembly.capture_step_preview", {
    description: "Capture a before/after comparison image for one sequence step.",
    inputSchema: {
      projectId: z.string().uuid().optional(),
      sequenceId: z.string().optional(),
      stepIndex: z.number().int().min(1).optional(),
      rootAssemblyId: z.string().optional(),
      strategy: z.string().optional(),
      basePartId: z.string().optional(),
      maxSequences: z.number().int().min(1).max(10).optional(),
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      fit: z.boolean().optional(),
    },
  }, async ({ projectId, sequenceId, stepIndex, rootAssemblyId, strategy, basePartId, maxSequences, width, height, fit }) => {
    const artifact = await captureStepPreview(projectId, {
      sequenceId,
      stepIndex,
      rootAssemblyId,
      strategy,
      basePartId,
      maxSequences,
      width,
      height,
      fit,
    });
    return {
      content: [
        { type: "text", text: "Step preview generated." },
        { type: "resource_link", uri: artifact.resourceUri, name: "Step Preview", mimeType: artifact.mimeType },
      ],
      structuredContent: artifact,
    };
  });

  server.registerResource("session-manifest", "assembly://session/current/manifest", {
    mimeType: "application/json",
    description: "Current assembly manifest summary.",
  }, async () => ({
    contents: [{
      uri: "assembly://session/current/manifest",
      mimeType: "application/json",
      text: JSON.stringify(await buildSummary(), null, 2),
    }],
  }));

  server.registerResource("session-tree", "assembly://session/current/tree", {
    mimeType: "application/json",
    description: "Current assembly tree.",
  }, async () => ({
    contents: [{
      uri: "assembly://session/current/tree",
      mimeType: "application/json",
      text: JSON.stringify(await buildTreePayload(), null, 2),
    }],
  }));

  server.registerResource("session-color-map", new ResourceTemplate("assembly://session/current/color-map/{mode}", {}), {
    mimeType: "application/json",
    description: "Current color map.",
  }, async (_uri, variables) => {
    const mode = variables.mode === "id-mask" ? "id-mask" : "display";
    return {
      contents: [{
        uri: `assembly://session/current/color-map/${mode}`,
        mimeType: "application/json",
        text: JSON.stringify(await buildColorMap(undefined, mode), null, 2),
      }],
    };
  });

  server.registerResource("session-selection", "assembly://session/current/selection", {
    mimeType: "application/json",
    description: "Current workbench selection.",
  }, async () => {
    const rendererState = adapter.getRendererState ? await adapter.getRendererState() : null;
    return {
      contents: [{
        uri: "assembly://session/current/selection",
        mimeType: "application/json",
        text: JSON.stringify(rendererState?.selection || null, null, 2),
      }],
    };
  });

  server.registerResource("session-section", "assembly://session/current/section", {
    mimeType: "application/json",
    description: "Current workbench section state.",
  }, async () => {
    const rendererState = adapter.getRendererState ? await adapter.getRendererState() : null;
    return {
      contents: [{
        uri: "assembly://session/current/section",
        mimeType: "application/json",
        text: JSON.stringify(rendererState?.section || null, null, 2),
      }],
    };
  });

  server.registerResource("session-base-part-candidates", "assembly://session/current/base-part-candidates", {
    mimeType: "application/json",
    description: "Current base part candidate list.",
  }, async () => {
    const details = await resolveProject();
    const payload = {
      projectId: details.manifest.projectId,
      candidates: buildBasePartCandidates(details),
    };
    return {
      contents: [{
        uri: "assembly://session/current/base-part-candidates",
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      }],
    };
  });

  server.registerResource("session-mating-candidates", "assembly://session/current/mating-candidates", {
    mimeType: "application/json",
    description: "Current mating candidate list.",
  }, async () => {
    const details = await resolveProject();
    const payload = {
      projectId: details.manifest.projectId,
      candidates: buildMatingCandidates(details),
    };
    return {
      contents: [{
        uri: "assembly://session/current/mating-candidates",
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      }],
    };
  });

  server.registerResource("session-plan", "assembly://session/current/plan", {
    mimeType: "application/json",
    description: "Current candidate assembly plan.",
  }, async () => {
    const { details, plan } = await buildPlanPayload();
    return {
      contents: [{
        uri: "assembly://session/current/plan",
        mimeType: "application/json",
        text: JSON.stringify({ projectId: details.manifest.projectId, ...plan }, null, 2),
      }],
    };
  });

  server.registerResource("session-sequence-step", new ResourceTemplate("assembly://session/current/sequence/{sequenceId}/step/{stepIndex}", {}), {
    mimeType: "application/json",
    description: "Explain one step from the current candidate sequence.",
  }, async (_uri, variables) => {
    const explanation = await buildExplainStepPayload(undefined, {
      sequenceId: variables.sequenceId,
      stepIndex: Number(variables.stepIndex),
    });
    return {
      contents: [{
        uri: `assembly://session/current/sequence/${variables.sequenceId}/step/${variables.stepIndex}`,
        mimeType: "application/json",
        text: JSON.stringify(explanation, null, 2),
      }],
    };
  });

  server.registerResource("session-sequence-step-preview", new ResourceTemplate("assembly://session/current/sequence/{sequenceId}/step/{stepIndex}/preview.png", {}), {
    mimeType: "image/png",
    description: "Before/after comparison image for one assembly step.",
  }, async (_uri, variables) => {
    const artifact = await captureStepPreview(undefined, {
      sequenceId: variables.sequenceId,
      stepIndex: Number(variables.stepIndex),
    });
    const cached = await readCaptureResource(artifact.resourceUri, "beauty");
    return {
      contents: [{
        uri: artifact.resourceUri,
        mimeType: cached.mimeType,
        blob: cached.base64,
      }],
    };
  });

  server.registerResource("session-view-image", new ResourceTemplate("assembly://session/current/view/{kind}.png", {}), {
    mimeType: "image/png",
    description: "Current captured view resource.",
  }, async (_uri, variables) => {
    const kind = variables.kind === "id-mask" ? "id-mask" : "beauty";
    const uri =
      kind === "id-mask"
        ? "assembly://session/current/view/id-mask.png"
        : "assembly://session/current/view/beauty.png";
    const artifact = await readCaptureResource(uri, kind);
    return {
      contents: [{
        uri,
        mimeType: artifact.mimeType,
        blob: artifact.base64,
      }],
    };
  });

  server.registerResource("project-manifest", new ResourceTemplate("assembly://project/{projectId}/manifest", {}), {
    mimeType: "application/json",
    description: "Project manifest summary.",
  }, async (_uri, variables) => ({
    contents: [{
      uri: `assembly://project/${variables.projectId}/manifest`,
      mimeType: "application/json",
      text: JSON.stringify(await buildSummary(variables.projectId), null, 2),
    }],
  }));

  server.registerResource("project-tree", new ResourceTemplate("assembly://project/{projectId}/tree", {}), {
    mimeType: "application/json",
    description: "Project assembly tree.",
  }, async (_uri, variables) => ({
    contents: [{
      uri: `assembly://project/${variables.projectId}/tree`,
      mimeType: "application/json",
      text: JSON.stringify(await buildTreePayload(variables.projectId), null, 2),
    }],
  }));

  return server;
}

module.exports = {
  createMcpRuntime,
};
