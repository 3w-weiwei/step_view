const {
  buildBasePartCandidates,
  buildMatingCandidates,
  buildRelativeTransform,
  buildInsertionCandidates,
  checkInterference,
  buildSequencePlan,
} = require("./analysis-v2");

function ensureAssembly(details) {
  if (!details?.manifest || !details?.assembly) {
    throw new Error("Project details are not ready for reasoning.");
  }
}

function buildNodeMap(details) {
  return new Map((details.assembly?.nodes || []).map((node) => [node.id, node]));
}

function buildPartMap(details) {
  return new Map((details.assembly?.nodes || []).filter((node) => node.kind === "part").map((node) => [node.id, node]));
}

function buildFaceMap(details) {
  const faceMap = new Map();
  (details.assembly?.meshes || []).forEach((mesh) => {
    (mesh.brepFaces || []).forEach((face) => {
      faceMap.set(face.id, face);
    });
  });
  return faceMap;
}

function maxDimension(size = {}) {
  return Math.max(size.x || 0, size.y || 0, size.z || 0);
}

function normalizeVector(vector, fallback = { x: 0, y: 0, z: 1 }) {
  const length = Math.sqrt((vector?.x || 0) ** 2 + (vector?.y || 0) ** 2 + (vector?.z || 0) ** 2);
  if (!length) {
    return { ...fallback };
  }
  return {
    x: (vector.x || 0) / length,
    y: (vector.y || 0) / length,
    z: (vector.z || 0) / length,
  };
}

function buildInsertionAxis(origin, direction, length) {
  return {
    origin,
    direction: normalizeVector(direction),
    length,
  };
}

function getDefaultPair(details, options = {}) {
  const partIds = [...buildPartMap(details).keys()];
  const basePartCandidates = buildBasePartCandidates(details, { topK: 8 });
  const basePartId = options.basePartId || basePartCandidates[0]?.partId || partIds[0] || null;
  const matingCandidates = buildMatingCandidates(details, {
    partIds: basePartId ? [basePartId] : undefined,
    topK: 24,
    facePairLimit: 3,
  });
  const pair = matingCandidates.find((item) => {
    if (!basePartId) {
      return true;
    }
    return item.partAId === basePartId || item.partBId === basePartId;
  }) || matingCandidates[0] || null;

  const assemblingPartId =
    options.assemblingPartId ||
    (pair
      ? pair.partAId === basePartId
        ? pair.partBId
        : pair.partAId
      : partIds.find((partId) => partId !== basePartId) || null);

  return {
    basePartId,
    assemblingPartId,
    pair,
    basePartCandidates,
    matingCandidates,
  };
}

function buildPairOverlay(pair, basePartId, assemblingPartId, details) {
  const partMap = buildPartMap(details);
  const facePairs = pair?.candidateFaces || [];
  const assemblingNode = assemblingPartId ? partMap.get(assemblingPartId) : null;
  const baseFaceIds = [];
  const assemblingFaceIds = [];

  facePairs.forEach((facePair) => {
    if (pair.partAId === basePartId) {
      baseFaceIds.push(facePair.faceAId);
      assemblingFaceIds.push(facePair.faceBId);
    } else {
      baseFaceIds.push(facePair.faceBId);
      assemblingFaceIds.push(facePair.faceAId);
    }
  });

  return {
    focusPartIds: [basePartId, assemblingPartId].filter(Boolean),
    basePartId,
    assemblingPartId,
    baseFaceIds,
    assemblingFaceIds,
    insertionAxis: assemblingNode
      ? buildInsertionAxis(
          assemblingNode.bbox?.center || { x: 0, y: 0, z: 0 },
          pair?.candidateFaces?.[0]?.normal || { x: 0, y: 0, z: 1 },
          Math.max(maxDimension(assemblingNode.bbox?.size || {}), 12) * 1.1,
        )
      : null,
    interferenceBoxes: [],
  };
}

