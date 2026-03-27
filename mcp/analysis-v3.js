const {
  buildBasePartCandidates,
  buildMatingCandidates,
  buildInsertionCandidates,
  checkInterference,
} = require("./analysis-v2");

const FASTENER_NAME_PATTERN = /pin|bolt|screw|nut|washer|fastener|thread|stud|螺|销|垫/i;

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function vectorLength(vector = {}) {
  return Math.sqrt((vector.x || 0) ** 2 + (vector.y || 0) ** 2 + (vector.z || 0) ** 2);
}

function normalize(vector, fallback = { x: 0, y: 0, z: 1 }) {
  const length = vectorLength(vector);
  if (!length) {
    return { ...fallback };
  }
  return {
    x: (vector.x || 0) / length,
    y: (vector.y || 0) / length,
    z: (vector.z || 0) / length,
  };
}

function dot(a = {}, b = {}) {
  return (a.x || 0) * (b.x || 0) + (a.y || 0) * (b.y || 0) + (a.z || 0) * (b.z || 0);
}

function subtract(a = {}, b = {}) {
  return {
    x: (a.x || 0) - (b.x || 0),
    y: (a.y || 0) - (b.y || 0),
    z: (a.z || 0) - (b.z || 0),
  };
}

function average(values = []) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unique(values = []) {
  return [...new Set(values.filter((value) => value != null))];
}

function bboxVolume(bbox = {}) {
  return (bbox?.size?.x || 0) * (bbox?.size?.y || 0) * (bbox?.size?.z || 0);
}

function buildNodeMap(details) {
  return new Map((details.assembly?.nodes || []).map((node) => [node.id, node]));
}

function buildPartMap(details) {
  return new Map((details.assembly?.nodes || []).filter((node) => node.kind === "part").map((node) => [node.id, node]));
}

function sanitizeScopedPartIds(partMap, partIds = []) {
  return unique(Array.isArray(partIds) ? partIds : [partIds]).filter((partId) => partMap.has(partId));
}

function buildParentMap(details) {
  const parentMap = new Map();
  (details.assembly?.nodes || []).forEach((node) => {
    (node.children || []).forEach((childId) => {
      parentMap.set(childId, node.id);
    });
  });
  return parentMap;
}

function buildScopedNodeIds(details, partIds = []) {
  if (!partIds.length) {
    return null;
  }

  const nodeMap = buildNodeMap(details);
  const parentMap = buildParentMap(details);
  const scopedNodeIds = new Set();

  partIds.forEach((partId) => {
    let currentId = partId;
    while (currentId && nodeMap.has(currentId) && !scopedNodeIds.has(currentId)) {
      scopedNodeIds.add(currentId);
      currentId = parentMap.get(currentId) || null;
    }
  });

  return scopedNodeIds;
}

function buildTree(nodeMap, nodeId, maxDepth, depth = 0, allowedNodeIds = null) {
  const node = nodeMap.get(nodeId);
  if (!node || (allowedNodeIds && !allowedNodeIds.has(nodeId))) {
    return null;
  }

  const payload = {
    id: node.id,
    name: node.name,
    kind: node.kind,
    pathNames: node.pathNames,
    bbox: node.bbox || null,
    children: [],
  };

  if (maxDepth == null || depth < maxDepth - 1) {
    payload.children = (node.children || [])
      .map((childId) => buildTree(nodeMap, childId, maxDepth, depth + 1, allowedNodeIds))
      .filter(Boolean);
  }

  return payload;
}

function inferPartTags(part, maxVolume) {
  const tags = [];
  if (FASTENER_NAME_PATTERN.test(part.name || "")) {
    tags.push("fastener_like");
  }
  if (bboxVolume(part.bbox) >= maxVolume * 0.22) {
    tags.push("structure_like");
  }
  if ((part.faces || []).some((face) => face.geometry?.type === "cylinder")) {
    tags.push("has_cylindrical_features");
  }
  return unique(tags);
}

function summarizeFace(face) {
  return {
    faceId: face.id,
    name: face.name || face.id,
    geometry: {
      type: face.geometry?.type || "unknown",
      radius: face.geometry?.radius != null ? round(face.geometry.radius) : null,
      axisOrigin: face.geometry?.axisOrigin || null,
      axisDirection: face.geometry?.axisDirection || null,
    },
    center: face.center || null,
    normal: face.normal || null,
    area: round(face.area || 0),
    longestEdge: round(face.longestEdge || 0),
  };
}

function inferFeatureKind(faces = []) {
  const geometryTypes = unique(faces.map((face) => face.geometry?.type || "unknown"));
  if (!geometryTypes.length) {
    return "unknown_group";
  }
  if (geometryTypes.length === 1 && geometryTypes[0] === "cylinder") {
    return "cylindrical_group";
  }
  if (geometryTypes.length === 1 && geometryTypes[0] === "plane") {
    return "planar_group";
  }
  if (geometryTypes.includes("cylinder") && geometryTypes.includes("plane")) {
    return "mixed_mating_group";
  }
  return `${geometryTypes[0]}_group`;
}

