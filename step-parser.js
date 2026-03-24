const fs = require("fs/promises");

const FACE_DEFINITIONS = [
  { key: "front", name: "前表面 (代理)", normal: { x: 0, y: 0, z: 1 } },
  { key: "back", name: "后表面 (代理)", normal: { x: 0, y: 0, z: -1 } },
  { key: "left", name: "左表面 (代理)", normal: { x: -1, y: 0, z: 0 } },
  { key: "right", name: "右表面 (代理)", normal: { x: 1, y: 0, z: 0 } },
  { key: "top", name: "上表面 (代理)", normal: { x: 0, y: 1, z: 0 } },
  { key: "bottom", name: "下表面 (代理)", normal: { x: 0, y: -1, z: 0 } },
];

const PALETTE = ["#4E79A7", "#5B8FF9", "#76B7B2", "#59A14F", "#F28E2B", "#E15759", "#499894", "#B07AA1"];

class StepSyntaxParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  peek() {
    return this.text[this.index];
  }

  skipWhitespace() {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) {
      this.index += 1;
    }
  }

  expect(character) {
    this.skipWhitespace();
    if (this.text[this.index] !== character) {
      throw new Error(`STEP 语法错误：期望 ${character}，实际为 ${this.text[this.index] || "EOF"}`);
    }
    this.index += 1;
  }

  parseIdentifier() {
    this.skipWhitespace();
    const start = this.index;
    while (this.index < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.index])) {
      this.index += 1;
    }
    if (start === this.index) {
      throw new Error(`STEP 语法错误：无法读取标识符，位置 ${this.index}`);
    }
    return this.text.slice(start, this.index);
  }

  parseString() {
    this.expect("'");
    let result = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === "'") {
        if (this.text[this.index + 1] === "'") {
          result += "'";
          this.index += 2;
          continue;
        }
        this.index += 1;
        return result;
      }
      result += character;
      this.index += 1;
    }
    throw new Error("STEP 语法错误：字符串未闭合。");
  }

  parseNumber() {
    this.skipWhitespace();
    const start = this.index;
    while (this.index < this.text.length && /[0-9+\-E.e]/.test(this.text[this.index])) {
      this.index += 1;
    }
    return Number(this.text.slice(start, this.index));
  }

  parseEnum() {
    this.expect(".");
    const start = this.index;
    while (this.index < this.text.length && this.text[this.index] !== ".") {
      this.index += 1;
    }
    const value = this.text.slice(start, this.index);
    this.expect(".");
    return { kind: "enum", value };
  }

  parseReference() {
    this.expect("#");
    const start = this.index;
    while (this.index < this.text.length && /[0-9]/.test(this.text[this.index])) {
      this.index += 1;
    }
    return { kind: "ref", value: `#${this.text.slice(start, this.index)}` };
  }

  parseList() {
    this.expect("(");
    const values = [];
    while (this.index < this.text.length) {
      this.skipWhitespace();
      if (this.peek() === ")") {
        this.index += 1;
        return values;
      }
      values.push(this.parseValue());
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.index += 1;
      }
    }
    throw new Error("STEP 语法错误：数组未闭合。");
  }

  parseTypedValueOrIdentifier() {
    const name = this.parseIdentifier();
    this.skipWhitespace();
    if (this.peek() === "(") {
      return {
        kind: "typed",
        name,
        args: this.parseList(),
      };
    }
    return name;
  }

  parseValue() {
    this.skipWhitespace();
    const character = this.peek();
    if (character === "'") {
      return this.parseString();
    }
    if (character === "#") {
      return this.parseReference();
    }
    if (character === "(") {
      return this.parseList();
    }
    if (character === ".") {
      return this.parseEnum();
    }
    if (character === "$") {
      this.index += 1;
      return null;
    }
    if (character === "*") {
      this.index += 1;
      return { kind: "omitted" };
    }
    if (/[0-9+\-]/.test(character)) {
      return this.parseNumber();
    }
    return this.parseTypedValueOrIdentifier();
  }

  parseStandardEntity() {
    const type = this.parseIdentifier();
    const params = this.parseList();
    this.skipWhitespace();
    return {
      type,
      params,
      components: {
        [type]: params,
      },
      allTypes: [type],
    };
  }

  parseComplexEntity() {
    this.expect("(");
    const components = [];
    while (this.index < this.text.length) {
      this.skipWhitespace();
      if (this.peek() === ")") {
        this.index += 1;
        break;
      }
      const type = this.parseIdentifier();
      const params = this.parseList();
      components.push({ type, params });
    }
    if (!components.length) {
      throw new Error("STEP 语法错误：复合实体为空。");
    }
    return {
      type: components[0].type,
      params: components[0].params,
      components: Object.fromEntries(components.map((component) => [component.type, component.params])),
      allTypes: components.map((component) => component.type),
    };
  }
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stripRef(ref) {
  return String(ref || "").replace(/^#/, "");
}

function isRef(value) {
  return value && typeof value === "object" && value.kind === "ref";
}

function refValue(value) {
  return isRef(value) ? value.value : null;
}

function collectRefs(value, refs = new Set()) {
  if (isRef(value)) {
    refs.add(value.value);
    return refs;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectRefs(item, refs));
    return refs;
  }
  if (value && typeof value === "object") {
    if (value.kind === "typed") {
      collectRefs(value.args, refs);
      return refs;
    }
    Object.values(value).forEach((item) => collectRefs(item, refs));
  }
  return refs;
}