function buildCollisionBoxes(collisions = []) {
  return collisions.slice(0, 8).map((item) => ({
    partId: item.partId,
    bbox: item.intersection || item.bbox || null,
    overlapVolume: item.overlapVolume || item.volume || 0,
  })).filter((item) => item.bbox);
}

function buildReasoningSummary(details) {
  ensureAssembly(details);
  const { basePartCandidates } = getDefaultPair(details);
  const matingCandidates = buildMatingCandidates(details, { topK: 24, facePairLimit: 3 });
  const plan = buildSequencePlan(details, { maxSequences: 4 });
  return {
    projectId: details.manifest.projectId,
    projectName: details.manifest.projectName,
    partCount: details.manifest.partCount || 0,
    faceCount: details.manifest.faceCount || 0,
    baseCandidateCount: basePartCandidates.length,
    matingCandidateCount: matingCandidates.length,
    sequenceCount: plan.candidateSequences.length,
    bestBasePartId: basePartCandidates[0]?.partId || null,
    bestSequenceId: plan.candidateSequences[0]?.sequenceId || null,
    topConfidence: plan.candidateSequences[0]?.confidence || 0,
  };
}

function buildReasoningConstraints(details, options = {}) {
  ensureAssembly(details);
  const partMap = buildPartMap(details);
  const { basePartId, assemblingPartId, pair, basePartCandidates, matingCandidates } = getDefaultPair(details, options);
  const insertionCandidates = assemblingPartId
    ? buildInsertionCandidates(details, assemblingPartId, {
        referencePartId: basePartId || undefined,
        topK: 5,
      })
    : [];

  return {
    projectId: details.manifest.projectId,
    selection: {
      basePartId,
      basePartName: basePartId ? partMap.get(basePartId)?.name || basePartId : null,
      assemblingPartId,
      assemblingPartName: assemblingPartId ? partMap.get(assemblingPartId)?.name || assemblingPartId : null,
    },
    basePartCandidates,
    matingCandidates,
    insertionCandidates,
    selectedPair: pair,
    overlay: buildPairOverlay(pair, basePartId, assemblingPartId, details),
  };
}

function buildReasoningTransform(details, options = {}) {
  ensureAssembly(details);
  const partMap = buildPartMap(details);
  const defaults = getDefaultPair(details, options);
  const basePartId = options.basePartId || defaults.basePartId;
  const assemblingPartId = options.assemblingPartId || defaults.assemblingPartId;

  if (!basePartId || !assemblingPartId) {
    throw new Error("Cannot resolve transform target parts.");
  }

  const relativeTransform = buildRelativeTransform(details, basePartId, assemblingPartId);
  const insertionCandidates = buildInsertionCandidates(details, assemblingPartId, {
    referencePartId: basePartId,
    topK: 5,
  });
  const fixedPartIds = [...partMap.keys()].filter((partId) => partId !== assemblingPartId);
  const interference = checkInterference(details, assemblingPartId, fixedPartIds);
  const primaryAxis = insertionCandidates[0]?.insertionAxis || { x: 0, y: 0, z: 1 };
  const assemblingNode = partMap.get(assemblingPartId);

  return {
    projectId: details.manifest.projectId,
    selection: {
      basePartId,
      basePartName: partMap.get(basePartId)?.name || basePartId,
      assemblingPartId,
      assemblingPartName: partMap.get(assemblingPartId)?.name || assemblingPartId,
    },
    relativeTransform,
    insertionCandidates,
    interference: {
      ...interference,
      collisions: (interference.collisions || []).map((item) => ({
        ...item,
        partName: partMap.get(item.partId)?.name || item.partId,
      })),
    },
    overlay: {
      focusPartIds: [basePartId, assemblingPartId],
      basePartId,
      assemblingPartId,
      baseFaceIds: [],
      assemblingFaceIds: [],
      insertionAxis: buildInsertionAxis(
        assemblingNode?.bbox?.center || { x: 0, y: 0, z: 0 },
        primaryAxis,
        Math.max(maxDimension(assemblingNode?.bbox?.size || {}), 12) * 1.25,
      ),
      interferenceBoxes: buildCollisionBoxes((interference.collisions || []).map((item) => ({ ...item, bbox: partMap.get(item.partId)?.bbox || null }))),
    },
  };
}

