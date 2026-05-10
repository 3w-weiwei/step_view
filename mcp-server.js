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

const VIEW_PRESETS = {
  iso: { name: "iso", azimuth: 45, elevation: 30 },
  front: { name: "front", azimuth: 0, elevation: 0 },
  back: { name: "back", azimuth: 180, elevation: 0 },
  left: { name: "left", azimuth: 90, elevation: 0 },
  right: { name: "right", azimuth: -90, elevation: 0 },
  top: { name: "top", azimuth: 0, elevation: 90 },
  bottom: { name: "bottom", azimuth: 0, elevation: -90 },
};

const viewState = {
  projectId: null,
  colorMode: "part",
  transparency: new Map(),
  highlightedFaces: new Map(),
  explodedView: null,
  partTransforms: new Map(),
  section: {
    enabled: false,
    axis: "x",
    offset: 0,
  },
};

function resetViewState({ keepColorMode = true } = {}) {
  const colorMode = viewState.colorMode;
  viewState.transparency.clear();
  viewState.highlightedFaces.clear();
  viewState.explodedView = null;
  viewState.partTransforms.clear();
  viewState.section = {
    enabled: false,
    axis: "x",
    offset: 0,
  };
  if (!keepColorMode) {
    viewState.colorMode = "part";
  } else {
    viewState.colorMode = colorMode;
  }
}

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

function evidenceResult(payload, images = []) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
      ...images
        .filter((image) => image?.image)
        .map((image) => ({
          type: "image",
          data: image.image,
          mimeType: image.mimeType || "image/png",
        })),
    ],
  };
}

