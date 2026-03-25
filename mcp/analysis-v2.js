const THREE = require("three");

const FASTENER_NAME_PATTERN = /pin|bolt|screw|nut|washer|fastener|销|螺|垫圈|螺母|螺栓/i;

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function vectorLength(vector) {
  return Math.sqrt(vector.x ** 2 + vector.y ** 2 + vector.z ** 2);
}

function normalize(vector, fallback = { x: 0, y: 0, z: 1 }) {
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

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function subtract(a, b) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function add(a, b) {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

function scale(v, factor) {
  return {
    x: v.x * factor,
    y: v.y * factor,
    z: v.z * factor,
  };
}

function bboxVolume(bbox) {
  return (bbox?.size?.x || 0) * (bbox?.size?.y || 0) * (bbox?.size?.z || 0);
}

function bboxIntersection(a, b) {
  const min = {
    x: Math.max(a.min.x, b.min.x),
    y: Math.max(a.min.y, b.min.y),
    z: Math.max(a.min.z, b.min.z),
  };
  const max = {
    x: Math.min(a.max.x, b.max.x),
    y: Math.min(a.max.y, b.max.y),
    z: Math.min(a.max.z, b.max.z),
  };
  const size = {
    x: Math.max(0, max.x - min.x),
    y: Math.max(0, max.y - min.y),
    z: Math.max(0, max.z - min.z),
  };
  return {
    min,
    max,
    size,
    volume: size.x * size.y * size.z,
    intersects: size.x > 0 && size.y > 0 && size.z > 0,
  };
}

function bboxGap(a, b) {
  const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
  const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
  const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
  return Math.sqrt(dx ** 2 + dy ** 2 + dz ** 2);
}

function lineDistance(pointA, dirA, pointB) {
  const delta = subtract(pointB, pointA);
  const crossValue = cross(delta, dirA);
  return vectorLength(crossValue);
}

function dominantAxisFromNormal(normal) {
  const abs = {
    x: Math.abs(normal.x),
    y: Math.abs(normal.y),
    z: Math.abs(normal.z),
  };
  if (abs.x >= abs.y && abs.x >= abs.z) {
    return "x";
  }
  if (abs.y >= abs.x && abs.y >= abs.z) {
    return "y";
  }
  return "z";
}

function projectedOverlapRatio(faceA, faceB, normalAxis) {
  const axes = ["x", "y", "z"].filter((axis) => axis !== normalAxis);
  const ratios = axes.map((axis) => {
    const minA = faceA.bounds.min[axis];
    const maxA = faceA.bounds.max[axis];
    const minB = faceB.bounds.min[axis];
    const maxB = faceB.bounds.max[axis];
    const overlap = Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
    const span = Math.min(maxA - minA, maxB - minB);
    if (span <= 0) {
      return 0;
    }
    return overlap / span;
  });

  if (!ratios.length) {
    return 0;
  }
  return ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
}

function toThreeVector(vector) {
  return new THREE.Vector3(vector.x, vector.y, vector.z);
}

function derivePartFrame(part) {
  const sortedFaces = [...(part.faces || [])].sort((a, b) => (b.area || 0) - (a.area || 0));
  const uniqueNormals = [];

  for (const face of sortedFaces) {
    const candidate = normalize(face.normal);
    const already = uniqueNormals.some((existing) => Math.abs(dot(existing, candidate)) > 0.96);
    if (!already) {
      uniqueNormals.push(candidate);
    }
    if (uniqueNormals.length >= 2) {
      break;
    }
  }

  const zAxis = uniqueNormals[0] || { x: 0, y: 0, z: 1 };
  let xAxis = uniqueNormals[1] || { x: 1, y: 0, z: 0 };
  xAxis = normalize(subtract(xAxis, scale(zAxis, dot(xAxis, zAxis))), { x: 1, y: 0, z: 0 });
  const yAxis = normalize(cross(zAxis, xAxis), { x: 0, y: 1, z: 0 });

  const basis = new THREE.Matrix4().makeBasis(
    toThreeVector(xAxis),
    toThreeVector(yAxis),
    toThreeVector(zAxis),
  );
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(basis);

  return {
    xAxis,
    yAxis,
    zAxis,
    quaternion: {
      x: round(quaternion.x),
      y: round(quaternion.y),
      z: round(quaternion.z),
      w: round(quaternion.w),
    },
  };
}

function transformBBox(bbox, transform) {
  const translation = transform?.translation || { x: 0, y: 0, z: 0 };
  const quaternion = new THREE.Quaternion(
    transform?.quaternion?.x || 0,
    transform?.quaternion?.y || 0,
    transform?.quaternion?.z || 0,
    transform?.quaternion?.w ?? 1,
  );
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(translation.x, translation.y, translation.z),
    quaternion,
    new THREE.Vector3(1, 1, 1),
  );

  const min = bbox.min;
  const max = bbox.max;
  const corners = [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
  ].map((corner) => corner.applyMatrix4(matrix));

  const box = new THREE.Box3().setFromPoints(corners);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return {
    min: { x: round(box.min.x), y: round(box.min.y), z: round(box.min.z) },
    max: { x: round(box.max.x), y: round(box.max.y), z: round(box.max.z) },
    center: { x: round(center.x), y: round(center.y), z: round(center.z) },
    size: { x: round(size.x), y: round(size.y), z: round(size.z) },
  };
}

function buildPartMap(details) {
  return new Map((details.assembly?.nodes || []).filter((node) => node.kind === "part").map((node) => [node.id, node]));
}

function computePairCandidates(partA, partB) {
  const candidates = [];
  for (const faceA of partA.faces || []) {
    for (const faceB of partB.faces || []) {
      if (faceA.geometry?.type === "cylinder" && faceB.geometry?.type === "cylinder") {
        const axisA = normalize(faceA.geometry.axisDirection || faceA.normal);
        const axisB = normalize(faceB.geometry.axisDirection || faceB.normal);
        const alignment = Math.abs(dot(axisA, axisB));
        const axisDistance = lineDistance(
          faceA.geometry.axisOrigin || faceA.center,
          axisA,
          faceB.geometry.axisOrigin || faceB.center,
        );
        const radiusA = faceA.geometry.radius || 0;
        const radiusB = faceB.geometry.radius || 0;
        const radiusSimilarity = Math.min(radiusA, radiusB) / Math.max(radiusA, radiusB, 1);
        const gapScore = clamp(1 - axisDistance / Math.max(Math.max(radiusA, radiusB) * 0.5, 1), 0, 1);
        const score = alignment * 0.45 + gapScore * 0.3 + radiusSimilarity * 0.25;

        if (score > 0.52) {
          candidates.push({
            id: `${partA.id}__${faceA.id}__${partB.id}__${faceB.id}`,
            partAId: partA.id,
            partBId: partB.id,
            faceAId: faceA.id,
            faceBId: faceB.id,
            relation: "coaxial-cylinder-candidate",
            normalAlignment: round(alignment),
            gap: round(axisDistance),
            overlapScore: round(gapScore),
            areaScore: round(radiusSimilarity),
            score: round(score),
            evidence: [
              `axis_alignment=${round(alignment)}`,
              `axis_distance=${round(axisDistance)}`,
              `radius_similarity=${round(radiusSimilarity)}`,
            ],
          });
        }
      }

      const normalA = normalize(faceA.normal);
      const normalB = normalize(faceB.normal);
      const normalDot = dot(normalA, normalB);
      const oppositeScore = clamp((-normalDot - 0.85) / 0.15, 0, 1);
      const parallelScore = clamp((Math.abs(normalDot) - 0.92) / 0.08, 0, 1);
      if (Math.max(oppositeScore, parallelScore) <= 0) {
        continue;
      }

      const axis = dominantAxisFromNormal(normalA);
      const gap = Math.abs(dot(subtract(faceB.center, faceA.center), normalA));
      const avgSize = (partA.bbox.size[axis] + partB.bbox.size[axis]) / 2 || 1;
      const gapScore = clamp(1 - gap / Math.max(avgSize * 0.35, 1), 0, 1);
      const overlapScore = projectedOverlapRatio(faceA, faceB, axis);
      const areaScore = Math.min(faceA.area, faceB.area) / Math.max(faceA.area, faceB.area, 1);
      const score =
        oppositeScore * 0.42 +
        parallelScore * 0.08 +
        gapScore * 0.22 +
        overlapScore * 0.2 +
        areaScore * 0.08;

      if (score < 0.48) {
        continue;
      }

      candidates.push({
        id: `${partA.id}__${faceA.id}__${partB.id}__${faceB.id}`,
        partAId: partA.id,
        partBId: partB.id,
        faceAId: faceA.id,
        faceBId: faceB.id,
        relation: oppositeScore > 0.6 ? "planar-coincident-candidate" : "planar-parallel-candidate",
        normalAlignment: round(normalDot),
        gap: round(gap),
        overlapScore: round(overlapScore),
        areaScore: round(areaScore),
        score: round(score),
        evidence: [
          `normal_alignment=${round(normalDot)}`,
          `gap=${round(gap)}`,
          `overlap=${round(overlapScore)}`,
          `area_similarity=${round(areaScore)}`,
        ],
      });
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

function buildMatingCandidates(details, options = {}) {
  const partMap = buildPartMap(details);
  const selectedPartIds = options.partIds?.length ? options.partIds : [...partMap.keys()];
  const selectedParts = selectedPartIds.map((partId) => partMap.get(partId)).filter(Boolean);
  const pairCandidates = [];

  for (let index = 0; index < selectedParts.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < selectedParts.length; otherIndex += 1) {
      const partA = selectedParts[index];
      const partB = selectedParts[otherIndex];
      const bboxGapValue = bboxGap(partA.bbox, partB.bbox);
      if (bboxGapValue > Math.max(partA.bbox.size.x, partA.bbox.size.y, partA.bbox.size.z, 1) * 1.2) {
        continue;
      }

      const topCandidates = computePairCandidates(partA, partB).slice(0, options.facePairLimit || 3);
      if (!topCandidates.length) {
        continue;
      }

      pairCandidates.push({
        pairId: `${partA.id}__${partB.id}`,
        partAId: partA.id,
        partAName: partA.name,
        partBId: partB.id,
        partBName: partB.name,
        score: topCandidates[0].score,
        bboxGap: round(bboxGapValue),
        candidateFaces: topCandidates,
      });
    }
  }

  return pairCandidates.sort((left, right) => right.score - left.score).slice(0, options.topK || 32);
}

function buildBasePartCandidates(details, options = {}) {
  const partMap = buildPartMap(details);
  const parts = [...partMap.values()];
  const pairCandidates = buildMatingCandidates(details, { topK: 128, facePairLimit: 2 });
  const connectivityMap = new Map(parts.map((part) => [part.id, { degree: 0, score: 0 }]));

  pairCandidates.forEach((candidate) => {
    connectivityMap.get(candidate.partAId).degree += 1;
    connectivityMap.get(candidate.partAId).score += candidate.score;
    connectivityMap.get(candidate.partBId).degree += 1;
    connectivityMap.get(candidate.partBId).score += candidate.score;
  });

  const maxVolume = Math.max(...parts.map((part) => bboxVolume(part.bbox)), 1);
  const maxArea = Math.max(...parts.map((part) => Math.max(...(part.faces || []).map((face) => face.area || 0), 0)), 1);
  const maxDegree = Math.max(...parts.map((part) => connectivityMap.get(part.id)?.degree || 0), 1);

  const candidates = parts.map((part) => {
    const connectivity = connectivityMap.get(part.id) || { degree: 0, score: 0 };
    const volumeScore = bboxVolume(part.bbox) / maxVolume;
    const supportAreaScore =
      Math.max(...(part.faces || []).map((face) => face.area || 0), 0) / maxArea;
    const connectivityScore = connectivity.degree / maxDegree;
    const centerBias =
      1 -
      vectorLength(subtract(part.bbox.center, details.assembly.bounds.center)) /
        Math.max(vectorLength(details.assembly.bounds.size), 1);
    const fastenerPenalty = FASTENER_NAME_PATTERN.test(part.name) ? 0.35 : 0;

    const score = clamp(
      volumeScore * 0.38 +
        supportAreaScore * 0.25 +
        connectivityScore * 0.2 +
        clamp(centerBias, 0, 1) * 0.17 -
        fastenerPenalty,
      0,
      1,
    );

    const reasons = [];
    if (volumeScore > 0.55) reasons.push("large_volume");
    if (supportAreaScore > 0.55) reasons.push("large_support_face");
    if (connectivityScore > 0.4) reasons.push("high_connectivity");
    if (centerBias > 0.45) reasons.push("spatially_central");
    if (fastenerPenalty > 0) reasons.push("fastener_like_penalty");

    return {
      partId: part.id,
      name: part.name,
      score: round(score),
      volumeScore: round(volumeScore),
      supportAreaScore: round(supportAreaScore),
      connectivityScore: round(connectivityScore),
      centerBias: round(clamp(centerBias, 0, 1)),
      reasons,
    };
  });

  return candidates.sort((left, right) => right.score - left.score).slice(0, options.topK || 5);
}

function buildRelativeTransform(details, fromPartId, toPartId) {
  const partMap = buildPartMap(details);
  const fromPart = partMap.get(fromPartId);
  const toPart = partMap.get(toPartId);
  if (!fromPart || !toPart) {
    throw new Error("指定零件不存在。");
  }

  const fromFrame = derivePartFrame(fromPart);
  const toFrame = derivePartFrame(toPart);
  const delta = subtract(toPart.bbox.center, fromPart.bbox.center);

  const qFrom = new THREE.Quaternion(
    fromFrame.quaternion.x,
    fromFrame.quaternion.y,
    fromFrame.quaternion.z,
    fromFrame.quaternion.w,
  );
  const qTo = new THREE.Quaternion(
    toFrame.quaternion.x,
    toFrame.quaternion.y,
    toFrame.quaternion.z,
    toFrame.quaternion.w,
  );
  const relativeQuaternion = qFrom.clone().invert().multiply(qTo);

  return {
    fromPartId,
    toPartId,
    translation: {
      x: round(delta.x),
      y: round(delta.y),
      z: round(delta.z),
    },
    quaternion: {
      x: round(relativeQuaternion.x),
      y: round(relativeQuaternion.y),
      z: round(relativeQuaternion.z),
      w: round(relativeQuaternion.w),
    },
    method: "face-frame-heuristic",
    confidence: round(0.55),
  };
}

function buildInsertionCandidates(details, partId, options = {}) {
  const partMap = buildPartMap(details);
  const part = partMap.get(partId);
  if (!part) {
    throw new Error("指定零件不存在。");
  }

  const pairCandidates = buildMatingCandidates(details, {
    partIds: options.referencePartId ? [partId, options.referencePartId] : undefined,
    topK: 16,
    facePairLimit: 3,
  }).filter((candidate) => candidate.partAId === partId || candidate.partBId === partId);

  const results = pairCandidates.map((pair) => {
    const bestFacePair = pair.candidateFaces[0];
    const isPartA = pair.partAId === partId;
    const basePartId = isPartA ? pair.partBId : pair.partAId;
    const movingFaceId = isPartA ? bestFacePair.faceAId : bestFacePair.faceBId;
    const baseFaceId = isPartA ? bestFacePair.faceBId : bestFacePair.faceAId;
    const movingFace = part.faces.find((face) => face.id === movingFaceId);
    const axis = normalize(scale(movingFace.normal, -1));
    const travelDistance = round(bestFacePair.gap + Math.max(...Object.values(part.bbox.size)) * 0.6 + 5);

    return {
      candidateId: `${partId}__${basePartId}__${movingFaceId}`,
      partId,
      basePartId,
      movingFaceId,
      baseFaceId,
      insertionAxis: {
        x: round(axis.x),
        y: round(axis.y),
        z: round(axis.z),
      },
      travelDistance,
      score: round(bestFacePair.score),
      evidence: [...bestFacePair.evidence, `travel_distance=${travelDistance}`],
    };
  });

  return results.sort((left, right) => right.score - left.score).slice(0, options.topK || 5);
}

function checkInterference(details, movingPartId, fixedPartIds, transform) {
  const partMap = buildPartMap(details);
  const movingPart = partMap.get(movingPartId);
  if (!movingPart) {
    throw new Error("指定移动零件不存在。");
  }

  const movingBounds = transformBBox(movingPart.bbox, transform || {});
  const fixedParts = (fixedPartIds?.length ? fixedPartIds : [...partMap.keys()].filter((partId) => partId !== movingPartId))
    .map((partId) => partMap.get(partId))
    .filter(Boolean);

  const collisions = fixedParts
    .map((part) => {
      const intersection = bboxIntersection(movingBounds, part.bbox);
      return {
        partId: part.id,
        name: part.name,
        overlapVolume: round(intersection.volume),
        intersects: intersection.intersects,
      };
    })
    .filter((item) => item.intersects);

  return {
    movingPartId,
    method: "aabb-proxy",
    transform: transform || {
      translation: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    },
    hasInterference: collisions.length > 0,
    collisionCount: collisions.length,
    totalOverlapVolume: round(collisions.reduce((sum, item) => sum + item.overlapVolume, 0)),
    collisions,
  };
}

function topoSort(nodes, edges) {
  const incoming = new Map(nodes.map((node) => [node, 0]));
  const adjacency = new Map(nodes.map((node) => [node, []]));
  edges.forEach((edge) => {
    incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
    adjacency.get(edge.from).push(edge.to);
  });

  const queue = nodes.filter((node) => (incoming.get(node) || 0) === 0);
  const result = [];
  while (queue.length) {
    const current = queue.shift();
    result.push(current);
    adjacency.get(current).forEach((neighbor) => {
      incoming.set(neighbor, incoming.get(neighbor) - 1);
      if (incoming.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    });
  }

  return result.length === nodes.length ? result : nodes;
}

function buildSequencePlan(details, options = {}) {
  const baseCandidates = buildBasePartCandidates(details, { topK: Math.max(options.maxSequences || 3, 3) });
  const pairCandidates = buildMatingCandidates(details, { topK: 64, facePairLimit: 2 });
  const partMap = buildPartMap(details);
  const nodes = [...partMap.keys()];
  const preferredBaseId = options.basePartId || baseCandidates[0]?.partId || nodes[0];
  const sequenceBases = [preferredBaseId, ...baseCandidates.map((item) => item.partId).filter((partId) => partId !== preferredBaseId)]
    .slice(0, options.maxSequences || 3);

  const candidateSequences = sequenceBases.map((basePartId, sequenceIndex) => {
    const edges = [];
    pairCandidates.forEach((pair) => {
      if (pair.partAId === basePartId) {
        edges.push({ from: basePartId, to: pair.partBId, reason: "mate_dependency", score: pair.score, pair });
      } else if (pair.partBId === basePartId) {
        edges.push({ from: basePartId, to: pair.partAId, reason: "mate_dependency", score: pair.score, pair });
      }
    });

    const remaining = nodes.filter((nodeId) => nodeId !== basePartId);
    remaining.forEach((nodeId) => {
      const already = edges.some((edge) => edge.to === nodeId);
      if (!already) {
        edges.push({ from: basePartId, to: nodeId, reason: "base_anchor_fallback", score: 0.35, pair: null });
      }
    });

    const order = topoSort(nodes, edges).filter((nodeId) => nodeId !== basePartId);
    const steps = order.map((assemblingPartId, stepIndex) => {
      const bestPair = pairCandidates.find(
        (pair) =>
          (pair.partAId === assemblingPartId && (pair.partBId === basePartId || order.slice(0, stepIndex).includes(pair.partBId))) ||
          (pair.partBId === assemblingPartId && (pair.partAId === basePartId || order.slice(0, stepIndex).includes(pair.partAId))),
      );
      const anchorId = bestPair
        ? bestPair.partAId === assemblingPartId
          ? bestPair.partBId
          : bestPair.partAId
        : basePartId;
      const insertion = buildInsertionCandidates(details, assemblingPartId, {
        referencePartId: anchorId,
        topK: 1,
      })[0];
      const relativeTransform = buildRelativeTransform(details, anchorId, assemblingPartId);
      const part = partMap.get(assemblingPartId);
      const afterTranslation = part.bbox.center;
      const beforeTranslation = insertion
        ? subtract(afterTranslation, scale(insertion.insertionAxis, insertion.travelDistance))
        : add(afterTranslation, { x: 0, y: 0, z: Math.max(...Object.values(part.bbox.size)) * 0.8 + 10 });
      return {
        stepIndex: stepIndex + 1,
        basePartId: anchorId,
        assemblingPartId,
        transformBefore: {
          translation: {
            x: round(beforeTranslation.x),
            y: round(beforeTranslation.y),
            z: round(beforeTranslation.z),
          },
          quaternion: relativeTransform.quaternion,
        },
        transformAfter: {
          translation: {
            x: round(afterTranslation.x),
            y: round(afterTranslation.y),
            z: round(afterTranslation.z),
          },
          quaternion: relativeTransform.quaternion,
        },
        deltaTransform: {
          translation: {
            x: round(afterTranslation.x - beforeTranslation.x),
            y: round(afterTranslation.y - beforeTranslation.y),
            z: round(afterTranslation.z - beforeTranslation.z),
          },
          quaternion: { x: 0, y: 0, z: 0, w: 1 },
        },
        matingFaces: bestPair
          ? bestPair.candidateFaces.slice(0, 1).map((facePair) => ({
              baseFaceId: anchorId === bestPair.partAId ? facePair.faceAId : facePair.faceBId,
              partFaceId: assemblingPartId === bestPair.partAId ? facePair.faceAId : facePair.faceBId,
              relation: facePair.relation,
            }))
          : [],
        insertionAxis: insertion?.insertionAxis || { x: 0, y: 0, z: -1 },
        evidence: insertion?.evidence || (bestPair ? bestPair.candidateFaces[0].evidence : ["base_anchor_fallback"]),
        confidence: round(bestPair?.score || 0.35),
      };
    });

    return {
      sequenceId: `seq-${sequenceIndex + 1}`,
      basePartId,
      confidence: round(
        steps.length ? steps.reduce((sum, step) => sum + step.confidence, 0) / steps.length : baseCandidates[0]?.score || 0.4,
      ),
      steps,
    };
  });

  return {
    projectId: details.manifest.projectId,
    rootAssemblyId: details.assembly.rootId,
    basePartCandidates: baseCandidates,
    precedenceGraph: {
      nodes,
      edges: candidateSequences[0]?.steps.map((step) => ({
        from: step.basePartId,
        to: step.assemblingPartId,
        reason: "planned_dependency",
      })) || [],
    },
    candidateSequences,
  };
}

module.exports = {
  buildBasePartCandidates,
  buildMatingCandidates,
  buildRelativeTransform,
  buildInsertionCandidates,
  checkInterference,
  buildSequencePlan,
};
