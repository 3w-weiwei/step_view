const fs = require("fs/promises");
const path = require("path");
const net = require("net");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const PROJECT_ROOT = process.env.STEP_CAD_PROJECT_ROOT || path.join(__dirname, "project-data");
const TCP_HOST = process.env.STEP_CAD_VIEWER_HOST || "127.0.0.1";
const TCP_PORT = Number(process.env.STEP_CAD_VIEWER_PORT || 3100);

const DEFAULT_DIRECTIONS = [
  { name: "+x", vector: [1, 0, 0] },
  { name: "-x", vector: [-1, 0, 0] },
  { name: "+y", vector: [0, 1, 0] },
  { name: "-y", vector: [0, -1, 0] },
  { name: "+z", vector: [0, 0, 1] },
  { name: "-z", vector: [0, 0, -1] },
];

const DEFAULT_MULTIVIEWS = [
  { name: "iso", azimuth: 45, elevation: 30 },
  { name: "front", azimuth: 0, elevation: 0 },
  { name: "back", azimuth: 180, elevation: 0 },
  { name: "left", azimuth: 90, elevation: 0 },
  { name: "right", azimuth: -90, elevation: 0 },
  { name: "top", azimuth: 0, elevation: 90 },
  { name: "bottom", azimuth: 0, elevation: -90 },
];

const viewState = {
  projectId: null,
  colorMode: "face",
  transparency: new Map(),
  highlightedFaces: new Map(),
  explodedView: null,
};

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function normalizeVector(vector) {
  const values = Array.isArray(vector) ? vector.map(Number) : [0, 0, 0];
  const length = Math.hypot(values[0] || 0, values[1] || 0, values[2] || 0);
  if (!length) {
    return [1, 0, 0];
  }
  return [values[0] / length, values[1] / length, values[2] / length];
}

function dot(left, right) {
  return (left[0] || 0) * (right[0] || 0) + (left[1] || 0) * (right[1] || 0) + (left[2] || 0) * (right[2] || 0);
}

function vectorFromObject(value) {
  if (Array.isArray(value)) {
    return normalizeVector(value);
  }
  if (value && typeof value === "object") {
    return normalizeVector([value.x, value.y, value.z]);
  }
  return [0, 0, 1];
}

function centerVector(item) {
  const center = item?.center || item?.bbox?.center || {};
  return [Number(center.x || 0), Number(center.y || 0), Number(center.z || 0)];
}

function distanceBetweenCenters(left, right) {
  const a = centerVector(left);
  const b = centerVector(right);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function bboxGap(left, right) {
  const a = left?.bounds || left?.bbox;
  const b = right?.bounds || right?.bbox;
  if (!a || !b) {
    return Infinity;
  }
  const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
  const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
  const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
  return Math.hypot(dx, dy, dz);
}

function bboxOverlapRatio(left, right) {
  const a = left?.bounds || left?.bbox;
  const b = right?.bounds || right?.bbox;
  if (!a || !b) {
    return 0;
  }
  const overlapX = Math.max(0, Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x));
  const overlapY = Math.max(0, Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y));
  const overlapZ = Math.max(0, Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z));
  const overlapVolume = overlapX * overlapY * overlapZ;
  const aVolume = Math.max((a.size?.x || a.max.x - a.min.x) * (a.size?.y || a.max.y - a.min.y) * (a.size?.z || a.max.z - a.min.z), 1e-9);
  const bVolume = Math.max((b.size?.x || b.max.x - b.min.x) * (b.size?.y || b.max.y - b.min.y) * (b.size?.z || b.max.z - b.min.z), 1e-9);
  return round(overlapVolume / Math.min(aVolume, bVolume), 4);
}

function faceNormalAngle(left, right) {
  const a = vectorFromObject(left?.normal);
  const b = vectorFromObject(right?.normal);
  const value = Math.max(-1, Math.min(1, dot(a, b)));
  return round((Math.acos(value) * 180) / Math.PI, 2);
}