function summarizeFeatureGroup(part, faces = [], featureId) {
  const geometryTypes = unique(faces.map((face) => face.geometry?.type || "unknown"));
  const primaryCylinder = faces.find((face) => face.geometry?.type === "cylinder");
  return {
    featureId,
    partId: part.id,
    partName: part.name,
    kind: inferFeatureKind(faces),
    faceIds: unique(faces.map((face) => face.id)),
    geometryTypes,
    faceCount: faces.length,
    areaTotal: round(faces.reduce((sum, face) => sum + (face.area || 0), 0)),
    primaryAxis: primaryCylinder
      ? {
          origin: primaryCylinder.geometry?.axisOrigin || primaryCylinder.center || null,
          direction: normalize(primaryCylinder.geometry?.axisDirection || primaryCylinder.normal || { x: 0, y: 0, z: 1 }),
          radius: primaryCylinder.geometry?.radius != null ? round(primaryCylinder.geometry.radius) : null,
        }
      : null,
  };
}

function inferRelationType(pair, facesA, facesB) {
  const geometryTypes = unique([...facesA, ...facesB].map((face) => face.geometry?.type || "unknown"));
  if (pair.candidateFaces?.some((item) => item.relation === "coaxial-cylinder-candidate")) {
    return "insertable_coaxial_candidate";
  }
  if (pair.candidateFaces?.some((item) => item.relation === "planar-coincident-candidate")) {
    return "planar_contact_candidate";
  }
  if (geometryTypes.includes("cylinder") && geometryTypes.includes("plane")) {
    return "mixed_alignment_candidate";
  }
  return "generic_relation_candidate";
}

function buildRelationCandidates(details, options = {}) {
  const partMap = buildPartMap(details);
  const pairCandidates = buildMatingCandidates(details, {
    partIds: options.partIds,
    topK: Math.max(options.topK || 24, 8),
    facePairLimit: options.facePairLimit || 4,
  });

  return pairCandidates.map((pair, index) => {
    const partA = partMap.get(pair.partAId);
    const partB = partMap.get(pair.partBId);
    const facesA = unique((pair.candidateFaces || []).map((item) => item.faceAId))
      .map((faceId) => partA?.faces?.find((face) => face.id === faceId))
      .filter(Boolean);
    const facesB = unique((pair.candidateFaces || []).map((item) => item.faceBId))
      .map((faceId) => partB?.faces?.find((face) => face.id === faceId))
      .filter(Boolean);
    const relationType = inferRelationType(pair, facesA, facesB);
    const topFace = pair.candidateFaces?.[0] || null;
    const sharedAxis = topFace?.relation === "coaxial-cylinder-candidate" && facesA[0] && facesB[0]
      ? {
          origin: facesA[0].geometry?.axisOrigin || facesA[0].center || null,
          direction: normalize(facesA[0].geometry?.axisDirection || facesA[0].normal || { x: 0, y: 0, z: 1 }),
        }
      : null;

    return {
      candidateId: `relation:${pair.pairId}`,
      order: index + 1,
      partAId: pair.partAId,
      partAName: pair.partAName,
      partBId: pair.partBId,
      partBName: pair.partBName,
      featureGroupA: summarizeFeatureGroup(partA || { id: pair.partAId, name: pair.partAName }, facesA, `fg:${pair.pairId}:A`),
      featureGroupB: summarizeFeatureGroup(partB || { id: pair.partBId, name: pair.partBName }, facesB, `fg:${pair.pairId}:B`),
      relationType,
      sharedAxis,
      bboxGap: round(pair.bboxGap || 0),
      score: round(pair.score || 0),
      ruleEvidence: unique((pair.candidateFaces || []).flatMap((item) => item.evidence || [])).slice(0, 12),
      facePairs: (pair.candidateFaces || []).map((item) => ({
        faceAId: item.faceAId,
        faceBId: item.faceBId,
        relation: item.relation,
        score: round(item.score || 0),
        gap: round(item.gap || 0),
      })),
    };
  }).slice(0, options.topK || 24);
}

