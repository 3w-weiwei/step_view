const fs = require("fs/promises");
const path = require("path");
const net = require("net");

const PROJECT_ROOT = process.env.STEP_CAD_PROJECT_ROOT || path.join(__dirname, "project-data");
const TCP_HOST = process.env.STEP_CAD_VIEWER_HOST || "127.0.0.1";
const TCP_PORT = Number(process.env.STEP_CAD_VIEWER_PORT || 3100);

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

function parseArgs(argv) {
  const options = {
    projectId: null,
    outDir: null,
    size: 256,
    maxPairs: 200,
    maxFacePairs: 8,
    minConfidence: undefined,
    maxDistance: undefined,
    skipParts: false,
    skipContacts: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (!arg.startsWith("--") && !options.projectId) {
      options.projectId = arg;
    } else if (arg === "--project-id") {
      options.projectId = next;
      index += 1;
    } else if (arg === "--out") {
      options.outDir = next;
      index += 1;
    } else if (arg === "--size") {
      options.size = Number(next) || options.size;
      index += 1;
    } else if (arg === "--max-pairs") {
      options.maxPairs = Number(next) || options.maxPairs;
      index += 1;
    } else if (arg === "--max-face-pairs") {
      options.maxFacePairs = Number(next) || options.maxFacePairs;
      index += 1;
    } else if (arg === "--min-confidence") {
      options.minConfidence = Number(next);
      index += 1;
    } else if (arg === "--max-distance") {
      options.maxDistance = Number(next);
      index += 1;
    } else if (arg === "--skip-parts") {
      options.skipParts = true;
    } else if (arg === "--skip-contacts") {
      options.skipContacts = true;
    }
  }
  if (!options.projectId) {
    throw new Error("Usage: node build-contact-dataset.js <project_id> [--out <dir>] [--size 256] [--max-pairs 200] [--max-face-pairs 8]");
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function normalizeVector(vector) {
  const values = Array.isArray(vector) ? vector.map(Number) : [0, 0, 0];
  const length = Math.hypot(values[0] || 0, values[1] || 0, values[2] || 0);
  return length ? [values[0] / length, values[1] / length, values[2] / length] : [1, 0, 0];
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
  };
}

function vectorLength(vector) {
  return Math.hypot(Number(vector?.x || 0), Number(vector?.y || 0), Number(vector?.z || 0));
}

function subtractPoints(left, right) {
  return {
    x: Number(left?.x || 0) - Number(right?.x || 0),
    y: Number(left?.y || 0) - Number(right?.y || 0),
    z: Number(left?.z || 0) - Number(right?.z || 0),
  };
}

function crossVector(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalizeObjectVector(vector, fallback = { x: 0, y: 0, z: 1 }) {
  const length = vectorLength(vector);
  if (!length) {
    return { ...fallback };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function triangleNormal(a, b, c) {
  return crossVector(subtractPoints(b, a), subtractPoints(c, a));
}

function pointFromPositions(positions, vertexIndex) {
  const offset = vertexIndex * 3;
  return {
    x: Number(positions[offset + 0] || 0),
    y: Number(positions[offset + 1] || 0),
    z: Number(positions[offset + 2] || 0),
  };
}

function uniquePoints(points) {
  const seen = new Set();
  const result = [];
  for (const point of points) {
    const key = `${round(point.x, 5)},${round(point.y, 5)},${round(point.z, 5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(point);
    }
  }
  return result;
}

function facePoints(face, index) {
  const mesh = index?.meshMap?.get(face?.meshId);
  const positions = mesh?.attributes?.position;
  const indices = mesh?.index;
  if (!Array.isArray(positions) || !Array.isArray(indices)) {
    return [];
  }

  const points = [];
  const first = Number(face.triangleFirst || 0);
  const last = Number(face.triangleLast ?? first - 1);
  for (let triangleIndex = first; triangleIndex <= last; triangleIndex += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertexIndex = indices[triangleIndex * 3 + corner];
      if (Number.isFinite(vertexIndex)) {
        points.push(pointFromPositions(positions, vertexIndex));
      }
    }
  }
  return uniquePoints(points);
}

function isPlanarFace(face, points) {
  if (!points.length || (face.triangleCount || 0) <= 1) {
    return true;
  }

  const normal = normalizeObjectVector(face.normal);
  const origin = points[0];
  const bboxSize = face.bounds?.size || {};
  const diag = Math.max(Math.hypot(bboxSize.x || 0, bboxSize.y || 0, bboxSize.z || 0), 1);
  let maxDistance = 0;
  let maxNormalDelta = 0;

  for (const point of points) {
    const delta = subtractPoints(point, origin);
    maxDistance = Math.max(maxDistance, Math.abs(delta.x * normal.x + delta.y * normal.y + delta.z * normal.z));
  }

  const mesh = points;
  for (let index = 2; index < mesh.length; index += 1) {
    const triNormal = normalizeObjectVector(triangleNormal(mesh[0], mesh[index - 1], mesh[index]));
    maxNormalDelta = Math.max(maxNormalDelta, 1 - Math.abs(dot([normal.x, normal.y, normal.z], [triNormal.x, triNormal.y, triNormal.z])));
  }

  return maxDistance <= Math.max(diag * 0.001, 0.01) && maxNormalDelta <= 0.01;
}

function fitCircle2d(points) {
  if (points.length < 3) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  const cx = sumX / points.length;
  const cy = sumY / points.length;
  const radii = points.map((point) => Math.hypot(point.x - cx, point.y - cy));
  const radius = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  if (!Number.isFinite(radius) || radius <= 1e-6) {
    return null;
  }
  const meanResidual = radii.reduce((sum, value) => sum + Math.abs(value - radius), 0) / radii.length;
  const maxResidual = radii.reduce((max, value) => Math.max(max, Math.abs(value - radius)), 0);
  return { center: { x: cx, y: cy }, radius, meanResidual, maxResidual };
}

function estimateCylinder(points, bounds) {
  if (points.length < 8 || !bounds?.size) {
    return null;
  }

  const axisDefs = [
    { axis: "x", coords: ["y", "z"] },
    { axis: "y", coords: ["x", "z"] },
    { axis: "z", coords: ["x", "y"] },
  ];

  const candidates = axisDefs
    .map((definition) => {
      const fit = fitCircle2d(points.map((point) => ({ x: point[definition.coords[0]], y: point[definition.coords[1]] })));
      if (!fit) {
        return null;
      }
      const length = Number(bounds.size[definition.axis] || 0);
      const residualRatio = fit.meanResidual / fit.radius;
      const maxResidualRatio = fit.maxResidual / fit.radius;
      return {
        axis: definition.axis,
        length,
        radius: fit.radius,
        residualRatio,
        maxResidualRatio,
        score: residualRatio + maxResidualRatio * 0.25,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  const best = candidates[0];
  if (!best) {
    return null;
  }

  const longEnough = best.length >= Math.max(best.radius * 0.2, 0.05);
  const cylindricalEnough = best.residualRatio <= 0.035 && best.maxResidualRatio <= 0.12;
  if (!longEnough || !cylindricalEnough) {
    return null;
  }

  return {
    axis: best.axis,
    length: round(best.length),
    radius: round(best.radius),
    residual_ratio: round(best.residualRatio, 5),
  };
}

function classifyFace(face, index) {
  const points = facePoints(face, index);
  if (isPlanarFace(face, points)) {
    return { type: "plane" };
  }

  const cylinder = estimateCylinder(points, face.bounds || face.bbox);
  if (cylinder) {
    return { type: "cylinder", cylinder };
  }

  return { type: "freeform" };
}

function summarizePartGeometry(part, index) {
  const faces = part.faces || [];
  const summary = {
    total_face_count: part.topology?.faceCount || faces.length,
    plane_face_count: 0,
    cylinder_face_count: 0,
    freeform_face_count: 0,
    max_plane_area: 0,
    max_cylinder_length: 0,
    max_cylinder_radius: 0,
    cylinder_radii: [],
    has_main_axis: false,
    main_axis: null,
    classification_method: "mesh_heuristic",
  };
  const radiusSet = new Set();
  const cylinderAxes = new Map();

  for (const face of faces) {
    const classification = classifyFace(face, index);
    if (classification.type === "plane") {
      summary.plane_face_count += 1;
      summary.max_plane_area = Math.max(summary.max_plane_area, Number(face.area || 0));
    } else if (classification.type === "cylinder") {
      summary.cylinder_face_count += 1;
      summary.max_cylinder_length = Math.max(summary.max_cylinder_length, classification.cylinder.length || 0);
      summary.max_cylinder_radius = Math.max(summary.max_cylinder_radius, classification.cylinder.radius || 0);
      radiusSet.add(round(classification.cylinder.radius));
      const axis = classification.cylinder.axis;
      cylinderAxes.set(axis, (cylinderAxes.get(axis) || 0) + 1);
    } else {
      summary.freeform_face_count += 1;
    }
  }

  const sortedAxes = [...cylinderAxes.entries()].sort((a, b) => b[1] - a[1]);
  summary.has_main_axis = Boolean(sortedAxes.length && sortedAxes[0][1] >= 1);
  summary.main_axis = sortedAxes.length ? sortedAxes[0][0] : null;
  summary.max_plane_area = round(summary.max_plane_area);
  summary.max_cylinder_length = round(summary.max_cylinder_length);
  summary.max_cylinder_radius = round(summary.max_cylinder_radius);
  summary.cylinder_radii = [...radiusSet].sort((a, b) => a - b);
  return summary;
}

function compactPart(part, index = null) {
  const geometrySummary = index ? summarizePartGeometry(part, index) : null;
  return {
    id: part.id,
    name: part.name,
    path: part.pathNames || [],
    color: part.color,
    bbox: part.bbox,
    face_count: part.topology?.faceCount || (part.faces || []).length,
    triangle_count: part.topology?.triangleCount || 0,
    solid_count: part.topology?.solidCount || 0,
    ...(geometrySummary || {}),
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

function buildContactPairList(index, options = {}) {
  const pairs = [];
  const seen = new Set();
  for (const part of index.parts) {
    const candidates = buildContactCandidates(part, index, {
      maxDistance: options.maxDistance,
      minConfidence: options.minConfidence,
      maxPairs: options.maxPairs || 200,
      maxFacePairsPerPart: options.maxFacePairsPerPart || 8,
    });
    for (const candidate of candidates) {
      const key = [part.id, candidate.other_part_id].sort().join("::");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pairs.push({
        pair_id: key,
        part_a: { id: part.id, name: part.name },
        part_b: { id: candidate.other_part_id, name: candidate.other_part_name },
        confidence: candidate.confidence,
        relation_type: candidate.relation_type,
        contact_faces: candidate.face_pairs,
      });
    }
  }
  pairs.sort((a, b) => b.confidence - a.confidence);
  return pairs.slice(0, options.maxPairs || 200);
}

function invokeViewer(method, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: TCP_HOST, port: TCP_PORT });
    const id = `dataset-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Viewer TCP bridge timeout during ${method}. Start Electron viewer with npm start.`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ type: "invoke", id, method, params })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const messages = buffer.split("\n");
      buffer = messages.pop() || "";
      for (const raw of messages) {
        if (!raw.trim()) continue;
        const message = JSON.parse(raw);
        if (message.id !== id) continue;
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
      reject(new Error(`Viewer TCP bridge unavailable: ${error.message}. Start Electron viewer with npm start.`));
    });
  });
}

async function saveImage(outDir, base64, name) {
  if (!base64) return null;
  const filePath = path.join(outDir, `${name}.png`);
  await fs.writeFile(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

function safeName(value) {
  return String(value || "item").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function renderPartDataset(projectId, part, outDir, size, index) {
  const result = await invokeViewer("capturePartMultiview", {
    partId: part.id,
    size,
    angles: DEFAULT_PART_MULTIVIEW,
  }, 90000);
  const images = [];
  for (const view of result.views || []) {
    const imagePath = await saveImage(outDir, view.image, `${safeName(part.id)}-${safeName(view.name)}`);
    images.push({
      name: view.name,
      label: view.label || view.name,
      azimuth: view.azimuth,
      elevation: view.elevation,
      width: view.width || size,
      height: view.height || size,
      image_path: imagePath,
    });
  }
  return {
    project_id: projectId,
    part: compactPart(part, index),
    views: images,
  };
}

async function renderContactPairDataset(projectId, pair, outDir, size) {
  const highlights = {};
  for (const facePair of pair.contact_faces || []) {
    if (facePair.face_id) highlights[facePair.face_id] = "#ff2b2b";
    if (facePair.other_face_id) highlights[facePair.other_face_id] = "#ff2b2b";
  }
  const result = await invokeViewer("capturePartMultiview", {
    partId: pair.part_a.id,
    isolatePartIds: [pair.part_a.id, pair.part_b.id],
    highlights,
    size,
    angles: DEFAULT_PART_MULTIVIEW,
  }, 90000);
  const images = [];
  for (const view of result.views || []) {
    const imagePath = await saveImage(outDir, view.image, `${safeName(pair.pair_id)}-${safeName(view.name)}`);
    images.push({
      name: view.name,
      label: view.label || view.name,
      azimuth: view.azimuth,
      elevation: view.elevation,
      width: view.width || size,
      height: view.height || size,
      image_path: imagePath,
    });
  }
  return {
    project_id: projectId,
    pair: {
      ...pair,
      highlighted_face_count: Object.keys(highlights).length,
      highlight_color: "#ff2b2b",
    },
    views: images,
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const projectDir = path.join(PROJECT_ROOT, options.projectId);
  const manifest = await readJson(path.join(projectDir, "manifest.json"));
  const assembly = await readJson(path.join(projectDir, "assembly.json"));
  const index = buildIndex(assembly);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const datasetDir = options.outDir
    ? path.resolve(options.outDir)
    : path.join(projectDir, "datasets", timestamp);
  const partsDir = path.join(datasetDir, "parts");
  const contactsDir = path.join(datasetDir, "contact_pairs");
  await fs.mkdir(partsDir, { recursive: true });
  await fs.mkdir(contactsDir, { recursive: true });

  console.log(`Loading project ${options.projectId} into viewer...`);
  await invokeViewer("loadProject", { projectId: options.projectId, route: "viz" }, 30000);

  const contactPairs = buildContactPairList(index, {
    maxDistance: options.maxDistance,
    minConfidence: options.minConfidence,
    maxPairs: options.maxPairs,
    maxFacePairsPerPart: options.maxFacePairs,
  });

  const datasetManifest = {
    generated_at: new Date().toISOString(),
    project: {
      id: manifest.projectId,
      name: manifest.projectName,
      source_file_name: manifest.sourceFileName,
      unit: manifest.unitLabel || assembly?.meta?.unitLabel || "mm",
    },
    options,
    stats: {
      part_count: index.parts.length,
      contact_pair_count: contactPairs.length,
      image_size: options.size,
      views_per_item: DEFAULT_PART_MULTIVIEW.length,
    },
    files: {
      parts: "parts/parts.json",
      contact_pairs: "contact_pairs/contact_pairs.json",
    },
  };

  await fs.writeFile(path.join(datasetDir, "manifest.json"), JSON.stringify(datasetManifest, null, 2));
  await fs.writeFile(path.join(datasetDir, "parts.json"), JSON.stringify(index.parts.map((part) => compactPart(part, index)), null, 2));
  await fs.writeFile(path.join(datasetDir, "contact_pairs.json"), JSON.stringify(contactPairs, null, 2));

  const partItems = [];
  if (!options.skipParts) {
    for (const [idx, part] of index.parts.entries()) {
      console.log(`[parts ${idx + 1}/${index.parts.length}] ${part.id} ${part.name}`);
      const partItem = await renderPartDataset(options.projectId, part, partsDir, options.size, index);
      partItems.push(partItem);
    }
  }
  await fs.writeFile(path.join(partsDir, "parts.json"), JSON.stringify(partItems, null, 2));

  const contactItems = [];
  if (!options.skipContacts) {
    for (const [idx, pair] of contactPairs.entries()) {
      console.log(`[contacts ${idx + 1}/${contactPairs.length}] ${pair.pair_id}`);
      const contactItem = await renderContactPairDataset(options.projectId, pair, contactsDir, options.size);
      contactItems.push(contactItem);
    }
  }
  await fs.writeFile(path.join(contactsDir, "contact_pairs.json"), JSON.stringify(contactItems, null, 2));

  datasetManifest.files.parts = "parts/parts.json";
  datasetManifest.files.contact_pairs = "contact_pairs/contact_pairs.json";
  datasetManifest.completed_at = new Date().toISOString();
  await fs.writeFile(path.join(datasetDir, "manifest.json"), JSON.stringify(datasetManifest, null, 2));
  console.log(`Dataset written to: ${datasetDir}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