function projectBBoxInterval(bbox, direction) {
  if (!bbox) {
    return { min: 0, max: 0 };
  }
  const corners = [
    [bbox.min.x, bbox.min.y, bbox.min.z],
    [bbox.min.x, bbox.min.y, bbox.max.z],
    [bbox.min.x, bbox.max.y, bbox.min.z],
    [bbox.min.x, bbox.max.y, bbox.max.z],
    [bbox.max.x, bbox.min.y, bbox.min.z],
    [bbox.max.x, bbox.min.y, bbox.max.z],
    [bbox.max.x, bbox.max.y, bbox.min.z],
    [bbox.max.x, bbox.max.y, bbox.max.z],
  ];
  const projections = corners.map((corner) => dot(corner, direction));
  return { min: Math.min(...projections), max: Math.max(...projections) };
}

function bboxCrossSectionOverlap(left, right, direction) {
  const axis = direction.map(Math.abs);
  const primary = axis.indexOf(Math.max(...axis));
  const axes = [0, 1, 2].filter((item) => item !== primary);
  const names = ["x", "y", "z"];
  const a = left?.bbox;
  const b = right?.bbox;
  if (!a || !b) {
    return 0;
  }
  const overlaps = axes.map((axisIndex) => {
    const key = names[axisIndex];
    const overlap = Math.max(0, Math.min(a.max[key], b.max[key]) - Math.max(a.min[key], b.min[key]));
    const denom = Math.max(Math.min(a.size?.[key] || a.max[key] - a.min[key], b.size?.[key] || b.max[key] - b.min[key]), 1e-9);
    return overlap / denom;
  });
  return round(overlaps[0] * overlaps[1], 4);
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function listProjectIds() {
  const entries = await fs.readdir(PROJECT_ROOT, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function readProject(projectId) {
  const manifestPath = path.join(PROJECT_ROOT, projectId, "manifest.json");
  const assemblyPath = path.join(PROJECT_ROOT, projectId, "assembly.json");
  const manifest = await readJson(manifestPath);
  const assembly = manifest.status === "ready" ? await readJson(assemblyPath) : null;
  return { manifest, assembly };
}

async function resolveProject(projectId) {
  if (projectId) {
    return readProject(projectId);
  }
  const ids = await listProjectIds();
  const projects = await Promise.all(ids.map((id) => readProject(id).catch(() => null)));
  const ready = projects
    .filter((project) => project?.manifest?.status === "ready")
    .sort((a, b) => Date.parse(b.manifest.updatedAt || 0) - Date.parse(a.manifest.updatedAt || 0));
  if (!ready.length) {
    throw new Error("No ready STEP CAD project found.");
  }
  return ready[0];
}

function buildIndex(assembly) {
  const nodes = assembly?.nodes || [];
  const meshes = assembly?.meshes || [];
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const meshMap = new Map(meshes.map((mesh) => [mesh.id, mesh]));
  const faceMap = new Map();
  const faceOwner = new Map();

  for (const mesh of meshes) {
    for (const face of mesh.brepFaces || []) {
      faceMap.set(face.id, face);
      faceOwner.set(face.id, mesh.nodeId);
    }
  }

  for (const node of nodes) {
    for (const face of node.faces || []) {
      if (!faceMap.has(face.id)) {
        faceMap.set(face.id, face);
      }
      if (!faceOwner.has(face.id)) {
        faceOwner.set(face.id, node.id);
      }
    }
  }

  return {
    nodes,
    meshes,
    nodeMap,
    meshMap,
    faceMap,
    faceOwner,
    parts: nodes.filter((node) => node.kind === "part"),
    assemblies: nodes.filter((node) => node.kind === "assembly"),
  };
}

function compactPart(part) {
  return {
    id: part.id,
    name: part.name,
    path: part.pathNames || [],
    color: part.color,
    bbox: part.bbox,
    face_count: part.topology?.faceCount || (part.faces || []).length,
    triangle_count: part.topology?.triangleCount || 0,
    solid_count: part.topology?.solidCount || 0,
  };
}

function compactFace(face, ownerPartId) {
  return {
    id: face.id,
    name: face.name,
    part_id: ownerPartId,
    mesh_id: face.meshId,
    face_index: face.faceIndex,
    color: face.renderColor || face.color,
    center: face.center,
    normal: face.normal,
    area: face.area,
    bounds: face.bounds,
    triangle_first: face.triangleFirst,
    triangle_last: face.triangleLast,
    triangle_count: face.triangleCount,
  };
}

function buildContactCandidates(part, index, options = {}) {
  const maxPairs = options.maxPairs || 30;
  const maxDistance = Number(options.maxDistance ?? 2);
  const candidates = [];
  const sourceFaces = part.faces || [];

  for (const otherPart of index.parts) {
    if (otherPart.id === part.id) {
      continue;
    }

    const facePairs = [];
    for (const face of sourceFaces) {
      for (const otherFace of otherPart.faces || []) {
        const gap = bboxGap(face, otherFace);
        const centerDistance = distanceBetweenCenters(face, otherFace);
        if (gap > maxDistance && centerDistance > Math.max(maxDistance * 8, 10)) {
          continue;
        }

        const normalAngle = faceNormalAngle(face, otherFace);
        const opposingScore = Math.max(0, (normalAngle - 90) / 90);
        const parallelScore = Math.max(0, 1 - Math.min(normalAngle, 180 - normalAngle) / 25);
        const areaRatio = round(Math.min(face.area || 0, otherFace.area || 0) / Math.max(face.area || 1, otherFace.area || 1), 4);
        const overlapScore = bboxOverlapRatio(face, otherFace);
        const distanceScore = Math.max(0, 1 - gap / Math.max(maxDistance, 1e-6));
        const confidence = round(0.35 * distanceScore + 0.25 * Math.max(opposingScore, parallelScore) + 0.2 * areaRatio + 0.2 * overlapScore, 4);

        if (confidence < Number(options.minConfidence ?? 0.12)) {
          continue;
        }

        facePairs.push({
          face_id: face.id,
          other_face_id: otherFace.id,
          relation_type: opposingScore >= parallelScore ? "opposing_face_candidate" : "parallel_face_candidate",
          confidence,
          distance: round(gap),
          center_distance: round(centerDistance),
          normal_angle_deg: normalAngle,
          overlap_score: overlapScore,
          area_ratio: areaRatio,
        });
      }
    }

    if (facePairs.length) {
      facePairs.sort((a, b) => b.confidence - a.confidence);
      const best = facePairs[0];
      candidates.push({
        other_part_id: otherPart.id,
        other_part_name: otherPart.name,
        confidence: best.confidence,
        relation_type: best.relation_type,
        face_pairs: facePairs.slice(0, options.maxFacePairsPerPart || 8),
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates.slice(0, maxPairs);
}

function analyzeDirection(part, index, directionInput) {
  const direction = normalizeVector(directionInput);
  const sourceInterval = projectBBoxInterval(part.bbox, direction);
  const blockingParts = [];

  for (const otherPart of index.parts) {
    if (otherPart.id === part.id) {
      continue;
    }
    const otherInterval = projectBBoxInterval(otherPart.bbox, direction);
    const aheadDistance = otherInterval.min - sourceInterval.max;
    if (aheadDistance < -1e-6) {
      continue;
    }
    const crossSectionOverlap = bboxCrossSectionOverlap(part, otherPart, direction);
    if (crossSectionOverlap <= 0.01) {
      continue;
    }
    const confidence = round(Math.min(1, crossSectionOverlap * (1 / (1 + Math.max(0, aheadDistance) / 100)) * 1.25), 4);
    blockingParts.push({
      part_id: otherPart.id,
      part_name: otherPart.name,
      distance_along_direction: round(aheadDistance),
      cross_section_overlap: crossSectionOverlap,
      confidence,
    });
  }

  blockingParts.sort((a, b) => a.distance_along_direction - b.distance_along_direction || b.confidence - a.confidence);
  const strongest = blockingParts[0]?.confidence || 0;
  return {
    direction,
    result: blockingParts.length && strongest > 0.08 ? "blocked" : "clear",
    confidence: blockingParts.length ? strongest : 0.6,
    blocking_parts: blockingParts.slice(0, 12),
    method: "swept_bbox_projection_heuristic",
    limitations: [
      "This is a conservative geometric heuristic, not an exact motion-planning or CAD-kernel collision result.",
      "Fasteners, threads, press fits, and assembly constraints are not inferred unless visible in geometry.",
    ],
  };
}

function invokeViewer(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: TCP_HOST, port: TCP_PORT });
    const id = `mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Viewer TCP bridge timeout. Start the Electron viewer with npm start for image capture tools."));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "invoke", id, method, params })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const messages = buffer.split("\n");
      buffer = messages.pop() || "";
      for (const raw of messages) {
        if (!raw.trim()) {
          continue;
        }
        const message = JSON.parse(raw);
        if (message.id !== id) {
          continue;
        }
        clearTimeout(timer);
        socket.end();
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.result);
        }
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Viewer TCP bridge unavailable: ${error.message}. Start the Electron viewer with npm start for visual tools.`));
    });
  });
}