function buildSubassemblyCandidates(details, relationCandidates, options = {}) {
  const partMap = buildPartMap(details);
  const scopedPartIds = sanitizeScopedPartIds(partMap, options.partIds);
  const partIds = scopedPartIds.length ? scopedPartIds : [...partMap.keys()];
  const threshold = options.threshold || 0.58;
  const adjacency = new Map(partIds.map((partId) => [partId, new Set()]));

  relationCandidates.forEach((candidate) => {
    if (candidate.score < threshold) {
      return;
    }
    adjacency.get(candidate.partAId)?.add(candidate.partBId);
    adjacency.get(candidate.partBId)?.add(candidate.partAId);
  });

  const visited = new Set();
  const components = [];
  partIds.forEach((partId) => {
    if (visited.has(partId)) {
      return;
    }
    const stack = [partId];
    const component = [];
    visited.add(partId);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      (adjacency.get(current) || []).forEach((neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      });
    }
    if (component.length >= 2 && component.length <= 5) {
      components.push(component.sort());
    }
  });

  const scored = components.map((component) => {
    const internalScores = relationCandidates
      .filter((candidate) => component.includes(candidate.partAId) && component.includes(candidate.partBId))
      .map((candidate) => candidate.score);
    const externalScores = relationCandidates
      .filter((candidate) => {
        const hasA = component.includes(candidate.partAId);
        const hasB = component.includes(candidate.partBId);
        return (hasA || hasB) && hasA !== hasB;
      })
      .map((candidate) => candidate.score);
    const internalScore = average(internalScores);
    const externalScore = average(externalScores);
    const score = clamp(internalScore * 0.75 + (1 - externalScore) * 0.25, 0, 1);
    const reasons = [];
    if (internalScore >= 0.65) reasons.push("dense_internal_relations");
    if (externalScore <= 0.35) reasons.push("weak_external_relations");
    if (component.length >= 3) reasons.push("multi_part_cluster");
    return {
      candidateId: `subassembly:${component.join("+")}`,
      partIds: component,
      score: round(score),
      internalScore: round(internalScore),
      externalScore: round(externalScore),
      reasons,
    };
  });

  if (scored.length) {
    return scored.sort((left, right) => right.score - left.score).slice(0, options.topK || 8);
  }

  return relationCandidates.slice(0, Math.min(options.topK || 4, relationCandidates.length)).map((candidate) => ({
    candidateId: `subassembly:${candidate.partAId}+${candidate.partBId}`,
    partIds: [candidate.partAId, candidate.partBId],
    score: round(candidate.score),
    internalScore: round(candidate.score),
    externalScore: 0,
    reasons: ["strong_pair_relation"],
  }));
}

function buildGraspCandidates(details, relationCandidates, options = {}) {
  const partMap = buildPartMap(details);
  const scopedPartIds = sanitizeScopedPartIds(partMap, options.partIds);
  const parts = scopedPartIds.length
    ? scopedPartIds.map((partId) => partMap.get(partId)).filter(Boolean)
    : [...partMap.values()];
  const maxFaceArea = Math.max(
    1,
    ...parts.flatMap((part) => (part.faces || []).map((face) => face.area || 0)),
  );

  const candidates = [];

  parts.forEach((part) => {
    const planarFaces = (part.faces || []).filter((face) => face.geometry?.type === "plane").sort((left, right) => (right.area || 0) - (left.area || 0));
    const cylindricalFaces = (part.faces || []).filter((face) => face.geometry?.type === "cylinder").sort((left, right) => (right.area || 0) - (left.area || 0));
    const avoidFaceIds = unique(
      relationCandidates
        .filter((candidate) => candidate.partAId === part.id || candidate.partBId === part.id)
        .slice(0, 4)
        .flatMap((candidate) => candidate.partAId === part.id ? candidate.featureGroupA.faceIds : candidate.featureGroupB.faceIds),
    );

    for (let index = 0; index < planarFaces.length; index += 1) {
      const faceA = planarFaces[index];
      const faceB = planarFaces[index + 1];
      if (!faceA || !faceB) {
        break;
      }
      const normalA = normalize(faceA.normal || { x: 0, y: 0, z: 1 });
      const normalB = normalize(faceB.normal || { x: 0, y: 0, z: 1 });
      const alignment = Math.abs(dot(normalA, normalB));
      const areaScore = Math.min(faceA.area || 0, faceB.area || 0) / Math.max(faceA.area || 1, faceB.area || 1);
      const scaleScore = Math.min(1, Math.max(faceA.area || 0, faceB.area || 0) / maxFaceArea);
      const score = clamp(alignment * 0.4 + areaScore * 0.3 + scaleScore * 0.3, 0, 1);
      if (score < 0.42) {
        continue;
      }
      candidates.push({
        candidateId: `grasp:${part.id}:planar:${faceA.id}:${faceB.id}`,
        partId: part.id,
        partName: part.name,
        featureGroup: {
          featureId: `grip:${part.id}:planar:${faceA.id}:${faceB.id}`,
          kind: "planar_grip_pair",
          faceIds: [faceA.id, faceB.id],
        },
        recommendedGripperTypes: ["parallel_jaw", "soft_jaw"],
        approachDirections: [
          normalize(faceA.normal || { x: 0, y: 0, z: 1 }),
          normalize(faceB.normal || { x: 0, y: 0, z: -1 }),
        ],
        avoidFaceIds,
        score: round(score),
      });
      break;
    }

    const cylinder = cylindricalFaces[0];
    if (cylinder) {
      const cylinderScore = clamp((cylinder.area || 0) / maxFaceArea, 0, 1) * 0.65 + (FASTENER_NAME_PATTERN.test(part.name || "") ? 0.15 : 0.05);
      candidates.push({
        candidateId: `grasp:${part.id}:cylinder:${cylinder.id}`,
        partId: part.id,
        partName: part.name,
        featureGroup: {
          featureId: `grip:${part.id}:cylinder:${cylinder.id}`,
          kind: "cylindrical_grip_band",
          faceIds: [cylinder.id],
        },
        recommendedGripperTypes: FASTENER_NAME_PATTERN.test(part.name || "") ? ["collet", "soft_jaw"] : ["soft_jaw", "parallel_jaw"],
        approachDirections: [],
        referenceAxis: normalize(cylinder.geometry?.axisDirection || cylinder.normal || { x: 0, y: 0, z: 1 }),
        avoidFaceIds,
        score: round(clamp(cylinderScore, 0, 1)),
      });
    }
  });

  return candidates.sort((left, right) => right.score - left.score).slice(0, options.topK || 12);
}

