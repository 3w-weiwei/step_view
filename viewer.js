const FACE_TO_CORNERS = [
  { key: "back", corners: [0, 1, 2, 3], normal: { x: 0, y: 0, z: -1 } },
  { key: "front", corners: [4, 5, 6, 7], normal: { x: 0, y: 0, z: 1 } },
  { key: "left", corners: [0, 3, 7, 4], normal: { x: -1, y: 0, z: 0 } },
  { key: "right", corners: [1, 2, 6, 5], normal: { x: 1, y: 0, z: 0 } },
  { key: "bottom", corners: [0, 1, 5, 4], normal: { x: 0, y: -1, z: 0 } },
  { key: "top", corners: [3, 2, 6, 7], normal: { x: 0, y: 1, z: 0 } },
];

const PRESET_ROTATIONS = {
  iso: { yaw: -0.74, pitch: -0.48 },
  front: { yaw: 0, pitch: 0 },
  back: { yaw: Math.PI, pitch: 0 },
  left: { yaw: -Math.PI / 2, pitch: 0 },
  right: { yaw: Math.PI / 2, pitch: 0 },
  top: { yaw: 0, pitch: -Math.PI / 2 },
  bottom: { yaw: 0, pitch: Math.PI / 2 },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex) {
  const safeHex = hex.replace("#", "");
  const normalized = safeHex.length === 3
    ? safeHex
        .split("")
        .map((part) => `${part}${part}`)
        .join("")
    : safeHex;
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function mixColor(hex, ratio, target = { r: 255, g: 255, b: 255 }) {
  const source = hexToRgb(hex);
  const blend = {
    r: Math.round(source.r + (target.r - source.r) * ratio),
    g: Math.round(source.g + (target.g - source.g) * ratio),
    b: Math.round(source.b + (target.b - source.b) * ratio),
  };
  return `rgb(${blend.r}, ${blend.g}, ${blend.b})`;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let currentIndex = 0, previousIndex = polygon.length - 1; currentIndex < polygon.length; previousIndex = currentIndex++) {
    const current = polygon[currentIndex];
    const previous = polygon[previousIndex];
    const intersects =
      current.y > point.y !== previous.y > point.y &&
      point.x <
        ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y + Number.EPSILON) +
          current.x;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function normalizeRotation(yaw, pitch) {
  return {
    yaw,
    pitch: clamp(pitch, -Math.PI / 2 + 0.04, Math.PI / 2 - 0.04),
  };
}

export class WorkbenchViewer {
  constructor({ canvas, onObjectPick, onHintChange }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onObjectPick = onObjectPick;
    this.onHintChange = onHintChange;
    this.scene = null;
    this.renderables = [];
    this.hovered = null;
    this.selection = null;
    this.state = {
      selectionMode: "part",
      hiddenNodeIds: new Set(),
      isolatedNodeIds: null,
      section: {
        enabled: false,
        axis: "x",
        offset: 0,
      },
    };
    this.camera = {
      yaw: PRESET_ROTATIONS.iso.yaw,
      pitch: PRESET_ROTATIONS.iso.pitch,
      zoom: 1,
      panX: 0,
      panY: 0,
      preset: "iso",
    };

    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handleDoubleClick = this.handleDoubleClick.bind(this);
    this.handleResize = this.handleResize.bind(this);

    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointerleave", this.handlePointerUp);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("dblclick", this.handleDoubleClick);

    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.canvas);
    } else {
      window.addEventListener("resize", this.handleResize);
    }

    this.resize();
    this.render();
  }

  snapshot() {
    return {
      camera: { ...this.camera },
    };
  }

  restore(snapshot) {
    if (!snapshot?.camera) {
      return;
    }

    this.camera = {
      ...this.camera,
      ...snapshot.camera,
    };
    this.render();
  }

  destroy() {
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointerleave", this.handlePointerUp);
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    } else {
      window.removeEventListener("resize", this.handleResize);
    }
  }

  setScene(scene, { preserveCamera = false } = {}) {
    this.scene = scene;
    if (!preserveCamera) {
      this.fit();
    } else {
      this.render();
    }
  }

  updateState(partialState) {
    this.state = {
      ...this.state,
      ...partialState,
      hiddenNodeIds: partialState.hiddenNodeIds || this.state.hiddenNodeIds,
      isolatedNodeIds:
        partialState.isolatedNodeIds === undefined ? this.state.isolatedNodeIds : partialState.isolatedNodeIds,
      section: {
        ...this.state.section,
        ...(partialState.section || {}),
      },
    };
    this.render();
  }

  setSelection(selection) {
    this.selection = selection;
    this.render();
  }

  setViewPreset(preset) {
    const rotation = PRESET_ROTATIONS[preset] || PRESET_ROTATIONS.iso;
    this.camera = {
      ...this.camera,
      ...rotation,
      preset,
    };
    this.render();
  }

  fit() {
    if (!this.scene?.bounds) {
      this.render();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const maxDimension = Math.max(
      this.scene.bounds.size.x,
      this.scene.bounds.size.y,
      this.scene.bounds.size.z,
      1,
    );

    this.camera = {
      ...this.camera,
      yaw: PRESET_ROTATIONS.iso.yaw,
      pitch: PRESET_ROTATIONS.iso.pitch,
      zoom: Math.min(rect.width, rect.height) * 0.32 / maxDimension,
      panX: 0,
      panY: 0,
      preset: "iso",
    };
    this.render();
  }

  handleResize() {
    this.resize();
    this.render();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  handlePointerDown(event) {
    this.dragState = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      yaw: this.camera.yaw,
      pitch: this.camera.pitch,
      panX: this.camera.panX,
      panY: this.camera.panY,
      mode: event.shiftKey || event.button === 1 ? "pan" : "rotate",
      moved: false,
    };

    this.canvas.setPointerCapture(event.pointerId);
  }

  handlePointerMove(event) {
    const position = this.eventToLocalPoint(event);

    if (!this.dragState || this.dragState.pointerId !== event.pointerId) {
      const hovered = this.hitTest(position);
      this.setHovered(hovered);
      return;
    }

    const deltaX = event.clientX - this.dragState.x;
    const deltaY = event.clientY - this.dragState.y;

    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
      this.dragState.moved = true;
    }

    if (this.dragState.mode === "pan") {
      this.camera.panX = this.dragState.panX + deltaX;
      this.camera.panY = this.dragState.panY + deltaY;
      this.onHintChange("平移视图中");
    } else {
      const nextRotation = normalizeRotation(
        this.dragState.yaw + deltaX * 0.009,
        this.dragState.pitch + deltaY * 0.009,
      );
      this.camera.yaw = nextRotation.yaw;
      this.camera.pitch = nextRotation.pitch;
      this.camera.preset = "custom";
      this.onHintChange("旋转视图中");
    }

    this.render();
  }

  handlePointerUp(event) {
    if (!this.dragState) {
      return;
    }

    const isSamePointer = this.dragState.pointerId === event.pointerId;
    const wasMoved = this.dragState.moved;
    this.dragState = null;
    if (isSamePointer) {
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch (_error) {
        // Ignore release errors from synthetic leave events.
      }
    }

    if (!wasMoved) {
      const hit = this.hitTest(this.eventToLocalPoint(event));
      if (hit) {
        this.onObjectPick(hit);
      }
    }

    if (this.hovered) {
      this.onHintChange(`悬停：${this.hovered.label}`);
    } else {
      this.onHintChange("拖拽旋转，Shift + 拖拽平移，滚轮缩放");
    }
  }

  handleWheel(event) {
    event.preventDefault();
    const scaleFactor = event.deltaY > 0 ? 0.92 : 1.08;
    this.camera.zoom = clamp(this.camera.zoom * scaleFactor, 0.05, 24);
    this.render();
  }

  handleDoubleClick() {
    this.fit();
    this.onHintChange("视图已重置并适配");
  }

  eventToLocalPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  setHovered(hovered) {
    const previousKey = this.hovered ? `${this.hovered.nodeId}:${this.hovered.faceId || "part"}` : null;
    const nextKey = hovered ? `${hovered.nodeId}:${hovered.faceId || "part"}` : null;

    if (previousKey === nextKey) {
      return;
    }

    this.hovered = hovered;
    this.canvas.style.cursor = hovered ? "pointer" : "default";
    this.onHintChange(hovered ? `悬停：${hovered.label}` : "拖拽旋转，Shift + 拖拽平移，滚轮缩放");
    this.render();
  }

  rotatePoint(point) {
    const yawCos = Math.cos(this.camera.yaw);
    const yawSin = Math.sin(this.camera.yaw);
    const pitchCos = Math.cos(this.camera.pitch);
    const pitchSin = Math.sin(this.camera.pitch);

    const x1 = point.x * yawCos - point.z * yawSin;
    const z1 = point.x * yawSin + point.z * yawCos;
    const y2 = point.y * pitchCos - z1 * pitchSin;
    const z2 = point.y * pitchSin + z1 * pitchCos;

    return { x: x1, y: y2, z: z2 };
  }

  projectPoint(point) {
    const rect = this.canvas.getBoundingClientRect();
    const centerX = rect.width / 2 + this.camera.panX;
    const centerY = rect.height / 2 + this.camera.panY;
    const perspective = 1 / (1 + point.z / 920);

    return {
      x: centerX + point.x * this.camera.zoom * perspective,
      y: centerY - point.y * this.camera.zoom * perspective,
      depth: point.z,
      perspective,
    };
  }

  buildRenderable(part) {
    const { center, size } = part.bbox;
    const half = {
      x: size.x / 2,
      y: size.y / 2,
      z: size.z / 2,
    };

    const corners = [
      { x: center.x - half.x, y: center.y - half.y, z: center.z - half.z },
      { x: center.x + half.x, y: center.y - half.y, z: center.z - half.z },
      { x: center.x + half.x, y: center.y + half.y, z: center.z - half.z },
      { x: center.x - half.x, y: center.y + half.y, z: center.z - half.z },
      { x: center.x - half.x, y: center.y - half.y, z: center.z + half.z },
      { x: center.x + half.x, y: center.y - half.y, z: center.z + half.z },
      { x: center.x + half.x, y: center.y + half.y, z: center.z + half.z },
      { x: center.x - half.x, y: center.y + half.y, z: center.z + half.z },
    ];

    const rotatedCorners = corners.map((corner) => this.rotatePoint(corner));
    const projectedCorners = rotatedCorners.map((corner) => this.projectPoint(corner));
    const visibleFaces = FACE_TO_CORNERS.map((face) => {
      const rotatedNormal = this.rotatePoint(face.normal);
      const polygon = face.corners.map((cornerIndex) => projectedCorners[cornerIndex]);
      const averageDepth =
        polygon.reduce((sum, corner) => sum + corner.depth, 0) / face.corners.length;
      return {
        ...face,
        visible: rotatedNormal.z < 0,
        averageDepth,
        polygon,
        rotatedNormal,
      };
    })
      .filter((face) => face.visible)
      .sort((left, right) => right.averageDepth - left.averageDepth);

    const minX = Math.min(...projectedCorners.map((corner) => corner.x));
    const maxX = Math.max(...projectedCorners.map((corner) => corner.x));
    const minY = Math.min(...projectedCorners.map((corner) => corner.y));
    const maxY = Math.max(...projectedCorners.map((corner) => corner.y));
    const averageDepth =
      rotatedCorners.reduce((sum, corner) => sum + corner.z, 0) / rotatedCorners.length;

    return {
      part,
      faces: visibleFaces,
      averageDepth,
      bounds: {
        minX,
        minY,
        maxX,
        maxY,
      },
      projectedCenter: this.projectPoint(this.rotatePoint(center)),
    };
  }

  drawSelectionOutline(facePolygon) {
    this.ctx.save();
    this.ctx.beginPath();
    facePolygon.forEach((point, index) => {
      if (index === 0) {
        this.ctx.moveTo(point.x, point.y);
      } else {
        this.ctx.lineTo(point.x, point.y);
      }
    });
    this.ctx.closePath();
    this.ctx.strokeStyle = "rgba(240, 177, 63, 0.94)";
    this.ctx.lineWidth = 3;
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawRenderable(renderable) {
    const { part, faces, projectedCenter } = renderable;
    const isSelected = this.selection?.nodeId === part.id && this.selection?.selectionType !== "face";
    const isHoveredPart = this.hovered?.nodeId === part.id && !this.hovered?.faceId;
    const outlineColor = isSelected || isHoveredPart ? "rgba(255,255,255,0.88)" : "rgba(14, 22, 38, 0.48)";

    faces.forEach((face) => {
      const highlightFace =
        this.selection?.faceId === `${part.id}:${face.key}` || this.hovered?.faceId === `${part.id}:${face.key}`;
      const brightRatio = face.key === "top" ? 0.3 : face.key === "front" ? 0.18 : 0.08;
      const fill = mixColor(part.color || "#4E79A7", brightRatio);
      this.ctx.beginPath();
      face.polygon.forEach((point, index) => {
        if (index === 0) {
          this.ctx.moveTo(point.x, point.y);
        } else {
          this.ctx.lineTo(point.x, point.y);
        }
      });
      this.ctx.closePath();
      this.ctx.fillStyle = highlightFace ? "rgba(240, 177, 63, 0.78)" : fill;
      this.ctx.fill();
      this.ctx.strokeStyle = outlineColor;
      this.ctx.lineWidth = highlightFace ? 2.8 : 1.1;
      this.ctx.stroke();
      if (highlightFace) {
        this.drawSelectionOutline(face.polygon);
      }
    });

    if (isSelected) {
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.arc(projectedCenter.x, projectedCenter.y, 5, 0, Math.PI * 2);
      this.ctx.fillStyle = "rgba(240, 177, 63, 0.94)";
      this.ctx.fill();
      this.ctx.restore();
    }
  }

  drawAxisIndicator() {
    const origin = { x: 70, y: this.canvas.getBoundingClientRect().height - 74 };
    const axisLength = 42;
    const axes = [
      { label: "X", color: "#f97316", vector: { x: axisLength, y: 0, z: 0 } },
      { label: "Y", color: "#22c55e", vector: { x: 0, y: axisLength, z: 0 } },
      { label: "Z", color: "#60a5fa", vector: { x: 0, y: 0, z: axisLength } },
    ];

    this.ctx.save();
    this.ctx.font = '12px "Segoe UI", "Microsoft YaHei", sans-serif';
    axes.forEach((axis) => {
      const rotated = this.rotatePoint(axis.vector);
      const endpoint = {
        x: origin.x + rotated.x * 0.6,
        y: origin.y - rotated.y * 0.6,
      };
      this.ctx.beginPath();
      this.ctx.moveTo(origin.x, origin.y);
      this.ctx.lineTo(endpoint.x, endpoint.y);
      this.ctx.lineWidth = 2.2;
      this.ctx.strokeStyle = axis.color;
      this.ctx.stroke();
      this.ctx.fillStyle = axis.color;
      this.ctx.fillText(axis.label, endpoint.x + 4, endpoint.y - 4);
    });
    this.ctx.restore();
  }

  drawSectionIndicator() {
    if (!this.state.section?.enabled) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const label = `剖切平面 ${this.state.section.axis.toUpperCase()} = ${Math.round(this.state.section.offset)}`;
    this.ctx.save();
    this.ctx.setLineDash([10, 10]);
    this.ctx.strokeStyle = "rgba(240, 177, 63, 0.58)";
    this.ctx.lineWidth = 1.4;
    this.ctx.strokeRect(32, 32, rect.width - 64, rect.height - 64);
    this.ctx.setLineDash([]);
    this.ctx.fillStyle = "rgba(240, 177, 63, 0.92)";
    this.ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
    this.ctx.fillText(label, 40, 56);
    this.ctx.restore();
  }

  isPartVisible(part) {
    if (this.state.hiddenNodeIds?.has(part.id)) {
      return false;
    }

    if (this.state.isolatedNodeIds && !this.state.isolatedNodeIds.has(part.id)) {
      return false;
    }

    if (!this.state.section?.enabled) {
      return true;
    }

    const axis = this.state.section.axis || "x";
    const axisValue = part.bbox.center[axis];
    const half = part.bbox.size[axis] / 2;
    return axisValue - half <= this.state.section.offset;
  }

  hitTest(point) {
    const renderables = [...this.renderables].sort((left, right) => left.averageDepth - right.averageDepth);
    const selectionMode = this.state.selectionMode;

    for (const renderable of renderables) {
      if (
        point.x < renderable.bounds.minX ||
        point.x > renderable.bounds.maxX ||
        point.y < renderable.bounds.minY ||
        point.y > renderable.bounds.maxY
      ) {
        continue;
      }

      const orderedFaces = [...renderable.faces].sort((left, right) => left.averageDepth - right.averageDepth);
      for (const face of orderedFaces) {
        if (!pointInPolygon(point, face.polygon)) {
          continue;
        }

        const part = renderable.part;
        if (selectionMode === "face") {
          const faceId = `${part.id}:${face.key}`;
          const faceDefinition = part.faces.find((candidate) => candidate.id === faceId);
          return {
            nodeId: part.id,
            faceId,
            selectionType: "face",
            label: `${part.name} / ${faceDefinition?.name || face.key}`,
          };
        }

        return {
          nodeId: part.id,
          selectionType: "part",
          label: part.name,
        };
      }

      return {
        nodeId: renderable.part.id,
        selectionType: "part",
        label: renderable.part.name,
      };
    }

    return null;
  }

  render() {
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);

    this.ctx.save();
    const gradient = this.ctx.createLinearGradient(0, 0, 0, rect.height);
    gradient.addColorStop(0, "rgba(16, 24, 37, 0.98)");
    gradient.addColorStop(1, "rgba(30, 43, 59, 0.96)");
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, rect.width, rect.height);
    this.ctx.restore();

    if (!this.scene?.nodes?.length) {
      this.ctx.save();
      this.ctx.fillStyle = "rgba(255, 255, 255, 0.64)";
      this.ctx.font = '16px "Segoe UI", "Microsoft YaHei", sans-serif';
      this.ctx.fillText("等待装配模型数据", rect.width / 2 - 70, rect.height / 2);
      this.ctx.restore();
      return;
    }

    const parts = this.scene.nodes.filter((node) => node.kind === "part" && this.isPartVisible(node));
    this.renderables = parts
      .map((part) => this.buildRenderable(part))
      .sort((left, right) => right.averageDepth - left.averageDepth);

    this.renderables.forEach((renderable) => this.drawRenderable(renderable));
    this.drawAxisIndicator();
    this.drawSectionIndicator();
  }
}