async function ensureViewerProject(projectId) {
  if (!projectId) {
    return;
  }
  try {
    await invokeViewer("loadProject", { projectId, route: "viz" }, 15000);
  } catch (error) {
    throw new Error(`Cannot load project in viewer: ${error.message}`);
  }
}

async function syncViewerVisualState(projectId) {
  await ensureViewerProject(projectId);
  if (viewState.colorMode !== "id_map") {
    await invokeViewer("setColorMode", { mode: viewState.colorMode });
  }
  await invokeViewer("setTransparency", {
    levels: Object.fromEntries(viewState.transparency),
    mode: "set",
  });
  await invokeViewer("highlightFaces", {
    highlights: Object.fromEntries(viewState.highlightedFaces),
    clearExisting: true,
  });
  await invokeViewer("setExplodedView", {
    explodedView: viewState.explodedView,
  });
}

const ProjectIdSchema = z.object({
  project_id: z.string().optional().describe("Project id. If omitted, the newest ready project is used."),
});

const PartIdSchema = ProjectIdSchema.extend({
  part_id: z.string().describe("Part/node id, for example node-2."),
});

const FaceIdSchema = ProjectIdSchema.extend({
  face_id: z.string().describe("BREP face id, for example mesh-0:face-12."),
});

const server = new McpServer(
  {
    name: "step-cad-assembly-tools",
    version: "0.1.0",
  },
  {
    instructions:
      "Use these tools as CAD fact extractors, view controllers, and geometry evidence generators. Contact and removability tools return heuristic candidates with confidence, not final mechanical engineering judgments.",
  },
);