function buildAnalysisCandidates(details, options = {}) {
  const partMap = buildPartMap(details);
  const scopedPartIds = sanitizeScopedPartIds(partMap, options.partIds);
  const scopedOptions = {
    ...options,
    partIds: scopedPartIds.length ? scopedPartIds : undefined,
  };
  const relationCandidates = buildRelationCandidates(details, scopedOptions);
  const baseCandidates = buildBasePartCandidates(details, {
    topK: options.baseTopK || 8,
    partIds: scopedOptions.partIds,
  });
  const subassemblyCandidates = buildSubassemblyCandidates(details, relationCandidates, scopedOptions);
  const graspCandidates = buildGraspCandidates(details, relationCandidates, scopedOptions);
  const candidateMap = new Map();

  relationCandidates.forEach((candidate) => candidateMap.set(candidate.candidateId, { type: "relation", candidate }));
  baseCandidates.forEach((candidate) => candidateMap.set(`base:${candidate.partId}`, { type: "base", candidate }));
  subassemblyCandidates.forEach((candidate) => candidateMap.set(candidate.candidateId, { type: "subassembly", candidate }));
  graspCandidates.forEach((candidate) => candidateMap.set(candidate.candidateId, { type: "grasp", candidate }));

  return {
    relationCandidates,
    baseCandidates,
    subassemblyCandidates,
    graspCandidates,
    candidateMap,
  };
}

function buildModelContext(details, options = {}) {
  const nodeMap = buildNodeMap(details);
  const partMap = buildPartMap(details);
  const scopedPartIds = sanitizeScopedPartIds(partMap, options.partIds);
  const scopedNodeIds = buildScopedNodeIds(details, scopedPartIds);
  const maxVolume = Math.max(1, ...[...partMap.values()].map((part) => bboxVolume(part.bbox)));
  const maxFaceCountPerPart = Math.max(1, options.maxFaceCountPerPart || 256);
  const includeFaces = options.summaryOnly ? false : options.includeFaces !== false;
  const parts = scopedPartIds.length
    ? scopedPartIds.map((partId) => partMap.get(partId)).filter(Boolean)
    : [...partMap.values()];

  return {
    projectId: details.manifest.projectId,
    projectName: details.manifest.projectName,
    modelName: details.manifest.modelName || details.assembly?.meta?.sourceModelName || details.manifest.projectName,
    parserMode: details.manifest.parserMode,
    geometryMode: details.manifest.geometryMode,
    scope: {
      partIds: scopedPartIds,
      isPartial: scopedPartIds.length > 0,
      returnedPartCount: parts.length,
      totalPartCount: details.manifest.partCount || partMap.size,
      maxDepth: options.maxDepth ?? null,
      summaryOnly: Boolean(options.summaryOnly),
      includeFaces,
      maxFaceCountPerPart: includeFaces ? maxFaceCountPerPart : 0,
    },
    assembly: {
      rootId: details.assembly?.rootId || null,
      partCount: details.manifest.partCount || 0,
      faceCount: details.manifest.faceCount || 0,
      assemblyCount: details.manifest.assemblyCount || 0,
      bounds: details.assembly?.bounds || null,
    },
    tree: buildTree(nodeMap, details.assembly?.rootId, options.maxDepth, 0, scopedNodeIds),
    parts: parts.map((part) => ({
      partId: part.id,
      name: part.name,
      pathNames: part.pathNames,
      bbox: part.bbox || null,
      tags: inferPartTags(part, maxVolume),
      faceCount: (part.faces || []).length,
      facesTruncated: (part.faces || []).length > maxFaceCountPerPart,
      faces: includeFaces ? (part.faces || []).slice(0, maxFaceCountPerPart).map(summarizeFace) : [],
    })),
  };
}

function toBoundedInteger(value, fallback, min, max) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return clamp(Math.round(numericValue), min, max);
}

function normalizeCandidateTypes(candidateTypes = []) {
  const aliases = {
    relation: "relation",
    relations: "relation",
    base: "base",
    base_part: "base",
    basepart: "base",
    subassembly: "subassembly",
    subassemblies: "subassembly",
    grasp: "grasp",
    grasps: "grasp",
  };

  const normalized = unique((Array.isArray(candidateTypes) ? candidateTypes : [candidateTypes])
    .map((item) => aliases[String(item || "").trim().toLowerCase()] || null)
    .filter(Boolean));

  return normalized.length ? normalized : ["relation", "base", "subassembly", "grasp"];
}

function formatModelContextPartForTool(part, includeFaces) {
  const payload = {
    partId: part.partId,
    name: part.name,
    pathNames: part.pathNames,
    bbox: part.bbox,
    tags: part.tags,
    faceCount: part.faceCount,
    facesTruncated: part.facesTruncated,
  };

  if (includeFaces) {
    payload.faces = part.faces;
  }

  return payload;
}

