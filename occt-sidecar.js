const fs = require("fs/promises");
const occtimportjs = require("occt-import-js")();

const PALETTE = ["#4E79A7", "#5B8FF9", "#76B7B2", "#59A14F", "#F28E2B", "#E15759", "#499894", "#B07AA1"];

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pickColor(seed) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

// VLM优化的面颜色调色板 - 高饱和度、高亮度、高对比度
const FACE_PALETTE = [
  // 基础彩虹色 - 高饱和度
  "#FF4444", "#FF8C00", "#FFD700", "#7FFF00", "#00FF7F", "#00FFFF", "#007FFF", "#4444FF", "#8B00FF", "#FF00FF",
  // 额外的鲜艳色彩
  "#FF6B6B", "#FFA502", "#FFFA65", "#A8E063", "#26DE81", "#2BCFE7", "#4B7BEC", "#845EC2", "#D65DB1", "#FF6F91",
  // 金属感强的高对比色
  "#E74C3C", "#F39C12", "#F1C40F", "#2ECC71", "#1ABC9C", "#3498DB", "#9B59B6", "#E91E63", "#00BCD4", "#CDDC39",
  // 更多高饱和度颜色
  "#FF1744", "#FF9100", "#FFEA00", "#00E676", "#00B0FF", "#651FFF", "#D500F9", "#FF4081", "#18FFFF", "#C6FF00",
  "#F50057", "#FF3D00", "#FFD600", "#1DE9B6", "#2979FF", "#6200EA", "#AA00FF", "#FF80AB", "#84FFFF", "#EEFF41",
];

function getFaceColor(faceIndex, totalFaces) {
  // 使用高对比度的颜色分布策略
  if (totalFaces <= FACE_PALETTE.length) {
    // 面数较少时，直接使用调色板中的颜色
    return FACE_PALETTE[faceIndex % FACE_PALETTE.length];
  }
  // 面数较多时，使用HSL生成高饱和度高亮度的颜色
  const hue = (faceIndex * 137.508) % 360; // 黄金角分布，确保颜色均匀分布
  const saturation = 85 + (faceIndex % 15); // 85-100%饱和度
  const lightness = 50 + (faceIndex % 15);  // 50-65%亮度
  return `hsl(${Math.round(hue)}, ${saturation}%, ${lightness}%)`;
}

function rgbArrayToHex(color) {
  if (!Array.isArray(color) || color.length < 3) {
    return null;
  }
  const toHex = (value) => clamp(Math.round(value * 255), 0, 255).toString(16).padStart(2, "0");
  return `#${toHex(color[0])}${toHex(color[1])}${toHex(color[2])}`;
}