server.registerTool(
  "cad_get_model_summary",
  {
    title: "Get STEP CAD Model Summary",
    description: "Return high-level model metadata, parser capability flags, bounds, and counts.",
    inputSchema: ProjectIdSchema,
  },
  async ({ project_id }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    return textResult({
      schema_version: "cad-mcp/v1",
      project: {
        id: manifest.projectId,
        name: manifest.projectName,
        source_file_name: manifest.sourceFileName,
        status: manifest.status,
        parser_mode: manifest.parserMode,
        geometry_mode: manifest.geometryMode,
        unit: manifest.unitLabel || assembly?.meta?.unitLabel || "mm",
      },
      capabilities: {
        has_triangulated_mesh: manifest.geometryMode === "triangulated-mesh",
        has_brep_faces: Boolean(assembly?.meshes?.some((mesh) => mesh.brepFaces?.length)),
        has_exact_contact_solver: false,
        has_exact_motion_planner: false,
      },
      stats: assembly?.stats || {
        partCount: manifest.partCount,
        assemblyCount: manifest.assemblyCount,
        faceCount: manifest.faceCount,
        solidCount: manifest.solidCount,
      },
      bounds: assembly?.bounds || manifest.bounds || null,
      view_state: {
        color_mode: viewState.colorMode,
        exploded_view: viewState.explodedView,
      },
    });
  },
);