function buildModelContextToolPayload(details, options = {}) {
  const summaryOnly = options.summaryOnly == null ? options.includeFaces !== true : Boolean(options.summaryOnly);
  const includeFaces = !summaryOnly && options.includeFaces === true;
  const maxDepth = toBoundedInteger(options.maxDepth, summaryOnly ? 3 : 5, 1, 12);
  const maxFaceCountPerPart = toBoundedInteger(options.maxFaceCountPerPart, 24, 1, 256);
  const payload = buildModelContext(details, {
    partIds: options.partIds,
    maxDepth,
    includeFaces,
    maxFaceCountPerPart,
    summaryOnly,
  });

  return {
    projectId: payload.projectId,
    projectName: payload.projectName,
    modelName: payload.modelName,
    parserMode: payload.parserMode,
    geometryMode: payload.geometryMode,
    scope: payload.scope,
    assembly: payload.assembly,
    tree: payload.tree,
    parts: payload.parts.map((part) => formatModelContextPartForTool(part, includeFaces)),
  };
}

function limitEvidenceEntries(values, limit) {
  return Array.isArray(values) ? values.slice(0, limit) : [];
}

function formatRelationCandidateForTool(candidate, includeEvidence, evidenceLimit) {
  return {
    candidateId: candidate.candidateId,
    order: candidate.order,
    partAId: candidate.partAId,
    partAName: candidate.partAName,
    partBId: candidate.partBId,
    partBName: candidate.partBName,
    featureGroupA: candidate.featureGroupA,
    featureGroupB: candidate.featureGroupB,
    relationType: candidate.relationType,
    sharedAxis: candidate.sharedAxis,
    bboxGap: candidate.bboxGap,
    score: candidate.score,
    ruleEvidence: includeEvidence ? limitEvidenceEntries(candidate.ruleEvidence, evidenceLimit) : [],
    facePairs: includeEvidence ? limitEvidenceEntries(candidate.facePairs, evidenceLimit) : [],
  };
}

function formatBaseCandidateForTool(candidate, includeEvidence, evidenceLimit) {
  return {
    partId: candidate.partId,
    name: candidate.name,
    score: candidate.score,
    volumeScore: candidate.volumeScore,
    supportAreaScore: candidate.supportAreaScore,
    connectivityScore: candidate.connectivityScore,
    centerBias: candidate.centerBias,
    reasons: includeEvidence ? limitEvidenceEntries(candidate.reasons, evidenceLimit) : [],
  };
}

function formatSubassemblyCandidateForTool(candidate, includeEvidence, evidenceLimit) {
  return {
    candidateId: candidate.candidateId,
    partIds: candidate.partIds,
    score: candidate.score,
    internalScore: candidate.internalScore,
    externalScore: candidate.externalScore,
    reasons: includeEvidence ? limitEvidenceEntries(candidate.reasons, evidenceLimit) : [],
  };
}

function formatGraspCandidateForTool(candidate, includeEvidence, evidenceLimit) {
  return {
    candidateId: candidate.candidateId,
    partId: candidate.partId,
    partName: candidate.partName,
    featureGroup: candidate.featureGroup,
    recommendedGripperTypes: candidate.recommendedGripperTypes,
    approachDirections: candidate.approachDirections,
    referenceAxis: candidate.referenceAxis || null,
    avoidFaceIds: includeEvidence ? limitEvidenceEntries(candidate.avoidFaceIds, evidenceLimit) : [],
    score: candidate.score,
  };
}

function buildRelationCandidatesToolPayload(details, options = {}) {
  const partMap = buildPartMap(details);
  const scopedPartIds = sanitizeScopedPartIds(partMap, options.partIds);
  const topK = toBoundedInteger(options.topK, 12, 1, 64);
  const candidateTypes = normalizeCandidateTypes(
    options.candidateTypes?.length
      ? options.candidateTypes
      : [
          "relation",
          options.includeBaseCandidates === false ? null : "base",
          options.includeSubassemblyCandidates === false ? null : "subassembly",
          options.includeGraspCandidates === false ? null : "grasp",
        ],
  );
  const includeEvidence = Boolean(options.includeEvidence);
  const evidenceLimit = toBoundedInteger(options.evidenceLimit, 4, 1, 12);
  const payload = buildAnalysisCandidates(details, {
    partIds: scopedPartIds,
    topK,
    baseTopK: Math.min(topK, 8),
  });

  return {
    projectId: details.manifest.projectId,
    projectName: details.manifest.projectName,
    scope: {
      partIds: scopedPartIds,
      isPartial: scopedPartIds.length > 0,
      candidateTypes,
      topK,
      includeEvidence,
      evidenceLimit,
    },
    relationCandidates: candidateTypes.includes("relation")
      ? payload.relationCandidates.slice(0, topK).map((candidate) => formatRelationCandidateForTool(candidate, includeEvidence, evidenceLimit))
      : [],
    baseCandidates: candidateTypes.includes("base")
      ? payload.baseCandidates.slice(0, Math.min(topK, 8)).map((candidate) => formatBaseCandidateForTool(candidate, includeEvidence, evidenceLimit))
      : [],
    subassemblyCandidates: candidateTypes.includes("subassembly")
      ? payload.subassemblyCandidates.slice(0, Math.min(topK, 8)).map((candidate) => formatSubassemblyCandidateForTool(candidate, includeEvidence, evidenceLimit))
      : [],
    graspCandidates: candidateTypes.includes("grasp")
      ? payload.graspCandidates.slice(0, Math.min(topK, 12)).map((candidate) => formatGraspCandidateForTool(candidate, includeEvidence, evidenceLimit))
      : [],
  };
}

