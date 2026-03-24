const GROUP_LIBRARY = [
  {
    name: "箱体组件",
    parts: ["左壳体", "右壳体", "前端盖", "后端盖", "安装法兰", "观察窗盖板"],
  },
  {
    name: "传动组件",
    parts: ["主动齿轮轴", "从动齿轮", "中间轴", "联轴器", "花键套", "输出轴"],
  },
  {
    name: "轴承组件",
    parts: ["深沟球轴承", "圆锥滚子轴承", "隔套", "止推垫圈", "轴承座", "锁紧螺母"],
  },
  {
    name: "紧固件组",
    parts: ["内六角螺栓", "定位销", "平垫圈", "弹簧垫圈", "压板", "锁紧片"],
  },
  {
    name: "润滑与附件",
    parts: ["油封", "油标尺", "排气塞", "注油口", "传感器支架", "防护罩"],
  },
  {
    name: "执行机构",
    parts: ["伺服电机底座", "编码器外壳", "减振垫", "接线盒", "导向座", "连接板"],
  },
];

const MATERIALS = ["Cast Iron", "Alloy Steel", "Aluminum", "Polymer", "Brass"];
const COLORS = ["#4E79A7", "#5B8FF9", "#76B7B2", "#59A14F", "#F28E2B", "#E15759"];
const FACE_DEFINITIONS = [
  { key: "front", name: "前表面", normal: { x: 0, y: 0, z: 1 } },
  { key: "back", name: "后表面", normal: { x: 0, y: 0, z: -1 } },
  { key: "left", name: "左表面", normal: { x: -1, y: 0, z: 0 } },
  { key: "right", name: "右表面", normal: { x: 1, y: 0, z: 0 } },
  { key: "top", name: "上表面", normal: { x: 0, y: 1, z: 0 } },
  { key: "bottom", name: "下表面", normal: { x: 0, y: -1, z: 0 } },
];

function createSeed(input) {
  let hash = 2166136261;
  for (const character of input) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function createFaces(partId, size) {
  return FACE_DEFINITIONS.map((definition) => {
    let area = size.x * size.y;
    let longestEdge = Math.max(size.x, size.y);

    if (definition.key === "left" || definition.key === "right") {
      area = size.y * size.z;
      longestEdge = Math.max(size.y, size.z);
    }

    if (definition.key === "top" || definition.key === "bottom") {
      area = size.x * size.z;
      longestEdge = Math.max(size.x, size.z);
    }

    return {
      id: `${partId}:${definition.key}`,
      name: definition.name,
      normal: definition.normal,
      area: round(area),
      longestEdge: round(longestEdge),
    };
  });
}

function createPartNode({
  id,
  parentId,
  name,
  color,
  material,
  center,
  size,
  indexInGroup,
}) {
  return {
    id,
    parentId,
    kind: "part",
    name,
    children: [],
    color,
    material,
    quantity: 1,
    indexInGroup,
    bbox: {
      center: {
        x: round(center.x),
        y: round(center.y),
        z: round(center.z),
      },
      size: {
        x: round(size.x),
        y: round(size.y),
        z: round(size.z),
      },
    },
    faces: createFaces(id, size),
  };
}

function createAssemblyNode({ id, parentId, name, color }) {
  return {
    id,
    parentId,
    kind: "assembly",
    name,
    color,
    children: [],
  };
}

function buildThumbnailSvg({ projectName, sourceFileName, partCount, assemblyCount, accent }) {
  return `
<svg width="520" height="320" viewBox="0 0 520 320" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="520" y1="0" y2="320" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0E1726"/>
      <stop offset="1" stop-color="#1C2A39"/>
    </linearGradient>
    <linearGradient id="mesh" x1="120" x2="390" y1="68" y2="245" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="#B4CCF9" stop-opacity="0.72"/>
    </linearGradient>
  </defs>
  <rect width="520" height="320" rx="28" fill="url(#bg)"/>
  <circle cx="404" cy="78" r="82" fill="${accent}" fill-opacity="0.18"/>
  <circle cx="112" cy="244" r="120" fill="#9EC5FE" fill-opacity="0.08"/>
  <path d="M128 226L205 144L258 184L332 112L400 196" stroke="url(#mesh)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="162" y="150" width="82" height="62" rx="14" fill="#0D1624" stroke="#CFE0FF" stroke-opacity="0.35" stroke-width="3"/>
  <rect x="248" y="122" width="90" height="72" rx="16" fill="${accent}" fill-opacity="0.24" stroke="#DCE7FB" stroke-opacity="0.42" stroke-width="3"/>
  <rect x="124" y="228" width="272" height="1" fill="white" fill-opacity="0.12"/>
  <text x="36" y="52" fill="white" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="24" font-weight="700">${projectName}</text>
  <text x="36" y="82" fill="#D0DAE9" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="15">${sourceFileName}</text>
  <text x="36" y="274" fill="#B5C1D3" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="16">装配 ${assemblyCount}  ·  零件 ${partCount}</text>
  <text x="36" y="298" fill="#7F92AA" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="14">MVP Mock CAD Sidecar Preview</text>
</svg>
`.trim();
}

function applyPaths(rootId, nodes) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  function walk(nodeId, pathNames) {
    const node = nodeMap.get(nodeId);
    const nextPath = [...pathNames, node.name];
    node.pathNames = nextPath;
    node.depth = nextPath.length - 1;
    node.children.forEach((childId) => walk(childId, nextPath));
  }

  walk(rootId, []);
}