server.registerTool(
  "cad_get_assembly_tree",
  {
    title: "Get Assembly Tree",
    description: "Return the model assembly hierarchy without heavy mesh arrays.",
    inputSchema: ProjectIdSchema,
  },
  async ({ project_id }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    return textResult({
      project_id: manifest.projectId,
      root_id: assembly.rootId,
      nodes: index.nodes.map((node) => ({
        id: node.id,
        parent_id: node.parentId,
        kind: node.kind,
        name: node.name,
        children: node.children || [],
        path: node.pathNames || [],
        bbox: node.bbox,
        face_count: node.topology?.faceCount || (node.faces || []).length,
      })),
    });
  },
);

server.registerTool(
  "cad_get_parts",
  {
    title: "Get Parts",
    description: "Return compact part-level facts for assembly reasoning.",
    inputSchema: ProjectIdSchema.extend({
      include_contact_preview: z.boolean().optional().describe("Include top neighbor/contact candidates per part."),
    }),
  },
  async ({ project_id, include_contact_preview }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    return textResult({
      project_id: manifest.projectId,
      parts: index.parts.map((part) => ({
        ...compactPart(part),
        contact_preview: include_contact_preview ? buildContactCandidates(part, index, { maxPairs: 5, maxFacePairsPerPart: 2 }) : undefined,
      })),
    });
  },
);

server.registerTool(
  "cad_get_part_faces",
  {
    title: "Get Part Faces",
    description: "Return BREP face facts for a part: ids, colors, centers, normals, areas, and triangle ranges.",
    inputSchema: PartIdSchema.extend({
      max_faces: z.number().int().positive().optional().describe("Optional limit for large parts."),
    }),
  },
  async ({ project_id, part_id, max_faces }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    const part = index.nodeMap.get(part_id);
    if (!part || part.kind !== "part") {
      throw new Error(`Part not found: ${part_id}`);
    }
    const faces = (part.faces || []).slice(0, max_faces || part.faces?.length || 0);
    return textResult({
      project_id: manifest.projectId,
      part: compactPart(part),
      faces: faces.map((face) => compactFace(face, part.id)),
      truncated: faces.length < (part.faces || []).length,
    });
  },
);

server.registerTool(
  "cad_get_face_detail",
  {
    title: "Get Face Detail",
    description: "Return one face with owning part and local contact candidates.",
    inputSchema: FaceIdSchema.extend({
      include_contact_candidates: z.boolean().optional(),
    }),
  },
  async ({ project_id, face_id, include_contact_candidates }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    const face = index.faceMap.get(face_id);
    if (!face) {
      throw new Error(`Face not found: ${face_id}`);
    }
    const partId = index.faceOwner.get(face_id);
    const part = index.nodeMap.get(partId);
    const contactCandidates = [];
    if (include_contact_candidates && part) {
      const partContacts = buildContactCandidates(part, index, { maxPairs: 12, maxFacePairsPerPart: 12 });
      for (const contact of partContacts) {
        const relatedPairs = contact.face_pairs.filter((pair) => pair.face_id === face_id || pair.other_face_id === face_id);
        if (relatedPairs.length) {
          contactCandidates.push({ ...contact, face_pairs: relatedPairs });
        }
      }
    }
    return textResult({
      project_id: manifest.projectId,
      part: part ? compactPart(part) : null,
      face: compactFace(face, partId),
      contact_candidates: contactCandidates,
    });
  },
);

server.registerTool(
  "cad_get_contact_candidates",
  {
    title: "Get Contact Candidates",
    description: "Return heuristic contact or mating-face candidates for one part. Results are candidates with confidence, not exact CAD contact facts.",
    inputSchema: PartIdSchema.extend({
      max_distance: z.number().nonnegative().optional(),
      min_confidence: z.number().min(0).max(1).optional(),
      max_pairs: z.number().int().positive().optional(),
    }),
  },
  async ({ project_id, part_id, max_distance, min_confidence, max_pairs }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    const part = index.nodeMap.get(part_id);
    if (!part || part.kind !== "part") {
      throw new Error(`Part not found: ${part_id}`);
    }
    return textResult({
      project_id: manifest.projectId,
      part: compactPart(part),
      method: "bbox_normal_area_heuristic",
      contact_candidates: buildContactCandidates(part, index, {
        maxDistance: max_distance,
        minConfidence: min_confidence,
        maxPairs: max_pairs,
      }),
    });
  },
);