function buildEvidenceTarget(details, input = {}, candidates = buildAnalysisCandidates(details, input)) {
  const partMap = buildPartMap(details);
  const nodeMap = buildNodeMap(details);
  const focusPartIds = unique(input.partIds || []);
  const focusFaceIds = unique(input.focusFaceIds || []);

  if (input.candidateId) {
    const resolved = candidates.candidateMap.get(input.candidateId);
    if (!resolved) {
      throw new Error(`Unknown candidateId: ${input.candidateId}`);
    }

    if (resolved.type === "relation") {
      const candidate = resolved.candidate;
      return {
        type: "relation",
        candidateId: candidate.candidateId,
        partIds: [candidate.partAId, candidate.partBId],
        focusFaceIds: unique([...candidate.featureGroupA.faceIds, ...candidate.featureGroupB.faceIds]),
        overlay: {
          focusPartIds: [candidate.partAId, candidate.partBId],
          basePartId: candidate.partAId,
          assemblingPartId: candidate.partBId,
          baseFaceIds: candidate.featureGroupA.faceIds,
          assemblingFaceIds: candidate.featureGroupB.faceIds,
          insertionAxis: candidate.sharedAxis
            ? {
                origin: candidate.sharedAxis.origin || null,
                direction: candidate.sharedAxis.direction || { x: 0, y: 0, z: 1 },
                length: 16,
              }
            : null,
          interferenceBoxes: [],
        },
      };
    }

    if (resolved.type === "base") {
      const candidate = resolved.candidate;
      return {
        type: "base",
        candidateId: `base:${candidate.partId}`,
        partIds: [candidate.partId],
        focusFaceIds: [],
        overlay: {
          focusPartIds: [candidate.partId],
          basePartId: candidate.partId,
          assemblingPartId: null,
          baseFaceIds: [],
          assemblingFaceIds: [],
          insertionAxis: null,
          interferenceBoxes: [],
        },
      };
    }

    if (resolved.type === "subassembly") {
      const candidate = resolved.candidate;
      return {
        type: "subassembly",
        candidateId: candidate.candidateId,
        partIds: candidate.partIds,
        focusFaceIds: [],
        overlay: {
          focusPartIds: candidate.partIds,
          basePartId: candidate.partIds[0] || null,
          assemblingPartId: candidate.partIds[1] || null,
          baseFaceIds: [],
          assemblingFaceIds: [],
          insertionAxis: null,
          interferenceBoxes: [],
        },
      };
    }

    if (resolved.type === "grasp") {
      const candidate = resolved.candidate;
      return {
        type: "grasp",
        candidateId: candidate.candidateId,
        partIds: [candidate.partId],
        focusFaceIds: candidate.featureGroup.faceIds,
        overlay: {
          focusPartIds: [candidate.partId],
          basePartId: candidate.partId,
          assemblingPartId: null,
          baseFaceIds: candidate.featureGroup.faceIds,
          assemblingFaceIds: [],
          insertionAxis: candidate.referenceAxis
            ? {
                origin: nodeMap.get(candidate.partId)?.bbox?.center || null,
                direction: candidate.referenceAxis,
                length: 14,
              }
            : null,
          interferenceBoxes: [],
        },
      };
    }
  }

  if (focusPartIds.length || focusFaceIds.length) {
    const faceGroups = new Map();
    focusFaceIds.forEach((faceId) => {
      const owner = [...partMap.values()].find((part) => (part.faces || []).some((face) => face.id === faceId));
      if (!owner) {
        return;
      }
      if (!faceGroups.has(owner.id)) {
        faceGroups.set(owner.id, []);
      }
      faceGroups.get(owner.id).push(faceId);
      if (!focusPartIds.includes(owner.id)) {
        focusPartIds.push(owner.id);
      }
    });
    const orderedPartIds = unique(focusPartIds);
    const basePartId = orderedPartIds[0] || null;
    const assemblingPartId = orderedPartIds[1] || null;
    return {
      type: "custom",
      candidateId: null,
      partIds: orderedPartIds,
      focusFaceIds,
      overlay: {
        focusPartIds: orderedPartIds,
        basePartId,
        assemblingPartId,
        baseFaceIds: basePartId ? (faceGroups.get(basePartId) || []) : [],
        assemblingFaceIds: assemblingPartId ? (faceGroups.get(assemblingPartId) || []) : [],
        insertionAxis: null,
        interferenceBoxes: [],
      },
    };
  }

  throw new Error("Evidence bundle requires candidateId, partIds, or focusFaceIds.");
}