async function saveEvidenceImage(projectId, imageBase64, label = "view") {
  if (!imageBase64) {
    return null;
  }
  const safeProjectId = String(projectId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeLabel = String(label || "view").replace(/[^a-zA-Z0-9_-]/g, "_");
  const evidenceDir = path.join(PROJECT_ROOT, safeProjectId, "visual-evidence");
  await fs.mkdir(evidenceDir, { recursive: true });
  const filePath = path.join(evidenceDir, `${Date.now()}-${safeLabel}.png`);
  await fs.writeFile(filePath, Buffer.from(imageBase64, "base64"));
  return filePath;
}

function evidenceMeta(evidence) {
  return {
    camera: evidence.camera,
    view: evidence.view,
    has_image: Boolean(evidence.image),
    image_path: evidence.imagePath || null,
    image_mime_type: evidence.mimeType || "image/png",
    warning: evidence.warning || null,
  };
}

const DEFAULT_PART_MULTIVIEW = [
  { name: "front-1", azimuth: 0, elevation: 10 },
  { name: "front-2", azimuth: 30, elevation: 20 },
  { name: "front-3", azimuth: -30, elevation: 20 },
  { name: "front-4", azimuth: 0, elevation: 35 },
  { name: "back-1", azimuth: 180, elevation: 10 },
  { name: "back-2", azimuth: 150, elevation: 20 },
  { name: "back-3", azimuth: 210, elevation: 20 },
  { name: "back-4", azimuth: 180, elevation: 35 },
];

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

function dominantAxisFromVector(vector) {
  const normalized = normalizeVector(vector);
  const abs = normalized.map(Math.abs);
  const index = abs.indexOf(Math.max(...abs));
  return ["x", "y", "z"][index] || "x";
}

function axisOffsetFromPoint(axis, point) {
  const index = { x: 0, y: 1, z: 2 }[axis] ?? 0;
  return round(point?.[index] || 0, 4);
}

function viewFromDirection(direction, distance) {
  const v = normalizeVector(direction);
  let azimuth = (Math.atan2(v[0], -v[1]) * 180) / Math.PI;
  if (azimuth < 0) {
    azimuth += 360;
  }
  const elevation = (Math.asin(v[2]) * 180) / Math.PI;
  return {
    azimuth: round(azimuth, 1),
    elevation: round(Math.max(-75, Math.min(75, elevation)), 1),
    distance,
  };
}

function humanViewForTarget(target, assembly, options = {}) {
  const size = assembly?.bounds?.size || { x: 100, y: 100, z: 100 };
  const distance = options.distance || Math.max(Math.hypot(size.x || 0, size.y || 0, size.z || 0) * 1.8, 120);
  const normal = target?.normal ? vectorFromObject(target.normal) : null;
  if (normal) {
    const viewDirection = normalizeVector([-normal[0] * 0.85 + 0.35, -normal[1] * 0.85 - 0.25, Math.abs(normal[2]) < 0.7 ? 0.45 : normal[2] * 0.55]);
    return viewFromDirection(viewDirection, distance);
  }
  return { preset: "iso", distance };
}

function bestSectionForFace(face, assembly) {
  const normal = vectorFromObject(face?.normal);
  const axis = dominantAxisFromVector(normal);
  const center = centerVector(face);
  const modelSize = assembly?.bounds?.size || {};
  const axisSize = Number(modelSize[axis] || 100);
  const inwardBias = Math.max(axisSize * 0.015, 0.5);
  const axisIndex = { x: 0, y: 1, z: 2 }[axis] ?? 0;
  const offset = center[axisIndex] - Math.sign(normal[axisIndex] || 1) * inwardBias;
  return {
    enabled: true,
    axis,
    offset: round(offset, 4),
    strategy: "face_normal_dominant_axis",
  };
}

function bestSectionForContactPair(pair, index, assembly) {
  const firstFace = pair?.contact_faces?.[0] || pair?.face_pairs?.[0];
  const faceA = firstFace ? index.faceMap.get(firstFace.face_id) : null;
  const faceB = firstFace ? index.faceMap.get(firstFace.other_face_id) : null;
  if (!faceA || !faceB) {
    return { enabled: true, axis: "x", offset: assembly?.bounds?.center?.x || 0, strategy: "model_center_fallback" };
  }
  const centerA = centerVector(faceA);
  const centerB = centerVector(faceB);
  const between = [
    (centerA[0] + centerB[0]) / 2,
    (centerA[1] + centerB[1]) / 2,
    (centerA[2] + centerB[2]) / 2,
  ];
  const connector = [centerB[0] - centerA[0], centerB[1] - centerA[1], centerB[2] - centerA[2]];
  const axis = dominantAxisFromVector(Math.hypot(...connector) > 1e-6 ? connector : vectorFromObject(faceA.normal));
  return {
    enabled: true,
    axis,
    offset: axisOffsetFromPoint(axis, between),
    strategy: "contact_midplane_dominant_axis",
  };
}

function humanViewForPart(part, assembly) {
  if (!part?.bbox?.center || !assembly?.bounds?.center) {
    return humanViewForTarget(null, assembly);
  }
  const direction = normalizeVector([
    part.bbox.center.x - assembly.bounds.center.x + 0.25,
    part.bbox.center.y - assembly.bounds.center.y - 0.25,
    Math.max(0.35, part.bbox.center.z - assembly.bounds.center.z),
  ]);
  const size = assembly.bounds.size || { x: 100, y: 100, z: 100 };
  const distance = Math.max(Math.hypot(size.x || 0, size.y || 0, size.z || 0) * 1.8, 120);
  return viewFromDirection(direction, distance);
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

function findClearanceDirections(part, index, directions = DEFAULT_DIRECTIONS) {
  return directions
    .map((entry, itemIndex) => {
      const vector = Array.isArray(entry) ? entry : entry.vector;
      return {
        name: Array.isArray(entry) ? `custom-${itemIndex + 1}` : entry.name,
        ...analyzeDirection(part, index, vector),
      };
    })
    .sort((left, right) => {
      const leftBlocked = left.result === "blocked" ? 1 : 0;
      const rightBlocked = right.result === "blocked" ? 1 : 0;
      return leftBlocked - rightBlocked || right.confidence - left.confidence || left.blocking_parts.length - right.blocking_parts.length;
    });
}

function computeMoveAnalysis(part, index, direction, distance) {
  const base = analyzeDirection(part, index, direction);
  const maxBlockingDistance = Math.max(0, Number(distance) || 0);
  const relevantBlockers = base.blocking_parts.filter((blocker) => blocker.distance_along_direction <= maxBlockingDistance);
  return {
    ...base,
    requested_distance: round(distance),
    result: relevantBlockers.length ? "blocked" : base.result === "blocked" ? "likely_clear_with_later_blocker" : "likely_clear",
    blocking_parts_within_distance: relevantBlockers,
  };
}

function computeDisassemblyTransforms(index, assembly, factor = 1) {
  const bounds = assembly?.bounds || {};
  const center = bounds.center || { x: 0, y: 0, z: 0 };
  const size = bounds.size || { x: 100, y: 100, z: 100 };
  const baseDistance = Math.max(Math.hypot(size.x || 0, size.y || 0, size.z || 0) * 0.28, 25) * factor;
  const transforms = {};
  const plan = [];

  for (const part of index.parts) {
    const analyses = findClearanceDirections(part, index);
    const clear = analyses.find((item) => item.result !== "blocked") || analyses[0];
    const partCenter = part.bbox?.center || center;
    const outward = normalizeVector([partCenter.x - center.x, partCenter.y - center.y, partCenter.z - center.z]);
    const chosen = clear?.result !== "blocked" ? clear.direction : outward;
    const outwardWeight = Math.max(0, dot(chosen, outward));
    const direction = normalizeVector([
      chosen[0] * 0.72 + outward[0] * (0.28 + outwardWeight * 0.2),
      chosen[1] * 0.72 + outward[1] * (0.28 + outwardWeight * 0.2),
      chosen[2] * 0.72 + outward[2] * (0.28 + outwardWeight * 0.2),
    ]);
    const smallPartBoost = Math.max(0, 1 - Math.cbrt(Math.max((part.bbox?.size?.x || 1) * (part.bbox?.size?.y || 1) * (part.bbox?.size?.z || 1), 1)) / Math.max(Math.cbrt((size.x || 1) * (size.y || 1) * (size.z || 1)), 1));
    const distance = baseDistance * (0.75 + smallPartBoost * 0.8 + Math.max(0, Number(part.depth || 0)) * 0.08);
    transforms[part.id] = direction.map((value) => round(value * distance, 4));
    plan.push({
      part_id: part.id,
      part_name: part.name,
      direction,
      distance: round(distance),
      clearance_result: clear?.result || "unknown",
      blocking_parts: clear?.blocking_parts?.slice(0, 4) || [],
    });
  }

  return { transforms, plan };
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
  await invokeViewer("setPartTransforms", {
    transforms: Object.fromEntries(viewState.partTransforms),
  });
  await invokeViewer("setSection", viewState.section);
}

async function captureViewerEvidence(projectId, view = {}) {
  await syncViewerVisualState(projectId);
  if (view.preset && VIEW_PRESETS[view.preset]) {
    const preset = VIEW_PRESETS[view.preset];
    await invokeViewer("setCamera", {
      azimuth: preset.azimuth,
      elevation: preset.elevation,
      distance: view.distance,
      roll: view.roll || 0,
    });
  } else if (view.azimuth !== undefined || view.elevation !== undefined || view.distance !== undefined) {
    const current = await invokeViewer("getCamera").catch(() => ({ params: {} }));
    await invokeViewer("setCamera", {
      azimuth: view.azimuth ?? current.params?.azimuth ?? 45,
      elevation: view.elevation ?? current.params?.elevation ?? 30,
      distance: view.distance ?? current.params?.distance ?? 200,
      roll: view.roll ?? current.params?.roll ?? 0,
    });
  } else {
    await invokeViewer("fit");
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  const screenshot = await invokeViewer("captureScreenshot", {}, 30000);
  const camera = await invokeViewer("getCamera").catch(() => null);
  const rawImage = screenshot?.image || "";
  const image = rawImage.startsWith("data:image") ? rawImage.split(",")[1] : rawImage;
  const imagePath = image ? await saveEvidenceImage(projectId, image, view.preset || view.name || "current") : null;
  return {
    image,
    imagePath,
    mimeType: screenshot?.mimeType || "image/png",
    camera: camera?.params || null,
    view: view.preset || view.name || "current",
    warning: screenshot?.error || (!image ? "Viewer returned no screenshot image. Check that the Electron viewer is running, the project is loaded, and the canvas is visible." : null),
  };
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

const ViewSchema = z.object({
  preset: z.enum(["iso", "front", "back", "left", "right", "top", "bottom"]).optional(),
  azimuth: z.number().optional(),
  elevation: z.number().optional(),
  distance: z.number().optional(),
  roll: z.number().optional(),
}).optional();

const server = new McpServer(
  {
    name: "step-cad-assembly-tools",
    version: "0.1.0",
  },
  {
    instructions:
      "这些工具用于 CAD 事实提取、视角控制和几何证据生成。接触、拆卸和避碰相关工具返回的是启发式候选、置信度和视觉证据，不等同于精确 CAD 内核或工程结论。",
  },
);

server.registerTool(
  "cad_get_model_summary",
  {
    title: "获取 STEP CAD 模型摘要",
    description: "返回模型元数据、解析能力标记、包围盒、零件数、面数等高层信息。",
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
    title: "获取装配树",
    description: "返回模型装配层级结构，不包含沉重的网格数组。",
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
    title: "获取零件列表",
    description: "返回用于装配推理的零件级概要信息，包括名称、包围盒、颜色和面数量。",
    inputSchema: ProjectIdSchema.extend({
      include_contact_preview: z.boolean().optional().describe("是否包含每个零件的主要邻近/接触候选。"),
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
    title: "获取零件 BREP 面",
    description: "返回指定零件的 BREP 面信息，包括 face_id、颜色、中心点、法向、面积和三角片范围。",
    inputSchema: PartIdSchema.extend({
      max_faces: z.number().int().positive().optional().describe("大型零件可用该参数限制返回的面数量。"),
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
    title: "获取面详情",
    description: "返回指定 BREP 面的详细信息、所属零件，以及可选的局部接触候选。",
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
    title: "获取接触候选",
    description: "返回指定零件的启发式接触/配合面候选。结果包含置信度，不代表精确 CAD 接触判定。",
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
  "cad_get_contact_pairs",
  {
    title: "获取接触零件对",
    description: "返回零件对级别的接触候选，以及代表性的接触面信息。这是启发式证据，不是精确接触求解器。",
    inputSchema: ProjectIdSchema.extend({
      part_id: z.string().optional().describe("可选零件 ID。不填则返回整个装配体的主要接触零件对。"),
      max_distance: z.number().nonnegative().optional(),
      min_confidence: z.number().min(0).max(1).optional(),
      max_pairs: z.number().int().positive().optional(),
    }),
  },
  async ({ project_id, part_id, max_distance, min_confidence, max_pairs }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    const pairs = [];
    const seen = new Set();
    const parts = part_id ? [index.nodeMap.get(part_id)].filter(Boolean) : index.parts;

    for (const part of parts) {
      if (!part || part.kind !== "part") {
        continue;
      }
      const candidates = buildContactCandidates(part, index, {
        maxDistance: max_distance,
        minConfidence: min_confidence,
        maxPairs: max_pairs || 200,
      });
      for (const candidate of candidates) {
        const key = [part.id, candidate.other_part_id].sort().join("::");
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        pairs.push({
          part_a: { id: part.id, name: part.name },
          part_b: { id: candidate.other_part_id, name: candidate.other_part_name },
          confidence: candidate.confidence,
          relation_type: candidate.relation_type,
          contact_faces: candidate.face_pairs,
        });
      }
    }

    pairs.sort((a, b) => b.confidence - a.confidence);
    return textResult({
      project_id: manifest.projectId,
      method: "bbox_normal_area_heuristic",
      contact_pairs: pairs.slice(0, max_pairs || 50),
    });
  },
);

server.registerTool(
  "cad_set_color_mode",
  {
    title: "设置着色模式",
    description: "设置当前可视化着色模式，用于后续截图。若 Electron viewer 正在运行，会同步到实时视图。",
    inputSchema: ProjectIdSchema.extend({
      mode: z.enum(["part", "face", "id_map"]).describe("part 表示零件级着色，face 表示 BREP 面级着色，id_map 用于后续机器可读图规划。"),
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
  "cad_reset_view_state",
  {
    title: "还原视图状态和零件位置",
    description: "清除透明度、高亮面、爆炸视图、零件移动预览和剖切状态，并可选返回还原后的截图。",
    inputSchema: ProjectIdSchema.extend({
      keep_color_mode: z.boolean().optional().describe("是否保留当前着色模式，默认 true。"),
      return_image: z.boolean().optional().describe("是否返回还原后的截图，默认 true。"),
      view: ViewSchema,
    }),
  },
  async ({ project_id, keep_color_mode, return_image, view }) => {
    const { manifest } = await resolveProject(project_id);
    viewState.projectId = manifest.projectId;
    resetViewState({ keepColorMode: keep_color_mode !== false });
    await syncViewerVisualState(manifest.projectId);
    const payload = {
      success: true,
      project_id: manifest.projectId,
      view_state: {
        color_mode: viewState.colorMode,
        transparency: Object.fromEntries(viewState.transparency),
        highlighted_faces: Object.fromEntries(viewState.highlightedFaces),
        exploded_view: viewState.explodedView,
        part_transforms: Object.fromEntries(viewState.partTransforms),
        section: viewState.section,
      },
    };
    if (return_image !== false) {
      const evidence = await captureViewerEvidence(manifest.projectId, view || { preset: "iso" });
      return evidenceResult({ ...payload, evidence: evidenceMeta(evidence) }, [evidence]);
    }
    return textResult(payload);
  },
);

server.registerTool(
  "cad_set_transparency",
  {
    title: "设置零件透明度并返回证据图",
    description: "设置指定零件透明度，并默认返回应用后的截图证据。",
    inputSchema: ProjectIdSchema.extend({
      part_ids: z.array(z.string()).describe("需要设置透明度的零件 ID。"),
      level: z.number().min(0).max(1).describe("透明度等级，0 表示不透明，1 表示完全透明。"),
      mode: z.enum(["set", "fade_others", "clear"]).optional(),
      return_image: z.boolean().optional().describe("是否在设置后返回截图，默认 true。"),
      view: ViewSchema,
    }),
  },
  async ({ project_id, part_ids, level, mode, return_image, view }) => {
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
    const payload = {
      success: true,
      project_id: manifest.projectId,
      transparency: Object.fromEntries(viewState.transparency),
      viewer_result,
    };
    if (return_image !== false) {
      const evidence = await captureViewerEvidence(manifest.projectId, view || { preset: "iso" });
      return evidenceResult({ ...payload, evidence: evidenceMeta(evidence) }, [evidence]);
    }
    return textResult(payload);
  },
);

server.registerTool(
  "cad_highlight_faces",
  {
    title: "高亮 BREP 面",
    description: "高亮指定 BREP 面，并返回高亮图例信息。",
    inputSchema: ProjectIdSchema.extend({
      face_ids: z.array(z.string()).describe("需要高亮的 BREP face_id 列表。"),
      color: z.string().optional().describe("高亮颜色，例如 #ffcc00。"),
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
    title: "设置爆炸视图并返回证据图",
    description: "应用统一方向/径向/层级爆炸视图，并默认返回截图。这是视图控制，不是几何事实。",
    inputSchema: ProjectIdSchema.extend({
      direction: z.array(z.number()).length(3).describe("爆炸方向向量 [x,y,z]。"),
      factor: z.number().min(0).describe("爆炸缩放系数。"),
      scope: z.enum(["assembly", "selected", "part_neighbors"]).optional(),
      anchor_part_id: z.string().optional(),
      mode: z.enum(["linear", "radial", "hierarchy"]).optional(),
      return_image: z.boolean().optional().describe("是否在设置后返回截图，默认 true。"),
      view: ViewSchema,
    }),
  },
  async ({ project_id, direction, factor, scope, anchor_part_id, mode, return_image, view }) => {
    const { manifest } = await resolveProject(project_id);
    viewState.projectId = manifest.projectId;
    viewState.explodedView = {
      direction: normalizeVector(direction),
      factor,
      scope: scope || "assembly",
      anchor_part_id: anchor_part_id || null,
      mode: mode || "linear",
    };
    viewState.partTransforms.clear();
    let viewer_result = null;
    try {
      await ensureViewerProject(manifest.projectId);
      viewer_result = await invokeViewer("setExplodedView", {
        explodedView: viewState.explodedView,
      });
    } catch (error) {
      viewer_result = { warning: error.message };
    }
    const payload = {
      success: true,
      project_id: manifest.projectId,
      exploded_view: viewState.explodedView,
      viewer_result,
    };
    if (return_image !== false) {
      const evidence = await captureViewerEvidence(manifest.projectId, view || { preset: "iso" });
      return evidenceResult({ ...payload, evidence: evidenceMeta(evidence) }, [evidence]);
    }
    return textResult(payload);
  },
);

server.registerTool(
  "cad_render_multiview",
  {
    title: "渲染多视角证据图",
    description: "从实时 Electron viewer 捕获多个视角图片，返回图片、图例和当前视图状态。使用前需启动 npm start。",
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
    const viewsWithImages = [];
    for (const view of result.views || []) {
      const imagePath = await saveEvidenceImage(manifest.projectId, view.image, view.name);
      viewsWithImages.push({ ...view, imagePath });
    }
    const images = viewsWithImages.map((view) => ({
      image: view.image,
      mimeType: "image/png",
      name: view.name,
    }));
    return evidenceResult({
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
      views: viewsWithImages.map((view) => ({
        name: view.name,
        label: view.label,
        azimuth: view.azimuth,
        elevation: view.elevation,
        has_image: Boolean(view.image),
        image_path: view.imagePath || null,
      })),
    }, images);
  },
);

server.registerTool(
  "cad_render_part_multiview",
  {
    title: "零件八视角渲染",
    description: "收集指定零件的 8 张渲染图，前后各 4 张，固定 256x256，并返回图像与路径作为证据。",
    inputSchema: ProjectIdSchema.extend({
      part_id: z.string().describe("Part/node id, for example node-2."),
      size: z.number().int().positive().max(1024).optional(),
      views: z
        .array(
          z.object({
            name: z.string(),
            azimuth: z.number(),
            elevation: z.number(),
            label: z.string().optional(),
          }),
        )
        .optional(),
    }),
  },
  async ({ project_id, part_id, size, views }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    const part = index.nodeMap.get(part_id);
    if (!part || part.kind !== "part") {
      throw new Error(`Part not found: ${part_id}`);
    }

    const result = await invokeViewer(
      "capturePartMultiview",
      {
        partId: part_id,
        size: size || 256,
        angles: views || DEFAULT_PART_MULTIVIEW,
      },
      60000,
    );
    const viewsWithImages = [];
    for (const view of result.views || []) {
      const imagePath = await saveEvidenceImage(manifest.projectId, view.image, `${part_id}-${view.name}`);
      viewsWithImages.push({ ...view, imagePath });
    }
    const images = viewsWithImages.map((view) => ({
      image: view.image,
      mimeType: "image/png",
      name: view.name,
    }));

    return evidenceResult({
      success: true,
      project_id: manifest.projectId,
      part: compactPart(part),
      size: size || 256,
      views: viewsWithImages.map((view) => ({
        name: view.name,
        label: view.label,
        azimuth: view.azimuth,
        elevation: view.elevation,
        width: view.width || size || 256,
        height: view.height || size || 256,
        has_image: Boolean(view.image),
        image_path: view.imagePath || null,
      })),
    }, images);
  },
);

server.registerTool(
  "cad_render_view",
  {
    title: "渲染单视角证据图",
    description: "设置固定视角或自定义相机并返回截图，是 Agent 获取视觉证据的主要视角控制工具。",
    inputSchema: ProjectIdSchema.extend({
      view: ViewSchema.describe("可使用 preset 固定视角，也可使用 azimuth/elevation/distance 自主控制相机。"),
      selected_part_ids: z.array(z.string()).optional(),
      color_mode: z.enum(["part", "face", "id_map"]).optional(),
    }),
  },
  async ({ project_id, view, selected_part_ids, color_mode }) => {
    const { manifest } = await resolveProject(project_id);
    if (color_mode) {
      viewState.colorMode = color_mode;
    }
    await syncViewerVisualState(manifest.projectId);
    if (selected_part_ids?.length) {
      await invokeViewer("selectParts", { partIds: selected_part_ids });
    }
    const evidence = await captureViewerEvidence(manifest.projectId, view || { preset: "iso" });
    return evidenceResult({
      success: true,
      project_id: manifest.projectId,
      render_mode: viewState.colorMode,
      view_state: {
        transparency: Object.fromEntries(viewState.transparency),
        highlighted_faces: Object.fromEntries(viewState.highlightedFaces),
        exploded_view: viewState.explodedView,
        part_transforms: Object.fromEntries(viewState.partTransforms),
        section: viewState.section,
      },
      evidence: evidenceMeta(evidence),
    }, [evidence]);
  },
);

server.registerTool(
  "cad_render_section_view",
  {
    title: "渲染剖切视图证据图",
    description: "启用剖切平面并返回截图，用于观察内部结构或接触区域。",
    inputSchema: ProjectIdSchema.extend({
      enabled: z.boolean().optional(),
      axis: z.enum(["x", "y", "z"]).optional(),
      offset: z.number().optional().describe("剖切平面偏移量，单位为模型单位。"),
      view: ViewSchema,
      selected_part_ids: z.array(z.string()).optional(),
    }),
  },
  async ({ project_id, enabled, axis, offset, view, selected_part_ids }) => {
    const { manifest } = await resolveProject(project_id);
    viewState.projectId = manifest.projectId;
    viewState.section = {
      enabled: enabled !== false,
      axis: axis || viewState.section.axis || "x",
      offset: Number(offset ?? viewState.section.offset ?? 0),
    };
    await syncViewerVisualState(manifest.projectId);
    if (selected_part_ids?.length) {
      await invokeViewer("selectParts", { partIds: selected_part_ids });
    }
    const evidence = await captureViewerEvidence(manifest.projectId, view || { preset: "iso" });
    return evidenceResult({
      success: true,
      project_id: manifest.projectId,
      section: viewState.section,
      evidence: evidenceMeta(evidence),
    }, [evidence]);
  },
);

server.registerTool(
  "cad_render_target_section",
  {
    title: "自动渲染目标剖切证据图",
    description: "根据目标面或接触零件对自动选择剖切平面和符合人类习惯的观察视角，用于查看目标内部。",
    inputSchema: ProjectIdSchema.extend({
      face_id: z.string().optional(),
      part_id: z.string().optional(),
      other_part_id: z.string().optional(),
      mode: z.enum(["through_face", "near_face", "contact_pair"]).optional(),
      view: ViewSchema,
    }),
  },
  async ({ project_id, face_id, part_id, other_part_id, mode, view }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    let section = null;
    let targetFace = null;
    let contactPair = null;

    if (face_id) {
      targetFace = index.faceMap.get(face_id);
      if (!targetFace) {
        throw new Error(`Face not found: ${face_id}`);
      }
      section = bestSectionForFace(targetFace, assembly);
    } else if (part_id && other_part_id) {
      const part = index.nodeMap.get(part_id);
      if (!part || part.kind !== "part") {
        throw new Error(`Part not found: ${part_id}`);
      }
      contactPair = buildContactCandidates(part, index, { maxPairs: 50 }).find((candidate) => candidate.other_part_id === other_part_id);
      if (!contactPair) {
        throw new Error(`No contact candidate found for ${part_id} and ${other_part_id}`);
      }
      section = bestSectionForContactPair(contactPair, index, assembly);
      const firstPair = contactPair.contact_faces?.[0] || contactPair.face_pairs?.[0];
      targetFace = firstPair ? index.faceMap.get(firstPair.face_id) : null;
    } else if (part_id) {
      const part = index.nodeMap.get(part_id);
      if (!part || part.kind !== "part") {
        throw new Error(`Part not found: ${part_id}`);
      }
      const largestFace = [...(part.faces || [])].sort((a, b) => (b.area || 0) - (a.area || 0))[0];
      targetFace = largestFace || null;
      section = largestFace
        ? bestSectionForFace(largestFace, assembly)
        : { enabled: true, axis: "x", offset: part.bbox?.center?.x || 0, strategy: "part_center_fallback" };
    } else {
      throw new Error("Provide face_id, part_id, or part_id + other_part_id.");
    }

    viewState.projectId = manifest.projectId;
    viewState.section = section;
    if (targetFace) {
      viewState.highlightedFaces.set(targetFace.id, "#ffcc00");
    }
    const autoView = view || humanViewForTarget(targetFace, assembly);
    const evidence = await captureViewerEvidence(manifest.projectId, autoView);
    return evidenceResult({
      success: true,
      project_id: manifest.projectId,
      mode: mode || (contactPair ? "contact_pair" : "near_face"),
      section,
      target: {
        face_id: targetFace?.id || null,
        part_id: targetFace ? index.faceOwner.get(targetFace.id) : part_id || null,
        other_part_id: other_part_id || null,
      },
      contact_pair: contactPair || null,
      evidence: { ...evidenceMeta(evidence), auto_view_used: !view },
    }, [evidence]);
  },
);

server.registerTool(
  "cad_find_clearance_directions",
  {
    title: "查找可能无碰撞的移动方向",
    description: "使用扫掠包围盒启发式方法，对零件可能无碰撞移动的方向进行排序。",
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
    return textResult({
      project_id: manifest.projectId,
      part: compactPart(part),
      directions: findClearanceDirections(part, index, directions || DEFAULT_DIRECTIONS),
    });
  },
);

server.registerTool(
  "cad_render_move_preview",
  {
    title: "渲染零件移动预览证据图",
    description: "将指定零件沿给定方向移动指定距离，返回移动后的截图和可能阻挡零件分析。该工具会自动关闭剖切状态。",
    inputSchema: PartIdSchema.extend({
      direction: z.array(z.number()).length(3),
      distance: z.number().positive(),
      fade_context_level: z.number().min(0).max(1).optional(),
      view: ViewSchema,
    }),
  },
  async ({ project_id, part_id, direction, distance, fade_context_level, view }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    const part = index.nodeMap.get(part_id);
    if (!part || part.kind !== "part") {
      throw new Error(`Part not found: ${part_id}`);
    }
    const normalized = normalizeVector(direction);
    const moveVector = normalized.map((value) => round(value * distance, 4));
    const analysis = computeMoveAnalysis(part, index, normalized, distance);
    viewState.section = { enabled: false, axis: "x", offset: 0 };
    viewState.explodedView = null;
    viewState.highlightedFaces.clear();
    viewState.partTransforms = new Map([[part_id, moveVector]]);
    viewState.transparency.clear();
    if (fade_context_level !== undefined) {
      for (const otherPart of index.parts) {
        if (otherPart.id !== part_id) {
          viewState.transparency.set(otherPart.id, fade_context_level);
        }
      }
    }
    const autoView = view || humanViewForPart(part, assembly);
    const evidence = await captureViewerEvidence(manifest.projectId, autoView);
    return evidenceResult({
      success: true,
      project_id: manifest.projectId,
      part: compactPart(part),
      move_vector: moveVector,
      analysis,
      evidence: { ...evidenceMeta(evidence), auto_view_used: !view },
    }, [evidence]);
  },
);

server.registerTool(
  "cad_render_disassembly_exploded_view",
  {
    title: "渲染拆卸式爆炸视图证据图",
    description: "基于可能拆卸方向和向外布局为每个零件分配独立位移，生成更符合装配拆卸习惯的爆炸视图并返回图片。",
    inputSchema: ProjectIdSchema.extend({
      factor: z.number().positive().optional(),
      view: ViewSchema,
    }),
  },
  async ({ project_id, factor, view }) => {
    const { manifest, assembly } = await resolveProject(project_id);
    const index = buildIndex(assembly);
    const { transforms, plan } = computeDisassemblyTransforms(index, assembly, factor || 1);
    viewState.projectId = manifest.projectId;
    viewState.section = { enabled: false, axis: "x", offset: 0 };
    viewState.explodedView = null;
    viewState.partTransforms = new Map(Object.entries(transforms));
    const evidence = await captureViewerEvidence(manifest.projectId, view || { preset: "iso" });
    return evidenceResult({
      success: true,
      project_id: manifest.projectId,
      strategy: "clearance_direction_plus_outward_layout",
      transform_count: Object.keys(transforms).length,
      plan,
      evidence: { ...evidenceMeta(evidence), auto_view_used: !view },
    }, [evidence]);
  },
);

server.registerTool(
  "cad_analyze_removal_directions",
  {
    title: "分析零件拆卸方向",
    description: "分析零件沿若干方向线性移动时的避碰候选。该工具是启发式分析，不是最终可拆卸性判定。",
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
      analyses: findClearanceDirections(part, index, directionList),
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