function applyAssemblyStats(rootId, nodes) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  function collect(nodeId) {
    const node = nodeMap.get(nodeId);
    if (node.kind === "part") {
      return {
        partCount: 1,
        assemblyCount: 0,
        faceCount: node.faces.length,
      };
    }

    const totals = {
      partCount: 0,
      assemblyCount: 1,
      faceCount: 0,
    };

    node.children.forEach((childId) => {
      const childStats = collect(childId);
      totals.partCount += childStats.partCount;
      totals.assemblyCount += childStats.assemblyCount;
      totals.faceCount += childStats.faceCount;
    });

    node.stats = totals;
    return totals;
  }

  return collect(rootId);
}

function calculateBounds(nodes) {
  const parts = nodes.filter((node) => node.kind === "part");
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  parts.forEach((part) => {
    const { center, size } = part.bbox;
    minX = Math.min(minX, center.x - size.x / 2);
    minY = Math.min(minY, center.y - size.y / 2);
    minZ = Math.min(minZ, center.z - size.z / 2);
    maxX = Math.max(maxX, center.x + size.x / 2);
    maxY = Math.max(maxY, center.y + size.y / 2);
    maxZ = Math.max(maxZ, center.z + size.z / 2);
  });

  return {
    min: { x: round(minX), y: round(minY), z: round(minZ) },
    max: { x: round(maxX), y: round(maxY), z: round(maxZ) },
    size: {
      x: round(maxX - minX),
      y: round(maxY - minY),
      z: round(maxZ - minZ),
    },
  };
}

function buildMockProjectPayload({ projectName, sourceFileName, fileSizeBytes }) {
  const seed = createSeed(`${projectName}|${sourceFileName}|${fileSizeBytes}`);
  const random = createRandom(seed);
  const groups = shuffle(GROUP_LIBRARY, random).slice(0, 4 + Math.floor(random() * 2));
  const nodes = [];
  let nextId = 0;

  function takeId(prefix) {
    nextId += 1;
    return `${prefix}-${nextId}`;
  }

  const rootId = takeId("asm");
  const accent = COLORS[Math.floor(random() * COLORS.length)];
  const rootNode = createAssemblyNode({
    id: rootId,
    parentId: null,
    name: projectName,
    color: accent,
  });

  nodes.push(rootNode);

  groups.forEach((group, groupIndex) => {
    const groupColor = COLORS[groupIndex % COLORS.length];
    const groupId = takeId("asm");
    const groupNode = createAssemblyNode({
      id: groupId,
      parentId: rootId,
      name: group.name,
      color: groupColor,
    });

    rootNode.children.push(groupId);
    nodes.push(groupNode);

    const branchCount = 1 + (random() > 0.58 ? 1 : 0);
    const totalPartCount = 4 + Math.floor(random() * 4);
    let assignedPartCount = 0;
    const baseX = (groupIndex - (groups.length - 1) / 2) * 190;
    const baseY = (random() - 0.5) * 30;
    const baseZ = (random() - 0.5) * 60;

    for (let branchIndex = 0; branchIndex < branchCount; branchIndex += 1) {
      let parentId = groupId;
      let branchOffsetY = 0;
      if (branchCount > 1) {
        const branchId = takeId("asm");
        const branchName = `${group.name}${branchIndex === 0 ? "主支路" : "辅助支路"}`;
        const branchNode = createAssemblyNode({
          id: branchId,
          parentId: groupId,
          name: branchName,
          color: groupColor,
        });

        groupNode.children.push(branchId);
        nodes.push(branchNode);
        parentId = branchId;
        branchOffsetY = branchIndex === 0 ? 34 : -34;
      }

      const remaining = totalPartCount - assignedPartCount;
      const branchPartCount =
        branchIndex === branchCount - 1 ? remaining : Math.max(2, Math.round(remaining / (branchCount - branchIndex)));

      for (let partIndex = 0; partIndex < branchPartCount; partIndex += 1) {
        const name = group.parts[(assignedPartCount + partIndex) % group.parts.length];
        const size = {
          x: 36 + random() * 56,
          y: 22 + random() * 42,
          z: 26 + random() * 48,
        };
        const center = {
          x: baseX + (partIndex % 3) * 62 + (random() - 0.5) * 20,
          y: baseY + branchOffsetY + Math.floor(partIndex / 3) * 36 + (random() - 0.5) * 10,
          z: baseZ + (random() - 0.5) * 120,
        };
        const partId = takeId("part");
        const partNode = createPartNode({
          id: partId,
          parentId,
          name,
          color: groupColor,
          material: MATERIALS[Math.floor(random() * MATERIALS.length)],
          center,
          size,
          indexInGroup: assignedPartCount + partIndex,
        });

        const parentNode = nodes.find((node) => node.id === parentId);
        parentNode.children.push(partId);
        nodes.push(partNode);
      }

      assignedPartCount += branchPartCount;
    }
  });

  applyPaths(rootId, nodes);
  const rootStats = applyAssemblyStats(rootId, nodes);
  const bounds = calculateBounds(nodes);
  const partNodes = nodes.filter((node) => node.kind === "part");

  return {
    rootId,
    seed,
    bounds,
    defaultSelectionId: partNodes[0]?.id || null,
    nodes,
    stats: {
      partCount: rootStats.partCount,
      assemblyCount: Math.max(1, nodes.filter((node) => node.kind === "assembly").length - 1),
      faceCount: rootStats.faceCount,
    },
    thumbnailSvg: buildThumbnailSvg({
      projectName,
      sourceFileName,
      partCount: rootStats.partCount,
      assemblyCount: Math.max(1, nodes.filter((node) => node.kind === "assembly").length - 1),
      accent,
    }),
  };
}

module.exports = {
  buildMockProjectPayload,
};