server.registerTool(
  "cad_set_color_mode",
  {
    title: "Set Color Mode",
    description: "Set current visual color mode for later renders. Uses the live Electron viewer when available.",
    inputSchema: ProjectIdSchema.extend({
      mode: z.enum(["part", "face", "id_map"]).describe("part and face map to current viewer modes; id_map is recorded for evidence planning."),
    }),
  },
  async ({ project_id, mode }) => {
    const { manifest } = await resolveProject(project_id);
    viewState.projectId = manifest.projectId;
    viewState.colorMode = mode;
    let viewer_result = null;
    if (mode !== "id_map") {
      try {
        await ensureViewerProject(manifest.projectId);
        viewer_result = await invokeViewer("setColorMode", { mode });
      } catch (error) {
        viewer_result = { warning: error.message };
      }
    }
    return textResult({ success: true, project_id: manifest.projectId, color_mode: mode, viewer_result });
  },
);

server.registerTool(
  "cad_set_transparency",
  {
    title: "Set Transparency",
    description: "Set per-part transparency for visual evidence. Uses the live Electron viewer when available.",
    inputSchema: ProjectIdSchema.extend({
      part_ids: z.array(z.string()).describe("Part ids to make transparent."),
      level: z.number().min(0).max(1).describe("0 means opaque, 1 means fully transparent."),
      mode: z.enum(["set", "fade_others", "clear"]).optional(),
    }),
  },
  async ({ project_id, part_ids, level, mode }) => {
    const { manifest } = await resolveProject(project_id);
    viewState.projectId = manifest.projectId;
    if (mode === "clear") {
      viewState.transparency.clear();
    } else {
      for (const partId of part_ids) {
        viewState.transparency.set(partId, level);
      }
    }
    let viewer_result = null;
    try {
      await ensureViewerProject(manifest.projectId);
      viewer_result = await invokeViewer("setTransparency", {
        partIds: part_ids,
        level,
        mode: mode || "set",
        levels: Object.fromEntries(viewState.transparency),
      });
    } catch (error) {
      viewer_result = { warning: error.message };
    }
    return textResult({
      success: true,
      project_id: manifest.projectId,
      transparency: Object.fromEntries(viewState.transparency),
      viewer_result,
    });
  },
);

server.registerTool(
  "cad_highlight_faces",
  {
    title: "Highlight Faces",
    description: "Record face highlights for visual evidence and return face legend entries.",
    inputSchema: ProjectIdSchema.extend({
      face_ids: z.array(z.string()).describe("BREP face ids to highlight."),
      color: z.string().optional().describe("CSS hex color, for example #ffcc00."),
      clear_existing: z.boolean().optional(),
    }),
  },
  async ({ project_id, face_ids, color, clear_existing }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    if (clear_existing) {
      viewState.highlightedFaces.clear();
    }
    const legend = [];
    for (const faceId of face_ids) {
      const face = index.faceMap.get(faceId);
      if (!face) {
        legend.push({ face_id: faceId, error: "not_found" });
        continue;
      }
      const partId = index.faceOwner.get(faceId);
      viewState.highlightedFaces.set(faceId, color || "#f0b13f");
      legend.push({
        face_id: faceId,
        part_id: partId,
        part_name: index.nodeMap.get(partId)?.name,
        color: color || face.renderColor || face.color,
        center: face.center,
        normal: face.normal,
      });
    }
    let viewer_result = null;
    try {
      await ensureViewerProject(manifest.projectId);
      viewer_result = await invokeViewer("highlightFaces", {
        highlights: Object.fromEntries(viewState.highlightedFaces),
        clearExisting: true,
      });
    } catch (error) {
      viewer_result = { warning: error.message };
    }
    return textResult({
      success: true,
      project_id: manifest.projectId,
      highlighted_faces: Object.fromEntries(viewState.highlightedFaces),
      legend,
      viewer_result,
    });
  },
);