function unionBounds(boundsList) {
  const valid = boundsList.filter(Boolean);
  if (!valid.length) {
    return {
      min: { x: -5, y: -5, z: -5 },
      max: { x: 5, y: 5, z: 5 },
      center: { x: 0, y: 0, z: 0 },
      size: { x: 10, y: 10, z: 10 },
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  valid.forEach((bounds) => {
    minX = Math.min(minX, bounds.min.x);
    minY = Math.min(minY, bounds.min.y);
    minZ = Math.min(minZ, bounds.min.z);
    maxX = Math.max(maxX, bounds.max.x);
    maxY = Math.max(maxY, bounds.max.y);
    maxZ = Math.max(maxZ, bounds.max.z);
  });

  return {
    min: { x: round(minX), y: round(minY), z: round(minZ) },
    max: { x: round(maxX), y: round(maxY), z: round(maxZ) },
    center: {
      x: round((minX + maxX) / 2),
      y: round((minY + maxY) / 2),
      z: round((minZ + maxZ) / 2),
    },
    size: {
      x: round(maxX - minX),
      y: round(maxY - minY),
      z: round(maxZ - minZ),
    },
  };
}

function extractPoint(positions, index) {
  return {
    x: positions[index * 3 + 0],
    y: positions[index * 3 + 1],
    z: positions[index * 3 + 2],
  };
}

function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalize(vector) {
  const length = Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
  if (!length) {
    return { x: 0, y: 0, z: 1 };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function triangleArea(a, b, c) {
  const ab = subtract(b, a);
  const ac = subtract(c, a);
  const crossValue = cross(ab, ac);
  return Math.sqrt(crossValue.x ** 2 + crossValue.y ** 2 + crossValue.z ** 2) * 0.5;
}

function buildFaceMeta(meshId, faceIndex, faceRange, positions, indices, totalFaces) {
  const points = [];
  let accumulatedNormal = { x: 0, y: 0, z: 0 };
  let area = 0;
  let longestEdge = 0;
  const startTriangle = faceRange.first;
  const endTriangle = faceRange.last;

  for (let triangleIndex = startTriangle; triangleIndex <= endTriangle; triangleIndex += 1) {
    const i0 = indices[triangleIndex * 3 + 0];
    const i1 = indices[triangleIndex * 3 + 1];
    const i2 = indices[triangleIndex * 3 + 2];
    const p0 = extractPoint(positions, i0);
    const p1 = extractPoint(positions, i1);
    const p2 = extractPoint(positions, i2);
    points.push(p0, p1, p2);

    const e01 = subtract(p1, p0);
    const e12 = subtract(p2, p1);
    const e20 = subtract(p0, p2);
    longestEdge = Math.max(
      longestEdge,
      Math.sqrt(e01.x ** 2 + e01.y ** 2 + e01.z ** 2),
      Math.sqrt(e12.x ** 2 + e12.y ** 2 + e12.z ** 2),
      Math.sqrt(e20.x ** 2 + e20.y ** 2 + e20.z ** 2),
    );

    const normal = cross(e01, subtract(p2, p0));
    accumulatedNormal = {
      x: accumulatedNormal.x + normal.x,
      y: accumulatedNormal.y + normal.y,
      z: accumulatedNormal.z + normal.z,
    };
    area += triangleArea(p0, p1, p2);
  }

  const bounds = unionBounds(
    points.map((point) => ({
      min: point,
      max: point,
    })),
  );

  return {
    id: `${meshId}:face-${faceIndex}`,
    name: `Face ${faceIndex + 1}`,
    meshId,
    faceIndex,
    triangleFirst: startTriangle,
    triangleLast: endTriangle,
    triangleCount: endTriangle - startTriangle + 1,
    color: getFaceColor(faceIndex, totalFaces),
    bounds,
    center: bounds.center,
    normal: normalize(accumulatedNormal),
    area: round(area),
    longestEdge: round(longestEdge),
  };
}

function buildMeshRecord(meshIndex, mesh) {
  const meshId = `mesh-${meshIndex}`;
  const positions = Array.from(mesh.attributes.position.array);
  const normals = mesh.attributes.normal?.array ? Array.from(mesh.attributes.normal.array) : null;
  const indices = Array.from(mesh.index.array);

  const vertexBounds = [];
  for (let index = 0; index < positions.length; index += 3) {
    vertexBounds.push({
      min: { x: positions[index + 0], y: positions[index + 1], z: positions[index + 2] },
      max: { x: positions[index + 0], y: positions[index + 1], z: positions[index + 2] },
    });
  }

  const faceRanges = (mesh.brep_faces || []).map((faceRange, faceIndex) =>
    buildFaceMeta(meshId, faceIndex, faceRange, positions, indices, mesh.brep_faces.length),
  );

  return {
    id: meshId,
    name: mesh.name || meshId,
    color: rgbArrayToHex(mesh.color) || pickColor(mesh.name || meshId),
    attributes: {
      position: positions,
      normal: normals,
    },
    index: indices,
    brepFaces: faceRanges,
    topology: {
      faceCount: faceRanges.length,
      solidCount: 1,
      vertexCount: positions.length / 3,
      triangleCount: indices.length / 3,
    },
    bbox: unionBounds(vertexBounds),
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildThumbnailSvg({ projectName, sourceFileName, stats, nodes, bounds }) {
  const parts = nodes.filter((node) => node.kind === "part").slice(0, 8);
  const worldWidth = Math.max(bounds.size.x, 1);
  const worldHeight = Math.max(bounds.size.y, 1);
  const accent = pickColor(projectName || sourceFileName);
  const shapes = parts
    .map((part) => {
      const normalizedX = (part.bbox.center.x - bounds.min.x) / worldWidth;
      const normalizedY = (part.bbox.center.y - bounds.min.y) / worldHeight;
      const boxWidth = Math.max(14, Math.min(96, (part.bbox.size.x / worldWidth) * 240 + 12));
      const boxHeight = Math.max(12, Math.min(72, (part.bbox.size.y / worldHeight) * 150 + 12));
      const x = 120 + normalizedX * 250 - boxWidth / 2;
      const y = 68 + normalizedY * 150 - boxHeight / 2;
      return `<rect x="${round(x, 1)}" y="${round(y, 1)}" width="${round(boxWidth, 1)}" height="${round(
        boxHeight,
        1,
      )}" rx="10" fill="${part.color}" fill-opacity="0.28" stroke="#DCE7FB" stroke-opacity="0.38" stroke-width="2"/>`;
    })
    .join("");

  return `
<svg width="520" height="320" viewBox="0 0 520 320" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="520" y1="0" y2="320" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0E1726"/>
      <stop offset="1" stop-color="#1C2A39"/>
    </linearGradient>
  </defs>
  <rect width="520" height="320" rx="28" fill="url(#bg)"/>
  <circle cx="404" cy="78" r="82" fill="${accent}" fill-opacity="0.18"/>
  <circle cx="112" cy="244" r="120" fill="#9EC5FE" fill-opacity="0.08"/>
  ${shapes}
  <text x="36" y="52" fill="white" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="24" font-weight="700">${escapeXml(projectName)}</text>
  <text x="36" y="82" fill="#D0DAE9" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="15">${escapeXml(sourceFileName)}</text>
  <text x="36" y="274" fill="#B5C1D3" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="16">装配 ${stats.assemblyCount}  ·  零件 ${stats.partCount}  ·  面 ${stats.faceCount}</text>
  <text x="36" y="298" fill="#7F92AA" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="14">OCCT Sidecar · Triangulated Mesh</text>
</svg>
`.trim();
}

function buildHierarchyPayload(result, options) {
  const meshes = result.meshes.map((mesh, index) => buildMeshRecord(index, mesh));
  const meshMap = new Map(meshes.map((mesh) => [mesh.id, mesh]));
  const nodes = [];
  let nextNodeId = 1;

  function visit(sourceNode, parentId) {
    const meshRefs = (sourceNode.meshes || []).map((meshIndex) => `mesh-${meshIndex}`);
    const hasChildren = Array.isArray(sourceNode.children) && sourceNode.children.length > 0;
    const kind = hasChildren ? "assembly" : "part";
    const nodeId = `node-${nextNodeId++}`;
    const node = {
      id: nodeId,
      parentId,
      kind,
      name: sourceNode.name || (parentId ? "Unnamed" : options.projectName),
      color: pickColor(`${sourceNode.name || nodeId}`),
      meshRefs,
      children: [],
      bbox: null,
      faces: [],
      topology: {
        faceCount: 0,
        solidCount: 0,
        vertexCount: 0,
        triangleCount: 0,
      },
    };
    nodes.push(node);

    if (hasChildren) {
      sourceNode.children.forEach((childNode) => {
        const childId = visit(childNode, nodeId);
        node.children.push(childId);
      });
    }

    return nodeId;
  }

  const syntheticRoot =
    result.root.name || result.root.meshes?.length || result.root.children?.length !== 1
      ? result.root
      : result.root.children[0];

  const rootId = visit(syntheticRoot, null);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const meshOwner = new Map();

  function assignDerived(nodeId) {
    const node = nodeMap.get(nodeId);
    const childBounds = node.children.map((childId) => assignDerived(childId));
    const ownMeshes = node.meshRefs.map((meshId) => meshMap.get(meshId)).filter(Boolean);
    ownMeshes.forEach((mesh) => {
      meshOwner.set(mesh.id, node.id);
    });

    const bounds = unionBounds([
      ...ownMeshes.map((mesh) => mesh.bbox),
      ...childBounds,
    ]);
    node.bbox = bounds;

    ownMeshes.forEach((mesh) => {
      // 使用引用而非拷贝，这样后续修改 face.renderColor 时 node.faces 也能看到
      mesh.brepFaces.forEach((face) => {
        face.meshName = mesh.name;
        node.faces.push(face);
      });
      node.topology.faceCount += mesh.topology.faceCount;
      node.topology.solidCount += mesh.topology.solidCount;
      node.topology.vertexCount += mesh.topology.vertexCount;
      node.topology.triangleCount += mesh.topology.triangleCount;
    });

    node.children.forEach((childId) => {
      const child = nodeMap.get(childId);
      node.topology.faceCount += child.topology.faceCount;
      node.topology.solidCount += child.topology.solidCount;
      node.topology.vertexCount += child.topology.vertexCount;
      node.topology.triangleCount += child.topology.triangleCount;
    });

    return bounds;
  }

  assignDerived(rootId);

  meshes.forEach((mesh) => {
    mesh.nodeId = meshOwner.get(mesh.id) || null;
  });

  function applyPaths(nodeId, pathNames) {
    const node = nodeMap.get(nodeId);
    const nextPath = [...pathNames, node.name];
    node.pathNames = nextPath;
    node.depth = nextPath.length - 1;
    node.children.forEach((childId) => applyPaths(childId, nextPath));
  }
  applyPaths(rootId, []);

  const partNodes = nodes.filter((node) => node.kind === "part");
  const bounds = nodeMap.get(rootId)?.bbox || unionBounds([]);
  const stats = {
    partCount: partNodes.length,
    assemblyCount: Math.max(nodes.filter((node) => node.kind === "assembly").length, 1),
    faceCount: meshes.reduce((sum, mesh) => sum + mesh.topology.faceCount, 0),
    solidCount: meshes.reduce((sum, mesh) => sum + mesh.topology.solidCount, 0),
    meshCount: meshes.length,
    triangleCount: meshes.reduce((sum, mesh) => sum + mesh.topology.triangleCount, 0),
  };

  return {
    rootId,
    bounds,
    defaultSelectionId: partNodes[0]?.id || null,
    nodes,
    meshes,
    stats,
    meta: {
      parserMode: "occt-sidecar",
      geometryMode: "triangulated-mesh",
      sourceModelName: syntheticRoot.name || options.projectName,
      sourceSchema: options.sourceSchema || null,
      unitLabel: options.unitLabel || "mm",
    },
    thumbnailSvg: buildThumbnailSvg({
      projectName: options.projectName,
      sourceFileName: options.sourceFileName,
      stats,
      nodes,
      bounds,
    }),
  };
}

async function parseStepWithOcct(inputPath, options) {
  const occt = await occtimportjs;
  const content = await fs.readFile(inputPath);
  const result = occt.ReadStepFile(content, {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.001,
    angularDeflection: 0.35,
  });

  if (!result.success) {
    throw new Error("OCCT sidecar 未能成功读取 STEP 文件。");
  }

  return buildHierarchyPayload(result, options);
}

async function runMessage(message) {
  if (!message || message.command !== "parse-step") {
    return;
  }

  try {
    const payload = await parseStepWithOcct(message.inputPath, message.options || {});
    if (process.send) {
      process.send({ type: "success", payload });
    } else {
      process.stdout.write(`${JSON.stringify({ type: "success", payload })}\n`);
    }
  } catch (error) {
    if (process.send) {
      process.send({ type: "error", error: error.message || String(error) });
    } else {
      process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    }
  } finally {
    process.exit(0);
  }
}

if (process.send) {
  process.on("message", runMessage);
} else if (require.main === module) {
  const [, , inputPath, projectName, sourceFileName] = process.argv;
  runMessage({
    command: "parse-step",
    inputPath,
    options: {
      projectName,
      sourceFileName,
    },
  });
}

module.exports = {
  parseStepWithOcct,
};