function buildReasoningPlan(details, options = {}) {
  ensureAssembly(details);
  const plan = buildSequencePlan(details, {
    maxSequences: options.maxSequences || 4,
    basePartId: options.basePartId,
  });
  return {
    projectId: details.manifest.projectId,
    plan,
    selection: {
      sequenceId: options.sequenceId || plan.candidateSequences[0]?.sequenceId || null,
      stepIndex: options.stepIndex || plan.candidateSequences[0]?.steps[0]?.stepIndex || null,
    },
  };
}

function resolveSequenceStep(details, options = {}) {
  const plan = buildSequencePlan(details, {
    maxSequences: options.maxSequences || 4,
    basePartId: options.basePartId,
  });
  const sequence =
    (options.sequenceId
      ? plan.candidateSequences.find((item) => item.sequenceId === options.sequenceId)
      : null) || plan.candidateSequences[0];

  if (!sequence) {
    throw new Error("No reasoning sequence is available.");
  }

  const step =
    sequence.steps.find((item) => item.stepIndex === Number(options.stepIndex || 1)) ||
    sequence.steps[0];

  if (!step) {
    throw new Error("No reasoning step is available.");
  }

  return { plan, sequence, step };
}

function buildReasoningStep(details, options = {}) {
  ensureAssembly(details);
  const nodeMap = buildNodeMap(details);
  const faceMap = buildFaceMap(details);
  const { sequence, step } = resolveSequenceStep(details, options);
  const baseNode = nodeMap.get(step.basePartId);
  const assemblingNode = nodeMap.get(step.assemblingPartId);
  const matingFaces = (step.matingFaces || []).map((facePair) => ({
    ...facePair,
    baseFaceName: faceMap.get(facePair.baseFaceId)?.name || facePair.baseFaceId,
    assemblingFaceName: faceMap.get(facePair.partFaceId)?.name || facePair.partFaceId,
  }));

  return {
    projectId: details.manifest.projectId,
    sequenceId: sequence.sequenceId,
    stepIndex: step.stepIndex,
    title: `Step ${step.stepIndex}: ${(assemblingNode?.name || step.assemblingPartId)} -> ${(baseNode?.name || step.basePartId)}`,
    summary: `Use ${(baseNode?.name || step.basePartId)} as the reference part, then move ${(assemblingNode?.name || step.assemblingPartId)} along the inferred insertion axis into place.`,
    rationale: [
      `base_part=${baseNode?.name || step.basePartId}`,
      `assembling_part=${assemblingNode?.name || step.assemblingPartId}`,
      `mating_face_count=${matingFaces.length}`,
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
    matingFaces,
    insertionAxis: step.insertionAxis,
    deltaTransform: step.deltaTransform,
    transformBefore: step.transformBefore,
    transformAfter: step.transformAfter,
    confidence: step.confidence,
    evidence: step.evidence || [],
    overlay: {
      focusPartIds: [step.basePartId, step.assemblingPartId],
      basePartId: step.basePartId,
      assemblingPartId: step.assemblingPartId,
      baseFaceIds: matingFaces.map((item) => item.baseFaceId),
      assemblingFaceIds: matingFaces.map((item) => item.partFaceId),
      insertionAxis: buildInsertionAxis(
        step.transformBefore?.translation || assemblingNode?.bbox?.center || { x: 0, y: 0, z: 0 },
        step.insertionAxis || { x: 0, y: 0, z: 1 },
        Math.max(maxDimension(assemblingNode?.bbox?.size || {}), 12) * 1.35,
      ),
      interferenceBoxes: [],
    },
  };
}

module.exports = {
  buildReasoningSummary,
  buildReasoningConstraints,
  buildReasoningTransform,
  buildReasoningPlan,
  buildReasoningStep,
};