function buildRelationCheck(details, hypothesis, candidates) {
  const relationCandidate = hypothesis.relationCandidateId
    ? candidates.candidateMap.get(hypothesis.relationCandidateId)?.candidate
    : candidates.relationCandidates.find((candidate) => {
        const matchA = candidate.partAId === hypothesis.partAId || candidate.partAId === hypothesis.basePartId;
        const matchB = candidate.partBId === hypothesis.partBId || candidate.partBId === hypothesis.movingPartId || candidate.partBId === hypothesis.assemblingPartId;
        const reverseA = candidate.partBId === hypothesis.partAId || candidate.partBId === hypothesis.basePartId;
        const reverseB = candidate.partAId === hypothesis.partBId || candidate.partAId === hypothesis.movingPartId || candidate.partAId === hypothesis.assemblingPartId;
        return (matchA && matchB) || (reverseA && reverseB);
      });

  if (!relationCandidate) {
    return {
      ok: false,
      score: 0,
      reasons: ["no_matching_relation_candidate"],
      relationCandidateId: null,
    };
  }

  return {
    ok: relationCandidate.score >= 0.55,
    score: round(relationCandidate.score),
    reasons: relationCandidate.ruleEvidence.slice(0, 6),
    relationCandidateId: relationCandidate.candidateId,
  };
}

function buildBaseCheck(hypothesis, candidates) {
  const basePartId = hypothesis.basePartId || hypothesis.partId || null;
  const candidate = basePartId
    ? candidates.baseCandidates.find((item) => item.partId === basePartId)
    : null;

  return {
    ok: Boolean(candidate && candidate.score >= 0.45),
    score: round(candidate?.score || 0),
    reasons: candidate?.reasons || ["base_part_not_ranked"],
    partId: basePartId,
  };
}

function buildSubassemblyCheck(hypothesis, candidates) {
  const partIds = unique(hypothesis.partIds || hypothesis.subassemblyPartIds || []);
  if (!partIds.length) {
    return {
      ok: false,
      score: 0,
      reasons: ["no_subassembly_parts_provided"],
    };
  }

  const signature = [...partIds].sort().join("+");
  const candidate = candidates.subassemblyCandidates.find((item) => [...item.partIds].sort().join("+") === signature);
  return {
    ok: Boolean(candidate && candidate.score >= 0.5),
    score: round(candidate?.score || 0),
    reasons: candidate?.reasons || ["subassembly_candidate_not_found"],
  };
}

function buildGraspCheck(hypothesis, candidates) {
  const gripFaceIds = unique(hypothesis.gripFaceIds || []);
  const resolved = hypothesis.graspCandidateId ? candidates.candidateMap.get(hypothesis.graspCandidateId)?.candidate : null;
  const candidate = resolved || candidates.graspCandidates.find((item) => {
    if (hypothesis.partId && item.partId !== hypothesis.partId) {
      return false;
    }
    if (!gripFaceIds.length) {
      return false;
    }
    return gripFaceIds.every((faceId) => item.featureGroup.faceIds.includes(faceId));
  });

  if (!candidate) {
    return {
      ok: false,
      score: 0,
      reasons: ["no_matching_grasp_candidate"],
    };
  }

  const selectedGripFaceIds = gripFaceIds.length ? gripFaceIds : candidate.featureGroup.faceIds;
  const overlapsAvoid = selectedGripFaceIds.some((faceId) => (candidate.avoidFaceIds || []).includes(faceId));
  const score = overlapsAvoid ? Math.min(candidate.score, 0.15) : candidate.score;
  const reasons = [candidate.featureGroup.kind, ...(overlapsAvoid ? ["selected_faces_overlap_avoid_region"] : [])];

  return {
    ok: score >= 0.45 && !overlapsAvoid,
    score: round(score),
    reasons,
    graspCandidateId: candidate.candidateId,
  };
}

function buildInsertionCheck(details, hypothesis) {
  const movingPartId = hypothesis.movingPartId || hypothesis.assemblingPartId || null;
  const referencePartId = hypothesis.basePartId || hypothesis.referencePartId || null;
  if (!movingPartId) {
    return {
      ok: false,
      score: 0,
      reasons: ["missing_moving_part_id"],
    };
  }

  const insertionCandidates = buildInsertionCandidates(details, movingPartId, {
    referencePartId: referencePartId || undefined,
    topK: 4,
  });
  const desiredDirection = hypothesis.insertionDirection ? normalize(hypothesis.insertionDirection) : null;
  const bestCandidate = insertionCandidates
    .map((candidate) => {
      const axis = normalize(candidate.insertionAxis || { x: 0, y: 0, z: 1 });
      const alignment = desiredDirection ? Math.abs(dot(axis, desiredDirection)) : 1;
      return {
        ...candidate,
        alignment: round(alignment),
        effectiveScore: round(candidate.score * alignment),
      };
    })
    .sort((left, right) => right.effectiveScore - left.effectiveScore)[0] || null;

  return {
    ok: Boolean(bestCandidate && bestCandidate.effectiveScore >= 0.45),
    score: round(bestCandidate?.effectiveScore || 0),
    reasons: bestCandidate ? [...(bestCandidate.evidence || []).slice(0, 5), `alignment=${bestCandidate.alignment}`] : ["no_insertion_candidate"],
    candidateId: bestCandidate?.candidateId || null,
    travelDistance: bestCandidate?.travelDistance || null,
  };
}