server.registerTool(
  "cad_set_exploded_view",
  {
    title: "Set Exploded View",
    description: "Record an exploded-view transform plan for assembly evidence. This is a view controller, not a geometry fact.",
    inputSchema: ProjectIdSchema.extend({
      direction: z.array(z.number()).length(3).describe("Explosion direction vector [x,y,z]."),
      factor: z.number().min(0).describe("Explosion scale factor."),
      scope: z.enum(["assembly", "selected", "part_neighbors"]).optional(),
      anchor_part_id: z.string().optional(),
      mode: z.enum(["linear", "radial", "hierarchy"]).optional(),
    }),
  },
  async ({ project_id, direction, factor, scope, anchor_part_id, mode }) => {
    const { manifest } = await resolveProject(project_id);
    viewState.projectId = manifest.projectId;
    viewState.explodedView = {
      direction: normalizeVector(direction),
      factor,
      scope: scope || "assembly",
      anchor_part_id: anchor_part_id || null,
      mode: mode || "linear",
    };
    let viewer_result = null;
    try {
      await ensureViewerProject(manifest.projectId);
      viewer_result = await invokeViewer("setExplodedView", {
        explodedView: viewState.explodedView,
      });
    } catch (error) {
      viewer_result = { warning: error.message };
    }
    return textResult({
      success: true,
      project_id: manifest.projectId,
      exploded_view: viewState.explodedView,
      viewer_result,
    });
  },
);

server.registerTool(
  "cad_render_multiview",
  {
    title: "Render Multiview Evidence",
    description: "Capture multiple views from the live Electron viewer. Start npm start first. Returns images plus CAD legend and active view state.",
    inputSchema: ProjectIdSchema.extend({
      views: z
        .array(
          z.object({
            name: z.string(),
            azimuth: z.number(),
            elevation: z.number(),
            distance: z.number().optional(),
            label: z.string().optional(),
          }),
        )
        .optional(),
      selected_part_ids: z.array(z.string()).optional(),
    }),
  },
  async ({ project_id, views, selected_part_ids }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    await syncViewerVisualState(manifest.projectId);
    if (selected_part_ids?.length) {
      await invokeViewer("selectParts", { partIds: selected_part_ids });
    }
    const result = await invokeViewer("captureMultiview", { angles: views || DEFAULT_MULTIVIEWS }, 60000);
    return textResult({
      success: true,
      project_id: manifest.projectId,
      render_mode: viewState.colorMode,
      view_state: {
        transparency: Object.fromEntries(viewState.transparency),
        highlighted_faces: Object.fromEntries(viewState.highlightedFaces),
        exploded_view: viewState.explodedView,
      },
      legend: index.parts.map((part) => ({
        part_id: part.id,
        name: part.name,
        color: part.color,
        face_count: part.topology?.faceCount || (part.faces || []).length,
      })),
      viewer_result: result,
    });
  },
);

server.registerTool(
  "cad_analyze_removal_directions",
  {
    title: "Analyze Removal Directions",
    description: "Check linear removal clearance candidates for a part. This is swept-bbox heuristic evidence, not a final removability verdict.",
    inputSchema: PartIdSchema.extend({
      directions: z.array(z.array(z.number()).length(3)).optional(),
    }),
  },
  async ({ project_id, part_id, directions }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    const part = index.nodeMap.get(part_id);
    if (!part || part.kind !== "part") {
      throw new Error(`Part not found: ${part_id}`);
    }
    const directionList = directions?.length ? directions.map((vector, i) => ({ name: `custom-${i + 1}`, vector })) : DEFAULT_DIRECTIONS;
    return textResult({
      project_id: manifest.projectId,
      part: compactPart(part),
      analyses: directionList.map((entry) => ({
        name: entry.name,
        ...analyzeDirection(part, index, entry.vector),
      })),
    });
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`STEP CAD MCP server running on stdio. Project root: ${PROJECT_ROOT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