function parseHeader(text) {
  const headerMatch = text.match(/HEADER;([\s\S]*?)ENDSEC;/i);
  const header = headerMatch ? headerMatch[1] : "";
  const fileNameMatch = header.match(/FILE_NAME\s*\(\s*'((?:''|[^'])*)'/i);
  const schemaMatches = [...header.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  return {
    originalFileName: fileNameMatch ? fileNameMatch[1].replaceAll("''", "'") : null,
    schema: schemaMatches.filter((item) => /AP|CONFIG_CONTROL/i.test(item))[0] || null,
  };
}

function splitRecords(text) {
  const records = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    current += character;
    if (character === "'") {
      if (text[index + 1] === "'") {
        current += text[index + 1];
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && character === ";") {
      const trimmed = current.trim();
      if (trimmed) {
        records.push(trimmed.slice(0, -1).trim());
      }
      current = "";
    }
  }
  return records;
}

function parseStepText(text) {
  const normalized = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const dataMatch = normalized.match(/DATA;([\s\S]*?)ENDSEC;/i);
  if (!dataMatch) {
    throw new Error("STEP 文件缺少 DATA 段。");
  }

  const entities = new Map();
  splitRecords(dataMatch[1]).forEach((record) => {
    const match = record.match(/^#(\d+)\s*=\s*([\s\S]+)$/);
    if (!match) {
      return;
    }
    const id = `#${match[1]}`;
    const body = match[2].trim();
    const parser = new StepSyntaxParser(body);
    const entity = body.startsWith("(") ? parser.parseComplexEntity() : parser.parseStandardEntity();
    entity.id = id;
    entity.raw = body;
    entity.refs = [...collectRefs(entity.params)];
    entities.set(id, entity);
  });

  return {
    header: parseHeader(normalized),
    entities,
    rawText: normalized,
  };
}

function normalizeVector(vector, fallback) {
  const length = Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
  if (!length) {
    return { ...fallback };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function scale(vector, factor) {
  return {
    x: vector.x * factor,
    y: vector.y * factor,
    z: vector.z * factor,
  };
}

function orthogonalizeXAxis(rawXAxis, zAxis) {
  const projected = subtract(rawXAxis, scale(zAxis, dot(rawXAxis, zAxis)));
  return normalizeVector(projected, { x: 1, y: 0, z: 0 });
}

function matrixIdentity() {
  return [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
}

function matrixFromPlacement(placement) {
  return [
    [placement.xAxis.x, placement.yAxis.x, placement.zAxis.x, placement.origin.x],
    [placement.xAxis.y, placement.yAxis.y, placement.zAxis.y, placement.origin.y],
    [placement.xAxis.z, placement.yAxis.z, placement.zAxis.z, placement.origin.z],
    [0, 0, 0, 1],
  ];
}

function multiplyMatrices(left, right) {
  const result = matrixIdentity();
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      result[row][column] = 0;
      for (let index = 0; index < 4; index += 1) {
        result[row][column] += left[row][index] * right[index][column];
      }
    }
  }
  return result;
}

function invertRigidMatrix(matrix) {
  const rotationTranspose = [
    [matrix[0][0], matrix[1][0], matrix[2][0]],
    [matrix[0][1], matrix[1][1], matrix[2][1]],
    [matrix[0][2], matrix[1][2], matrix[2][2]],
  ];
  const translation = { x: matrix[0][3], y: matrix[1][3], z: matrix[2][3] };
  const invertedTranslation = {
    x:
      -(rotationTranspose[0][0] * translation.x +
        rotationTranspose[0][1] * translation.y +
        rotationTranspose[0][2] * translation.z),
    y:
      -(rotationTranspose[1][0] * translation.x +
        rotationTranspose[1][1] * translation.y +
        rotationTranspose[1][2] * translation.z),
    z:
      -(rotationTranspose[2][0] * translation.x +
        rotationTranspose[2][1] * translation.y +
        rotationTranspose[2][2] * translation.z),
  };

  return [
    [rotationTranspose[0][0], rotationTranspose[0][1], rotationTranspose[0][2], invertedTranslation.x],
    [rotationTranspose[1][0], rotationTranspose[1][1], rotationTranspose[1][2], invertedTranslation.y],
    [rotationTranspose[2][0], rotationTranspose[2][1], rotationTranspose[2][2], invertedTranslation.z],
    [0, 0, 0, 1],
  ];
}

function applyMatrixToPoint(matrix, point) {
  return {
    x: matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2] * point.z + matrix[0][3],
    y: matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2] * point.z + matrix[1][3],
    z: matrix[2][0] * point.x + matrix[2][1] * point.y + matrix[2][2] * point.z + matrix[2][3],
  };
}