function buildInterferenceCheck(details, hypothesis) {
  const movingPartId = hypothesis.movingPartId || hypothesis.assemblingPartId || null;
  if (!movingPartId) {
    return {
      ok: false,
      score: 0,
      reasons: ["missing_moving_part_id"],
    };
  }

  const result = checkInterference(details, movingPartId, hypothesis.fixedPartIds, hypothesis.transform);
  const score = result.hasInterference ? clamp(1 - result.collisionCount * 0.25, 0, 1) : 0.82;
  return {
    ok: !result.hasInterference,
    score: round(score),
    reasons: result.hasInterference
      ? result.collisions.map((item) => `collision_with=${item.partId}`).slice(0, 6)
      : ["no_collision_detected"],
    collisionCount: result.collisionCount,
  };
}

function buildSummary(checks) {
  const failed = Object.entries(checks).filter(([, value]) => value && value.ok === false);
  if (!failed.length) {
    return "Hypothesis passed the requested validation checks.";
  }
  if (failed.length === 1) {
    return `${failed[0][0]} check needs revision.`;
  }
  return `${failed.length} validation checks need revision.`;
}

function validateHypothesis(details, hypothesis = {}, options = {}) {
  const candidates = options.candidates || buildAnalysisCandidates(details, options);
  const requestedChecks = {
    relationConsistency: false,
    subassemblyCohesion: false,
    baseStability: false,
    graspClearance: false,
    insertionFeasibility: false,
    interference: false,
  };

  if (hypothesis.type === "relation") {
    requestedChecks.relationConsistency = true;
  }
  if (hypothesis.type === "subassembly") {
    requestedChecks.subassemblyCohesion = true;
  }
  if (hypothesis.type === "base_part") {
    requestedChecks.baseStability = true;
  }
  if (hypothesis.type === "grasp") {
    requestedChecks.graspClearance = true;
  }
  if (hypothesis.type === "assembly_step") {
    requestedChecks.relationConsistency = true;
    requestedChecks.baseStability = true;
    requestedChecks.graspClearance = Boolean(hypothesis.graspCandidateId || hypothesis.gripFaceIds?.length);
    requestedChecks.insertionFeasibility = true;
    requestedChecks.interference = true;
  }

  Object.assign(requestedChecks, options.checks || {});

  const checks = {};
  if (requestedChecks.relationConsistency) {
    checks.relationConsistency = buildRelationCheck(details, hypothesis, candidates);
  }
  if (requestedChecks.subassemblyCohesion) {
    checks.subassemblyCohesion = buildSubassemblyCheck(hypothesis, candidates);
  }
  if (requestedChecks.baseStability) {
    checks.baseStability = buildBaseCheck(hypothesis, candidates);
  }
  if (requestedChecks.graspClearance) {
    checks.graspClearance = buildGraspCheck(hypothesis, candidates);
  }
  if (requestedChecks.insertionFeasibility) {
    checks.insertionFeasibility = buildInsertionCheck(details, hypothesis);
  }
  if (requestedChecks.interference) {
    checks.interference = buildInterferenceCheck(details, hypothesis);
  }

  const scores = Object.values(checks).map((item) => item.score || 0);
  const valid = Object.values(checks).every((item) => item.ok !== false);
  const score = round(average(scores));
  const nextEvidenceNeeded = new Set();
  const risks = new Set();

  if (checks.relationConsistency?.ok === false) {
    nextEvidenceNeeded.add("local_face_mask_focus");
    nextEvidenceNeeded.add("section_x_mid");
  }
  if (checks.graspClearance?.ok === false) {
    nextEvidenceNeeded.add("grasp_iso_part_only");
    nextEvidenceNeeded.add("local_grasp_overlay");
    risks.add("gripper_access_path_is_uncertain");
  }
  if (checks.insertionFeasibility?.ok === false) {
    nextEvidenceNeeded.add("section_y_mid");
    nextEvidenceNeeded.add("local_overlay_focus");
  }
  if (checks.interference?.ok === false) {
    risks.add("collision_detected_in_current_pose");
  }
  if (checks.graspClearance?.reasons?.includes("selected_faces_overlap_avoid_region")) {
    risks.add("selected_grip_faces_overlap_avoid_region");
  }
  if (FASTENER_NAME_PATTERN.test(hypothesis.partName || "")) {
    risks.add("thread_region_should_be_avoided");
  }

  return {
    valid,
    status: valid ? "valid" : score >= 0.3 ? "needs_revision" : "rejected",
    score,
    summary: buildSummary(checks),
    checks,
    risks: [...risks],
    nextEvidenceNeeded: [...nextEvidenceNeeded],
  };
}

module.exports = {
  buildModelContext,
  buildModelContextToolPayload,
  buildAnalysisCandidates,
  buildRelationCandidatesToolPayload,
  buildEvidenceTarget,
  validateHypothesis,
};