function buildBoxFaces(partId, size) {
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
      area: round(area, 2),
      longestEdge: round(longestEdge, 2),
    };
  });
}

function bboxFromPoints(points) {
  if (!points.length) {
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
  points.forEach((point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    minZ = Math.min(minZ, point.z);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
    maxZ = Math.max(maxZ, point.z);
  });

  const size = {
    x: Math.max(round(maxX - minX, 3), 0.5),
    y: Math.max(round(maxY - minY, 3), 0.5),
    z: Math.max(round(maxZ - minZ, 3), 0.5),
  };

  return {
    min: { x: round(minX, 3), y: round(minY, 3), z: round(minZ, 3) },
    max: { x: round(maxX, 3), y: round(maxY, 3), z: round(maxZ, 3) },
    center: {
      x: round((minX + maxX) / 2, 3),
      y: round((minY + maxY) / 2, 3),
      z: round((minZ + maxZ) / 2, 3),
    },
    size,
  };
}

function transformBBox(bbox, matrix) {
  const half = {
    x: bbox.size.x / 2,
    y: bbox.size.y / 2,
    z: bbox.size.z / 2,
  };
  const corners = [
    { x: bbox.center.x - half.x, y: bbox.center.y - half.y, z: bbox.center.z - half.z },
    { x: bbox.center.x + half.x, y: bbox.center.y - half.y, z: bbox.center.z - half.z },
    { x: bbox.center.x + half.x, y: bbox.center.y + half.y, z: bbox.center.z - half.z },
    { x: bbox.center.x - half.x, y: bbox.center.y + half.y, z: bbox.center.z - half.z },
    { x: bbox.center.x - half.x, y: bbox.center.y - half.y, z: bbox.center.z + half.z },
    { x: bbox.center.x + half.x, y: bbox.center.y - half.y, z: bbox.center.z + half.z },
    { x: bbox.center.x + half.x, y: bbox.center.y + half.y, z: bbox.center.z + half.z },
    { x: bbox.center.x - half.x, y: bbox.center.y + half.y, z: bbox.center.z + half.z },
  ].map((corner) => applyMatrixToPoint(matrix, corner));

  return bboxFromPoints(corners);
}

function collectClosure(entityMap, startRef) {
  const stack = [startRef];
  const visited = new Set();
  while (stack.length) {
    const currentRef = stack.pop();
    if (!currentRef || visited.has(currentRef)) {
      continue;
    }
    visited.add(currentRef);
    const entity = entityMap.get(currentRef);
    if (!entity) {
      continue;
    }
    entity.refs.forEach((ref) => {
      if (!visited.has(ref)) {
        stack.push(ref);
      }
    });
  }
  return visited;
}

function pickColor(seed) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildThumbnailSvg({ projectName, sourceFileName, partCount, assemblyCount, accent, nodes, bounds }) {
  const parts = nodes.filter((node) => node.kind === "part").slice(0, 10);
  const worldWidth = Math.max(bounds.size.x, 1);
  const worldHeight = Math.max(bounds.size.y, 1);
  const shapes = parts
    .map((part) => {
      const normalizedX = (part.bbox.center.x - bounds.min.x) / worldWidth;
      const normalizedY = (part.bbox.center.y - bounds.min.y) / worldHeight;
      const boxWidth = Math.max(18, Math.min(84, (part.bbox.size.x / worldWidth) * 240 + 18));
      const boxHeight = Math.max(14, Math.min(52, (part.bbox.size.y / worldHeight) * 140 + 14));
      const x = 120 + normalizedX * 250 - boxWidth / 2;
      const y = 72 + normalizedY * 140 - boxHeight / 2;
      return `<rect x="${round(x, 1)}" y="${round(y, 1)}" width="${round(boxWidth, 1)}" height="${round(
        boxHeight,
        1,
      )}" rx="10" fill="${part.color}" fill-opacity="0.26" stroke="#DCE7FB" stroke-opacity="0.38" stroke-width="2"/>`;
    })
    .join("");

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
  ${shapes}
  <rect x="124" y="228" width="272" height="1" fill="white" fill-opacity="0.12"/>
  <text x="36" y="52" fill="white" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="24" font-weight="700">${escapeXml(projectName)}</text>
  <text x="36" y="82" fill="#D0DAE9" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="15">${escapeXml(sourceFileName)}</text>
  <text x="36" y="274" fill="#B5C1D3" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="16">装配 ${assemblyCount}  ·  零件 ${partCount}</text>
  <text x="36" y="298" fill="#7F92AA" font-family="Microsoft YaHei, Segoe UI, sans-serif" font-size="14">STEP Text Parse · Real Structure / Proxy Geometry</text>
</svg>
`.trim();
}

function applyPaths(rootId, nodes) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  function walk(nodeId, pathNames) {
    const node = nodeMap.get(nodeId);
    if (!node) {
      return;
    }
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
    if (!node) {
      return { partCount: 0, assemblyCount: 0, faceCount: 0, solidCount: 0 };
    }
    if (node.kind === "part") {
      const stats = {
        partCount: 1,
        assemblyCount: 0,
        faceCount: node.topology?.faceCount || 0,
        solidCount: node.topology?.solidCount || 0,
      };
      node.stats = stats;
      return stats;
    }
    const totals = { partCount: 0, assemblyCount: 1, faceCount: 0, solidCount: 0 };
    node.children.forEach((childId) => {
      const childStats = collect(childId);
      totals.partCount += childStats.partCount;
      totals.assemblyCount += childStats.assemblyCount;
      totals.faceCount += childStats.faceCount;
      totals.solidCount += childStats.solidCount;
    });
    node.stats = totals;
    return totals;
  }
  return collect(rootId);
}

function calculateBounds(nodes) {
  const parts = nodes.filter((node) => node.kind === "part");
  if (!parts.length) {
    return bboxFromPoints([]);
  }
  const points = [];
  parts.forEach((part) => {
    points.push(part.bbox.min, part.bbox.max);
  });
  return bboxFromPoints(points);
}

function toVector(entityMap, ref, fallback) {
  const entity = entityMap.get(ref);
  if (!entity || entity.type !== "DIRECTION") {
    return { ...fallback };
  }
  const values = entity.params[1] || [];
  return {
    x: Number(values[0] || fallback.x),
    y: Number(values[1] || fallback.y),
    z: Number(values[2] || fallback.z),
  };
}

function toPoint(entityMap, ref, fallback = { x: 0, y: 0, z: 0 }) {
  const entity = entityMap.get(ref);
  if (!entity || entity.type !== "CARTESIAN_POINT") {
    return { ...fallback };
  }
  const values = entity.params[1] || [];
  return {
    x: Number(values[0] || 0),
    y: Number(values[1] || 0),
    z: Number(values[2] || 0),
  };
}

function readPlacement(entityMap, ref) {
  const entity = entityMap.get(ref);
  if (!entity || entity.type !== "AXIS2_PLACEMENT_3D") {
    return {
      origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      zAxis: { x: 0, y: 0, z: 1 },
    };
  }

  const origin = toPoint(entityMap, refValue(entity.params[1]));
  const zAxis = normalizeVector(toVector(entityMap, refValue(entity.params[2]), { x: 0, y: 0, z: 1 }), {
    x: 0,
    y: 0,
    z: 1,
  });
  const rawXAxis = normalizeVector(toVector(entityMap, refValue(entity.params[3]), { x: 1, y: 0, z: 0 }), {
    x: 1,
    y: 0,
    z: 0,
  });
  const xAxis = orthogonalizeXAxis(rawXAxis, zAxis);
  const yAxis = normalizeVector(cross(zAxis, xAxis), { x: 0, y: 1, z: 0 });

  return { origin, xAxis, yAxis, zAxis };
}

function readMeaningfulName(value) {
  const text = String(value || "").trim();
  if (!text || text === "NONE") {
    return "";
  }
  return text;
}

function isMeaninglessOccurrenceName(name) {
  return !name || /^NAUO\d+$/i.test(name) || name === "NONE";
}

function detectLengthUnit(rawText) {
  if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\./i.test(rawText)) {
    return "mm";
  }
  if (/SI_UNIT\s*\(\s*\.CENTI\.\s*,\s*\.METRE\./i.test(rawText)) {
    return "cm";
  }
  if (/\.METRE\./i.test(rawText)) {
    return "m";
  }
  return "model";
}

function buildSemanticIndex(parsed) {
  const { entities } = parsed;
  const products = new Map();
  const formations = new Map();
  const productDefinitions = new Map();
  const pdsTargets = new Map();
  const shapeRepresentationByTarget = new Map();
  const geometryRepresentationLinks = new Map();
  const occurrences = new Map();
  const occurrencesByParent = new Map();
  const occurrenceTransformRelation = new Map();

  entities.forEach((entity, id) => {
    if (entity.type === "PRODUCT") {
      products.set(id, {
        id,
        name: readMeaningfulName(entity.params[0]) || id,
      });
      return;
    }

    if (entity.type.startsWith("PRODUCT_DEFINITION_FORMATION")) {
      formations.set(id, {
        id,
        productId: refValue(entity.params[2]),
      });
      return;
    }

    if (entity.type === "PRODUCT_DEFINITION_SHAPE") {
      const targetId = refValue(entity.params[2]);
      if (targetId) {
        pdsTargets.set(id, targetId);
      }
      return;
    }

    if (entity.type.startsWith("PRODUCT_DEFINITION")) {
      const formationId = refValue(entity.params[2]);
      const productId = formations.get(formationId)?.productId || null;
      const productName = products.get(productId)?.name || readMeaningfulName(entity.params[0]) || id;
      productDefinitions.set(id, {
        id,
        formationId,
        productId,
        name: productName,
      });
      return;
    }

    if (entity.type === "SHAPE_DEFINITION_REPRESENTATION") {
      const pdsId = refValue(entity.params[0]);
      const targetId = pdsTargets.get(pdsId);
      const representationId = refValue(entity.params[1]);
      if (targetId && representationId) {
        shapeRepresentationByTarget.set(targetId, representationId);
      }
      return;
    }

    if (entity.type === "SHAPE_REPRESENTATION_RELATIONSHIP") {
      const sourceRepresentationId = refValue(entity.params[2]);
      const targetRepresentationId = refValue(entity.params[3]);
      if (sourceRepresentationId && targetRepresentationId) {
        const linked = geometryRepresentationLinks.get(sourceRepresentationId) || [];
        linked.push(targetRepresentationId);
        geometryRepresentationLinks.set(sourceRepresentationId, linked);
      }
      return;
    }

    if (entity.type === "NEXT_ASSEMBLY_USAGE_OCCURRENCE") {
      const occurrence = {
        id,
        name: readMeaningfulName(entity.params[0]),
        parentDefinitionId: refValue(entity.params[3]),
        childDefinitionId: refValue(entity.params[4]),
      };
      occurrences.set(id, occurrence);
      if (occurrence.parentDefinitionId) {
        const siblings = occurrencesByParent.get(occurrence.parentDefinitionId) || [];
        siblings.push(occurrence);
        occurrencesByParent.set(occurrence.parentDefinitionId, siblings);
      }
      return;
    }

    if (entity.type === "CONTEXT_DEPENDENT_SHAPE_REPRESENTATION") {
      const relationId = refValue(entity.params[0]);
      const pdsId = refValue(entity.params[1]);
      const targetId = pdsTargets.get(pdsId);
      if (targetId) {
        occurrenceTransformRelation.set(targetId, relationId);
      }
    }
  });

  const allChildDefinitions = new Set([...occurrences.values()].map((occurrence) => occurrence.childDefinitionId));
  const candidateRoots = [...occurrencesByParent.keys()].filter((definitionId) => !allChildDefinitions.has(definitionId));
  const rootDefinitions = candidateRoots.length
    ? candidateRoots
    : [...shapeRepresentationByTarget.keys()].filter(
        (targetId) => productDefinitions.has(targetId) && !allChildDefinitions.has(targetId),
      );

  return {
    products,
    formations,
    productDefinitions,
    shapeRepresentationByTarget,
    geometryRepresentationLinks,
    occurrences,
    occurrencesByParent,
    occurrenceTransformRelation,
    rootDefinitions: rootDefinitions.length ? rootDefinitions : [...productDefinitions.keys()].slice(0, 1),
  };
}

function buildProjectPayloadFromParsed(parsed, options) {
  const { entities } = parsed;
  const index = buildSemanticIndex(parsed);
  const geometryCache = new Map();
  const transformCache = new Map();
  const unitLabel = detectLengthUnit(parsed.rawText);

  function geometryForRepresentation(representationId) {
    if (!representationId) {
      return {
        bbox: bboxFromPoints([]),
        topology: { faceCount: 0, solidCount: 0, pointCount: 0, representationId: null },
      };
    }

    if (geometryCache.has(representationId)) {
      return geometryCache.get(representationId);
    }

    const representationRefs = [representationId];
    const queuedRepresentations = [representationId];
    const seenRepresentations = new Set();
    while (queuedRepresentations.length) {
      const currentRepresentationId = queuedRepresentations.pop();
      if (!currentRepresentationId || seenRepresentations.has(currentRepresentationId)) {
        continue;
      }
      seenRepresentations.add(currentRepresentationId);
      const linkedRepresentations = index.geometryRepresentationLinks.get(currentRepresentationId) || [];
      linkedRepresentations.forEach((linkedRepresentationId) => {
        if (!seenRepresentations.has(linkedRepresentationId)) {
          representationRefs.push(linkedRepresentationId);
          queuedRepresentations.push(linkedRepresentationId);
        }
      });
    }

    const closure = new Set();
    representationRefs.forEach((representationRef) => {
      collectClosure(entities, representationRef).forEach((ref) => closure.add(ref));
    });
    const points = [];
    let faceCount = 0;
    let solidCount = 0;

    closure.forEach((ref) => {
      const entity = entities.get(ref);
      if (!entity) {
        return;
      }
      if (entity.type === "CARTESIAN_POINT") {
        points.push(toPoint(entities, ref));
      }
      if (entity.type === "ADVANCED_FACE") {
        faceCount += 1;
      }
      if (["MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "SHELL_BASED_SURFACE_MODEL"].includes(entity.type)) {
        solidCount += 1;
      }
    });

    const geometry = {
      bbox: bboxFromPoints(points),
      topology: {
        faceCount,
        solidCount,
        pointCount: points.length,
        representationId,
      },
    };
    geometryCache.set(representationId, geometry);
    return geometry;
  }

  function transformForOccurrence(occurrenceId) {
    if (!occurrenceId) {
      return matrixIdentity();
    }
    if (transformCache.has(occurrenceId)) {
      return transformCache.get(occurrenceId);
    }

    const relationId = index.occurrenceTransformRelation.get(occurrenceId);
    const relationEntity = entities.get(relationId);
    const transformId = relationEntity
      ? refValue(relationEntity.components.REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION?.[0])
      : null;
    const transformEntity = entities.get(transformId);
    if (!transformEntity || transformEntity.type !== "ITEM_DEFINED_TRANSFORMATION") {
      const identity = matrixIdentity();
      transformCache.set(occurrenceId, identity);
      return identity;
    }

    const sourcePlacement = readPlacement(entities, refValue(transformEntity.params[2]));
    const targetPlacement = readPlacement(entities, refValue(transformEntity.params[3]));
    const matrix = multiplyMatrices(
      matrixFromPlacement(targetPlacement),
      invertRigidMatrix(matrixFromPlacement(sourcePlacement)),
    );
    transformCache.set(occurrenceId, matrix);
    return matrix;
  }

  const nodes = [];

  function representationLabel(definitionId) {
    const startRepresentationId = index.shapeRepresentationByTarget.get(definitionId);
    const queue = startRepresentationId ? [startRepresentationId] : [];
    const seen = new Set();
    while (queue.length) {
      const representationId = queue.shift();
      if (!representationId || seen.has(representationId)) {
        continue;
      }
      seen.add(representationId);
      const entity = entities.get(representationId);
      const candidate = readMeaningfulName(entity?.params?.[0]);
      if (candidate && candidate !== "UNKNOWN") {
        return candidate;
      }
      (index.geometryRepresentationLinks.get(representationId) || []).forEach((linkedId) => {
        if (!seen.has(linkedId)) {
          queue.push(linkedId);
        }
      });
    }
    return "";
  }

  function addNode(node) {
    nodes.push(node);
    return node.id;
  }

  function definitionLabel(definitionId, occurrenceName) {
    const definition = index.productDefinitions.get(definitionId);
    if (occurrenceName && !isMeaninglessOccurrenceName(occurrenceName)) {
      return occurrenceName;
    }
    const definitionName = readMeaningfulName(definition?.name);
    if (definitionName && definitionName !== "UNKNOWN") {
      return definitionName;
    }
    return representationLabel(definitionId) || definitionName || options.projectName || definitionId;
  }

  function buildNode({ parentId, definitionId, occurrenceId, worldMatrix, forceAssembly = false }) {
    const definition = index.productDefinitions.get(definitionId);
    const representationId = index.shapeRepresentationByTarget.get(definitionId) || null;
    const geometry = geometryForRepresentation(representationId);
    const children = index.occurrencesByParent.get(definitionId) || [];
    const occurrence = occurrenceId ? index.occurrences.get(occurrenceId) : null;
    const name = definitionLabel(definitionId, occurrence?.name);
    const color = pickColor(`${definitionId}:${name}`);

    if (children.length || forceAssembly) {
      const assemblyId = occurrenceId ? `asm-${stripRef(occurrenceId)}` : `asm-${stripRef(definitionId)}`;
      const node = {
        id: assemblyId,
        parentId,
        kind: "assembly",
        name,
        color,
        children: [],
        source: {
          occurrenceId,
          definitionId,
          productId: definition?.productId || null,
          representationId,
        },
      };
      addNode(node);
      children.forEach((childOccurrence) => {
        const childWorld = multiplyMatrices(worldMatrix, transformForOccurrence(childOccurrence.id));
        const childId = buildNode({
          parentId: node.id,
          definitionId: childOccurrence.childDefinitionId,
          occurrenceId: childOccurrence.id,
          worldMatrix: childWorld,
        });
        if (childId) {
          node.children.push(childId);
        }
      });
      return node.id;
    }

    const worldBBox = transformBBox(geometry.bbox, worldMatrix);
    const partId = occurrenceId ? `part-${stripRef(occurrenceId)}` : `part-${stripRef(definitionId)}`;
    addNode({
      id: partId,
      parentId,
      kind: "part",
      name,
      children: [],
      color,
      material: `STEP ${unitLabel.toUpperCase()} / 包围盒代理`,
      quantity: 1,
      bbox: {
        center: {
          x: round(worldBBox.center.x, 3),
          y: round(worldBBox.center.y, 3),
          z: round(worldBBox.center.z, 3),
        },
        size: {
          x: round(worldBBox.size.x, 3),
          y: round(worldBBox.size.y, 3),
          z: round(worldBBox.size.z, 3),
        },
        min: worldBBox.min,
        max: worldBBox.max,
      },
      faces: buildBoxFaces(partId, worldBBox.size),
      topology: geometry.topology,
      source: {
        occurrenceId,
        definitionId,
        productId: definition?.productId || null,
        representationId,
      },
    });
    return partId;
  }

  const rootDefinitions = index.rootDefinitions.filter(Boolean);
  let rootId = null;
  if (rootDefinitions.length === 1 && (index.occurrencesByParent.get(rootDefinitions[0]) || []).length) {
    rootId = buildNode({
      parentId: null,
      definitionId: rootDefinitions[0],
      occurrenceId: null,
      worldMatrix: matrixIdentity(),
      forceAssembly: true,
    });
  } else {
    rootId = addNode({
      id: "asm-root",
      parentId: null,
      kind: "assembly",
      name: options.projectName,
      color: pickColor(options.projectName),
      children: [],
      source: {
        occurrenceId: null,
        definitionId: null,
        productId: null,
        representationId: null,
      },
    });

    const fallbackDefinitions = rootDefinitions.length
      ? rootDefinitions
      : [...index.shapeRepresentationByTarget.keys()].filter((targetId) => index.productDefinitions.has(targetId));

    fallbackDefinitions.forEach((definitionId) => {
      const childId = buildNode({
        parentId: rootId,
        definitionId,
        occurrenceId: null,
        worldMatrix: matrixIdentity(),
        forceAssembly: (index.occurrencesByParent.get(definitionId) || []).length > 0,
      });
      const rootNode = nodes.find((node) => node.id === rootId);
      if (childId) {
        rootNode.children.push(childId);
      }
    });
  }

  applyPaths(rootId, nodes);
  const stats = applyAssemblyStats(rootId, nodes);
  const bounds = calculateBounds(nodes);
  const firstPart = nodes.find((node) => node.kind === "part");
  const sourceModelName =
    (rootDefinitions[0] && index.productDefinitions.get(rootDefinitions[0])?.name) ||
    parsed.header.originalFileName ||
    options.projectName;
  const accent = pickColor(sourceModelName);

  return {
    rootId,
    bounds,
    defaultSelectionId: firstPart?.id || null,
    nodes,
    stats: {
      partCount: stats.partCount,
      assemblyCount: Math.max(stats.assemblyCount, 1),
      faceCount: stats.faceCount,
      solidCount: stats.solidCount,
    },
    meta: {
      parserMode: "step-text",
      geometryMode: "bbox-proxy",
      sourceModelName,
      sourceSchema: parsed.header.schema,
      originalFileName: parsed.header.originalFileName,
      unitLabel,
      productDefinitionCount: index.productDefinitions.size,
      occurrenceCount: index.occurrences.size,
    },
    thumbnailSvg: buildThumbnailSvg({
      projectName: options.projectName,
      sourceFileName: options.sourceFileName,
      partCount: stats.partCount,
      assemblyCount: Math.max(stats.assemblyCount, 1),
      accent,
      nodes,
      bounds,
    }),
  };
}

async function buildProjectPayloadFromStepFile(filePath, options) {
  const content = await fs.readFile(filePath, "utf8");
  const parsed = parseStepText(content);
  return buildProjectPayloadFromParsed(parsed, options);
}

module.exports = {
  buildProjectPayloadFromStepFile,
};
