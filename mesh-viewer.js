import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const VIEW_DIRECTIONS = {
  iso: new THREE.Vector3(1, 1, 0.8).normalize(),
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 0, 1),
  bottom: new THREE.Vector3(0, 0, -1),
};

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

function hexToColor(value, fallback = "#8aa6d1") {
  return new THREE.Color(value || fallback);
}

function boxFromBounds(bounds) {
  return new THREE.Box3(
    new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
    new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
  );
}

function unionBounds(boundsList) {
  const box = new THREE.Box3();
  let hasValue = false;
  boundsList.forEach((bounds) => {
    if (!bounds) {
      return;
    }
    box.union(boxFromBounds(bounds));
    hasValue = true;
  });

  if (!hasValue) {
    box.min.set(-5, -5, -5);
    box.max.set(5, 5, 5);
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return {
    min: { x: box.min.x, y: box.min.y, z: box.min.z },
    max: { x: box.max.x, y: box.max.y, z: box.max.z },
    center: { x: center.x, y: center.y, z: center.z },
    size: { x: size.x, y: size.y, z: size.z },
  };
}

function triangleRangeContains(face, triangleIndex) {
  return triangleIndex >= face.triangleFirst && triangleIndex <= face.triangleLast;
}

function createMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.58,
    metalness: 0.08,
    side: THREE.DoubleSide,
  });
}

function normalizeMap(value) {
  if (!value) {
    return new Map();
  }
  if (value instanceof Map) {
    return new Map(value);
  }
  if (Array.isArray(value)) {
    return new Map(value);
  }
  return new Map(Object.entries(value));
}

function normalizeNumberMap(value) {
  const result = new Map();
  normalizeMap(value).forEach((entryValue, key) => {
    const numericValue = Number(entryValue);
    if (Number.isFinite(numericValue)) {
      result.set(key, Math.max(0, Math.min(1, numericValue)));
    }
  });
  return result;
}

function normalizeDirection(value) {
  const vector = Array.isArray(value)
    ? new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0)
    : new THREE.Vector3(Number(value?.x) || 0, Number(value?.y) || 0, Number(value?.z) || 0);
  if (vector.lengthSq() < 1e-9) {
    vector.set(1, 0, 0);
  }
  return vector.normalize();
}

export class WorkbenchViewer {
  constructor({ canvas, onObjectPick, onHintChange }) {
    this.canvas = canvas;
    this.onObjectPick = onObjectPick;
    this.onHintChange = onHintChange;
    this.sceneData = null;
    this.meshRecords = new Map();
    this.nodeMap = new Map();
    this.partColorIndexMap = new Map();
    this.meshPartColorIndexMap = new Map();
    this.hovered = null;
    this.selection = null;
    this.state = {
      selectionMode: "part",
      colorMode: "face", // "face" 或 "part"
      hiddenNodeIds: new Set(),
      isolatedNodeIds: null,
      section: {
        enabled: false,
        axis: "x",
        offset: 0,
      },
      transparencyLevels: new Map(),
      fadeOthers: null,
      highlightedFaces: new Map(),
      explodedView: null,
      partTransforms: new Map(),
    };

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0xffffff, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xffffff);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(180, -220, 140);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => this.render());

    this.rootGroup = new THREE.Group();
    this.scene.add(this.rootGroup);

    this.sectionPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragState = null;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(180, -220, 280);
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x9ec5ff, 0.36);
    rimLight.position.set(-160, 100, 200);
    this.scene.add(rimLight);

    this.grid = new THREE.GridHelper(600, 30, 0xcccccc, 0xe0e0e0);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = -0.01;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(150);
    this.axes.material.depthTest = false;
    this.axes.renderOrder = 999;
    this.scene.add(this.axes);

    this.handleResize = this.handleResize.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleDoubleClick = this.handleDoubleClick.bind(this);

    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointerleave", this.handlePointerUp);
    this.canvas.addEventListener("dblclick", this.handleDoubleClick);

    if ("ResizeObserver" in window) {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.canvas);
    } else {
      window.addEventListener("resize", this.handleResize);
    }

    this.handleResize();
    this.animationFrame = requestAnimationFrame(() => this.renderLoop());

    // 角落3D轴指示器
    this.initOrientationWidget();
  }

  initOrientationWidget() {
    // 创建独立canvas覆盖层
    this.orientCanvas = document.createElement("canvas");
    this.orientCanvas.style.cssText =
      "position:absolute;bottom:16px;left:16px;width:100px;height:100px;pointer-events:none;z-index:10;";
    this.canvas.parentElement.appendChild(this.orientCanvas);

    this.orientRenderer = new THREE.WebGLRenderer({ canvas: this.orientCanvas, antialias: true, alpha: true });
    this.orientRenderer.setPixelRatio(window.devicePixelRatio || 1);
    this.orientRenderer.setClearColor(0x000000, 0);
    this.orientRenderer.setSize(100, 100, false);

    this.orientScene = new THREE.Scene();

    // 正交相机，固定等轴测视角
    this.orientCamera = new THREE.OrthographicCamera(-30, 30, 30, -30, 0.1, 1000);
    this.orientCamera.position.set(50, 50, 50);
    this.orientCamera.lookAt(0, 0, 0);

    // X轴箭头（红色）
    const xArrow = new THREE.Group();
    xArrow.add(new THREE.Mesh(new THREE.CylinderGeometry(0, 2.5, 10, 8), new THREE.MeshBasicMaterial({ color: 0xe74c3c })));
    const xCone = new THREE.Mesh(new THREE.ConeGeometry(3, 8, 8), new THREE.MeshBasicMaterial({ color: 0xe74c3c }));
    xCone.position.set(10, 0, 0);
    xCone.rotation.z = -Math.PI / 2;
    xArrow.add(xCone);
    this.orientScene.add(xArrow);

    // Y轴箭头（绿色）
    const yArrow = new THREE.Group();
    yArrow.add(new THREE.Mesh(new THREE.CylinderGeometry(0, 2.5, 10, 8), new THREE.MeshBasicMaterial({ color: 0x2ecc71 })));
    const yCone = new THREE.Mesh(new THREE.ConeGeometry(3, 8, 8), new THREE.MeshBasicMaterial({ color: 0x2ecc71 }));
    yCone.position.set(0, 10, 0);
    yArrow.add(yCone);
    this.orientScene.add(yArrow);

    // Z轴箭头（蓝色）
    const zArrow = new THREE.Group();
    zArrow.add(new THREE.Mesh(new THREE.CylinderGeometry(0, 2.5, 10, 8), new THREE.MeshBasicMaterial({ color: 0x3498db })));
    const zCone = new THREE.Mesh(new THREE.ConeGeometry(3, 8, 8), new THREE.MeshBasicMaterial({ color: 0x3498db }));
    zCone.position.set(0, 0, 10);
    zCone.rotation.x = Math.PI / 2;
    zArrow.add(zCone);
    this.orientScene.add(zArrow);
  }

  renderOrientationWidget() {
    if (!this.orientRenderer) return;
    this.orientRenderer.render(this.orientScene, this.orientCamera);
  }

  snapshot() {
    return {
      cameraPosition: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
    };
  }

  restore(snapshot) {
    if (!snapshot) {
      return;
    }
    if (snapshot.cameraPosition) {
      this.camera.position.fromArray(snapshot.cameraPosition);
    }
    if (snapshot.target) {
      this.controls.target.fromArray(snapshot.target);
    }
    this.controls.update();
    this.render();
  }

  destroy() {
    cancelAnimationFrame(this.animationFrame);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointerleave", this.handlePointerUp);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    } else {
      window.removeEventListener("resize", this.handleResize);
    }
    this.controls.dispose();
    this.disposeSceneObjects();
    this.renderer.dispose();
    if (this.orientRenderer) {
      this.orientRenderer.dispose();
      this.orientCanvas?.remove();
    }
  }

  renderLoop() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.renderOrientationWidget();
    this.animationFrame = requestAnimationFrame(() => this.renderLoop());
  }

  render() {
    this.renderer.render(this.scene, this.camera);
    this.renderOrientationWidget();
  }

  handleResize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  handlePointerDown(event) {
    this.dragState = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  }

  handlePointerMove(event) {
    if (this.dragState) {
      const deltaX = Math.abs(event.clientX - this.dragState.x);
      const deltaY = Math.abs(event.clientY - this.dragState.y);
      if (deltaX > 3 || deltaY > 3) {
        this.dragState.moved = true;
      }
    }

    const pick = this.pick(event);
    const hoverKey = pick ? `${pick.nodeId}:${pick.faceId || pick.meshId || "part"}` : null;
    const currentKey = this.hovered ? `${this.hovered.nodeId}:${this.hovered.faceId || this.hovered.meshId || "part"}` : null;
    if (hoverKey !== currentKey) {
      this.hovered = pick;
      this.onHintChange(pick ? `悬停：${pick.label}` : "拖拽旋转，滚轮缩放，双击适配");
      this.applyVisualState();
    }
  }

  handlePointerUp(event) {
    if (!this.dragState) {
      return;
    }
    const moved = this.dragState.moved;
    this.dragState = null;
    if (!moved) {
      const pick = this.pick(event);
      if (pick) {
        this.onObjectPick(pick);
      }
    }
  }

  handleDoubleClick() {
    this.fit();
    this.onHintChange("视图已适配");
  }

  pick(event) {
    if (!this.sceneData) {
      return null;
    }

    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(
      [...this.meshRecords.values()].map((record) => record.mesh),
      false,
    );
    if (!intersects.length) {
      return null;
    }

    const intersection = intersects[0];
    const record = this.meshRecords.get(intersection.object.userData.meshId);
    if (!record) {
      return null;
    }

    const triangleIndex = Math.floor((intersection.faceIndex || 0) / 1);
    if (this.state.selectionMode === "face") {
      const face = record.meshData.brepFaces.find((candidate) => triangleRangeContains(candidate, triangleIndex));
      if (face) {
        return {
          nodeId: record.meshData.nodeId,
          meshId: record.meshData.id,
          faceId: face.id,
          selectionType: "face",
          label: `${record.node.name} / ${face.name || `Face ${face.faceIndex + 1}`}`,
          point: intersection.point.toArray(),
          normal: face.normal,
        };
      }
    }

    return {
      nodeId: record.meshData.nodeId,
      meshId: record.meshData.id,
      selectionType: "part",
      label: record.node.name,
      point: intersection.point.toArray(),
    };
  }

  disposeSceneObjects() {
    this.meshRecords.forEach((record) => {
      record.mesh.geometry.dispose();
      const materials = Array.isArray(record.mesh.material) ? record.mesh.material : [record.mesh.material];
      materials.forEach((material) => material.dispose());
      if (record.edges) {
        record.edges.geometry.dispose();
        record.edges.material.dispose();
      }
    });
    this.meshRecords.clear();
    this.rootGroup.clear();
  }

  buildMaterials(meshData, geometry) {
    geometry.clearGroups();
    const defaultMaterial = createMaterial(hexToColor(meshData.color));
    const materials = [defaultMaterial];

    // 如果是零件级着色模式，为每个零件（mesh）分配唯一颜色
    if (this.state.colorMode === "part") {
      const partIndex = this.meshPartColorIndexMap?.get(meshData.id) ?? 0;
      const totalParts = this.partColorIndexMap?.size ?? 1;
      const partColor = getFaceColor(partIndex, totalParts);
      console.error("[DEBUG] buildMaterials part mode:", {
        meshId: meshData.id,
        nodeId: meshData.nodeId,
        partIndex,
        totalParts,
        partColor,
        mapSize: this.meshPartColorIndexMap?.size
      });
      materials[0] = createMaterial(hexToColor(partColor));
      geometry.addGroup(0, meshData.index.length * 3, 0);
      return materials;
    }

    // 面级着色模式：为每个BRep面分配不同颜色
    if (meshData.brepFaces?.length) {
      const triangleCount = meshData.index.length / 3;
      let triangleIndex = 0;
      let faceIndex = 0;
      while (triangleIndex < triangleCount) {
        const firstIndex = triangleIndex;
        let lastIndex = triangleCount;
        let materialIndex = 0;

        if (faceIndex < meshData.brepFaces.length) {
          const face = meshData.brepFaces[faceIndex];
          if (triangleIndex < face.triangleFirst) {
            lastIndex = face.triangleFirst;
          } else {
            const faceColor = getFaceColor(faceIndex, meshData.brepFaces.length);
            materials.push(createMaterial(faceColor));
            materialIndex = materials.length - 1;
            face.materialIndex = materialIndex;
            face.renderColor = faceColor; // 存储渲染颜色供UI使用
            lastIndex = face.triangleLast + 1;
            faceIndex += 1;
          }
        }

        geometry.addGroup(firstIndex * 3, (lastIndex - firstIndex) * 3, materialIndex);
        triangleIndex = lastIndex;
      }
    }

    return materials;
  }

  setScene(sceneData, { preserveCamera = false } = {}) {
    this.sceneData = sceneData;
    this.nodeMap = new Map(sceneData.nodes.map((node) => [node.id, node]));
    // 为零件级着色创建 nodeId -> colorIndex 映射
    this.partColorIndexMap = new Map();
    let partColorIndex = 0;
    for (const node of sceneData.nodes) {
      this.partColorIndexMap.set(node.id, partColorIndex++);
    }
    // 同时建立 meshId -> partColorIndex 映射（用于快速查找）
    this.meshPartColorIndexMap = new Map();
    console.error("[DEBUG] setScene mesh setup:", { nodeCount: sceneData.nodes.length, meshCount: sceneData.meshes.length });
    sceneData.meshes.forEach((meshData) => {
      const nodeId = meshData.nodeId;
      const colorIdx = this.partColorIndexMap.get(nodeId) ?? 0;
      console.error("[DEBUG] setScene mesh:", { meshId: meshData.id, nodeId: nodeId, colorIdx: colorIdx });
      this.meshPartColorIndexMap.set(meshData.id, colorIdx);
    });
    this.disposeSceneObjects();

    sceneData.meshes.forEach((meshData) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(meshData.attributes.position, 3));
      if (meshData.attributes.normal) {
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(meshData.attributes.normal, 3));
      } else {
        geometry.computeVertexNormals();
      }
      geometry.setIndex(meshData.index);
      geometry.computeBoundingSphere();

      const materials = this.buildMaterials(meshData, geometry);
      const mesh = new THREE.Mesh(geometry, materials.length > 1 ? materials : materials[0]);
      mesh.userData.meshId = meshData.id;
      mesh.castShadow = false;
      mesh.receiveShadow = true;

      const edgesGeometry = new THREE.EdgesGeometry(geometry, 30);
      const edges = new THREE.LineSegments(
        edgesGeometry,
        new THREE.LineBasicMaterial({ color: 0x263244, transparent: true, opacity: 0.35 }),
      );
      edges.renderOrder = 2;

      this.rootGroup.add(mesh);
      this.rootGroup.add(edges);

      this.meshRecords.set(meshData.id, {
        mesh,
        edges,
        meshData,
        node: this.nodeMap.get(meshData.nodeId),
        baseColors: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((material) =>
          material.color.clone(),
        ),
      });
    });

    this.updateSectionPlane();
    this.applyVisualState();
    if (!preserveCamera) {
      this.fit();
    } else {
      this.render();
    }
  }

  updateSectionPlane() {
    const axisMap = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    };
    const axis = axisMap[this.state.section.axis] || axisMap.x;
    this.sectionPlane.set(axis, -this.state.section.offset);
  }

  updateState(partialState) {
    const prevColorMode = this.state.colorMode;
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
    this.updateSectionPlane();
    // 如果colorMode改变了，需要重建材质
    if (partialState.colorMode !== undefined && partialState.colorMode !== prevColorMode) {
      this.rebuildMaterials();
    }
    this.applyVisualState();
  }

  rebuildMaterials() {
    console.error("[DEBUG] rebuildMaterials called, colorMode:", this.state.colorMode, "meshRecords:", this.meshRecords.size);
    console.error("[DEBUG] current state.colorMode:", this.state.colorMode);
    this.meshRecords.forEach((record) => {
      const { mesh, meshData, node, edges } = record;
      const geometry = mesh.geometry;

      // 重建材质
      const materials = this.buildMaterials(meshData, geometry);
      mesh.material = materials.length > 1 ? materials : materials[0];
      console.error("[DEBUG] After rebuildMaterials:", {
        meshId: meshData.id,
        nodeId: meshData.nodeId,
        materialType: Array.isArray(mesh.material) ? "array" : "single",
        materialColor: Array.isArray(mesh.material) ? mesh.material[0]?.color?.getHexString() : mesh.material?.color?.getHexString()
      });

      // 重建边的几何
      edges.geometry.dispose();
      edges.geometry = new THREE.EdgesGeometry(geometry, 30);
      edges.material.dispose();
      edges.material = new THREE.LineBasicMaterial({ color: 0x263244, transparent: true, opacity: 0.35 });
    });
    this.render();
  }

  setTransparency({ partIds = [], level = 0, mode = "set", levels = null } = {}) {
    if (mode === "clear") {
      this.state.transparencyLevels = new Map();
      this.state.fadeOthers = null;
    } else if (mode === "fade_others") {
      this.state.fadeOthers = {
        partIds: new Set(partIds),
        level: Math.max(0, Math.min(1, Number(level) || 0)),
      };
    } else {
      const nextLevels = levels ? normalizeNumberMap(levels) : new Map(this.state.transparencyLevels);
      partIds.forEach((partId) => {
        nextLevels.set(partId, Math.max(0, Math.min(1, Number(level) || 0)));
      });
      this.state.transparencyLevels = nextLevels;
      this.state.fadeOthers = null;
    }
    this.applyVisualState();
  }

  setFaceHighlights({ highlights = null, faceIds = [], color = "#f0b13f", clearExisting = false } = {}) {
    const nextHighlights = clearExisting ? new Map() : new Map(this.state.highlightedFaces);
    normalizeMap(highlights).forEach((highlightColor, faceId) => {
      nextHighlights.set(faceId, highlightColor || color);
    });
    faceIds.forEach((faceId) => {
      nextHighlights.set(faceId, color);
    });
    this.state.highlightedFaces = nextHighlights;
    this.applyVisualState();
  }

  setExplodedView(explodedView) {
    if (!explodedView || Number(explodedView.factor) <= 0) {
      this.state.explodedView = null;
    } else {
      this.state.explodedView = {
        direction: normalizeDirection(explodedView.direction).toArray(),
        factor: Number(explodedView.factor) || 0,
        scope: explodedView.scope || "assembly",
        anchorPartId: explodedView.anchor_part_id || explodedView.anchorPartId || null,
        mode: explodedView.mode || "linear",
      };
    }
    this.applyExplodedView();
    this.render();
  }

  setPartTransforms(transforms = null) {
    const nextTransforms = new Map();
    normalizeMap(transforms).forEach((value, partId) => {
      const vector = Array.isArray(value)
        ? new THREE.Vector3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0)
        : new THREE.Vector3(Number(value?.x) || 0, Number(value?.y) || 0, Number(value?.z) || 0);
      nextTransforms.set(partId, vector);
    });
    this.state.partTransforms = nextTransforms;
    this.applyExplodedView();
    this.render();
  }

  applyExplodedView() {
    const explodedView = this.state.explodedView;
    const bounds = this.sceneData?.bounds;
    const modelCenter = bounds
      ? new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z)
      : new THREE.Vector3();
    const modelSize = bounds
      ? new THREE.Vector3(bounds.size.x, bounds.size.y, bounds.size.z)
      : new THREE.Vector3(100, 100, 100);
    const baseDistance = Math.max(modelSize.length() * 0.22, 20);
    const direction = normalizeDirection(explodedView?.direction);
    const anchorPartId = explodedView?.anchorPartId || null;
    const anchorNode = anchorPartId ? this.nodeMap.get(anchorPartId) : null;
    const anchorCenter = anchorNode?.bbox?.center
      ? new THREE.Vector3(anchorNode.bbox.center.x, anchorNode.bbox.center.y, anchorNode.bbox.center.z)
      : modelCenter;

    this.meshRecords.forEach((record) => {
      const node = record.node;
      const offset = new THREE.Vector3();
      if (explodedView && node?.bbox) {
        const nodeCenter = new THREE.Vector3(node.bbox.center.x, node.bbox.center.y, node.bbox.center.z);
        const factor = Number(explodedView.factor) || 0;
        if (explodedView.mode === "radial") {
          offset.copy(nodeCenter).sub(anchorPartId ? anchorCenter : modelCenter);
          if (offset.lengthSq() < 1e-9) {
            offset.copy(direction);
          }
          offset.normalize().multiplyScalar(baseDistance * factor);
        } else if (explodedView.mode === "hierarchy") {
          const depth = Math.max(1, Number(node.depth || node.pathNames?.length || 1));
          offset.copy(direction).multiplyScalar(baseDistance * factor * depth * 0.35);
        } else {
          const projected = nodeCenter.clone().sub(anchorPartId ? anchorCenter : modelCenter).dot(direction);
          const signedScale = projected >= 0 ? 1 : -1;
          const distance = baseDistance * factor * (0.35 + Math.min(1.5, Math.abs(projected) / Math.max(modelSize.length() * 0.5, 1)));
          offset.copy(direction).multiplyScalar(distance * signedScale);
        }
      }
      const partTransform = this.state.partTransforms.get(record.meshData.nodeId);
      if (partTransform) {
        offset.add(partTransform);
      }

      record.mesh.position.copy(offset);
      if (record.edges) {
        record.edges.position.copy(offset);
      }
    });
  }

  setSelection(selection) {
    this.selection = selection;
    this.applyVisualState();
  }

  applyVisualState() {
    this.meshRecords.forEach((record) => {
      const visibleByHidden = !this.state.hiddenNodeIds.has(record.meshData.nodeId);
      const visibleByIsolation =
        !this.state.isolatedNodeIds || this.state.isolatedNodeIds.has(record.meshData.nodeId);
      record.mesh.visible = visibleByHidden && visibleByIsolation;
      // 剖切启用时隐藏线框，避免被剖切面上的边缘线干扰视觉
      record.edges.visible = record.mesh.visible && !this.state.section.enabled;
      record.edges.position.copy(record.mesh.position);

      const materials = Array.isArray(record.mesh.material) ? record.mesh.material : [record.mesh.material];
      let opacity = 1;
      if (this.state.fadeOthers) {
        opacity = this.state.fadeOthers.partIds.has(record.meshData.nodeId)
          ? 1
          : 1 - this.state.fadeOthers.level;
      } else if (this.state.transparencyLevels.has(record.meshData.nodeId)) {
        opacity = 1 - this.state.transparencyLevels.get(record.meshData.nodeId);
      }
      materials.forEach((material, index) => {
        // 只在 face 模式下恢复到 baseColors，part 模式保持当前材质颜色
        if (this.state.colorMode !== "part") {
          material.color.copy(record.baseColors[index] || record.baseColors[0]);
        }
        material.emissive = new THREE.Color(0x000000);
        material.opacity = opacity;
        material.transparent = opacity < 0.999;
        material.depthWrite = opacity >= 0.999;
        material.clippingPlanes = this.state.section.enabled ? [this.sectionPlane] : [];
        material.clipShadows = true;
      });

      const isSelectedPart =
        this.selection && this.selection.selectionType !== "face" && this.selection.nodeId === record.meshData.nodeId;
      const isHoveredPart =
        this.hovered && this.hovered.selectionType !== "face" && this.hovered.nodeId === record.meshData.nodeId;

      if (isSelectedPart || isHoveredPart) {
        materials.forEach((material) => {
          material.emissive = new THREE.Color(isSelectedPart ? 0x3f8cff : 0x22334d);
          material.emissiveIntensity = isSelectedPart ? 0.28 : 0.18;
        });
      }

      const selectedFaceId =
        this.selection && this.selection.selectionType === "face" ? this.selection.faceId : null;
      const hoveredFaceId = this.hovered && this.hovered.selectionType === "face" ? this.hovered.faceId : null;
      record.meshData.brepFaces.forEach((face) => {
        const material = materials[face.materialIndex || 0];
        if (!material) {
          return;
        }
        const highlightColor = this.state.highlightedFaces.get(face.id);
        if (highlightColor) {
          material.color.set(highlightColor);
          material.emissive = new THREE.Color(highlightColor);
          material.emissiveIntensity = 0.22;
        }
        if (selectedFaceId === face.id) {
          material.color.set(0xf0b13f);
          material.emissive = new THREE.Color(0x7f5300);
          material.emissiveIntensity = 0.35;
        } else if (hoveredFaceId === face.id) {
          material.color.offsetHSL(0, 0, 0.08);
          material.emissive = new THREE.Color(0x3a2b00);
          material.emissiveIntensity = 0.18;
        }
      });
    });

    this.applyExplodedView();
    this.render();
  }

  fit() {
    const bounds = this.sceneData?.bounds;
    if (!bounds) {
      return;
    }
    const center = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
    const size = new THREE.Vector3(bounds.size.x, bounds.size.y, bounds.size.z);
    const radius = Math.max(size.length() * 0.55, 20);
    const direction = VIEW_DIRECTIONS.iso.clone();
    this.controls.target.copy(center);
    this.camera.position.copy(center.clone().addScaledVector(direction, radius * 2.2));
    this.camera.near = Math.max(radius / 500, 0.1);
    this.camera.far = Math.max(radius * 20, 5000);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }

  // 设置摄像机位置（球坐标）
  // azimuth: 方位角（度），0=+Y方向，90=+X方向
  // elevation: 仰角（度），0=水平，90=头顶，-90=脚下
  // distance: 距离
  // roll: 绕视线旋转（度）
  setCameraBySpherical(azimuth, elevation, distance, roll = 0) {
    const bounds = this.sceneData?.bounds || { center: { x: 0, y: 0, z: 0 }, size: { x: 100, y: 100, z: 100 } };
    const center = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);

    // 转换为弧度
    const azRad = (azimuth * Math.PI) / 180;
    const elRad = (elevation * Math.PI) / 180;
    const rollRad = (roll * Math.PI) / 180;

    // 计算摄像机位置（球坐标转笛卡尔）
    // 以target为中心
    const r = distance;
    const x = r * Math.cos(elRad) * Math.sin(azRad);
    const y = -r * Math.cos(elRad) * Math.cos(azRad);
    const z = r * Math.sin(elRad);

    this.controls.target.copy(center);
    this.camera.position.set(center.x + x, center.y + y, center.z + z);

    // 设置 roll（绕视线旋转）
    // roll 为正时向左旋转
    const upX = Math.sin(rollRad);
    const upY = Math.cos(rollRad);
    const upZ = 0;
    this.camera.up.set(upX, upY, upZ);

    this.controls.update();
    this.render();
  }

  // 获取当前摄像机球坐标参数
  getCurrentSphericalParams() {
    if (!this.sceneData?.bounds) {
      return { azimuth: 45, elevation: 30, distance: 200, roll: 0 };
    }

    const bounds = this.sceneData.bounds;
    const center = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
    const size = new THREE.Vector3(bounds.size.x, bounds.size.y, bounds.size.z);
    const radius = Math.max(size.length() * 0.55, 20);

    // 从摄像机位置计算球坐标
    const pos = this.camera.position.clone().sub(center);

    const distance = pos.length();
    if (distance < 0.001) {
      return { azimuth: 45, elevation: 30, distance: radius * 2.2, roll: 0 };
    }

    // 归一化
    const x = pos.x / distance;
    const y = pos.y / distance;
    const z = pos.z / distance;

    // 计算方位角
    let azimuth = (Math.atan2(x, -y) * 180) / Math.PI;
    if (azimuth < 0) azimuth += 360;

    // 计算仰角
    const elevation = (Math.asin(z) * 180) / Math.PI;

    // 计算 roll
    // 从 camera.up 向量计算绕视线的旋转
    const roll = 0; // 简化计算

    return {
      azimuth: Math.round(azimuth * 10) / 10,
      elevation: Math.round(elevation * 10) / 10,
      distance: Math.round(distance),
      roll: 0,
    };
  }

  setViewPreset(preset) {
    const direction = (VIEW_DIRECTIONS[preset] || VIEW_DIRECTIONS.iso).clone();
    const bounds = this.sceneData?.bounds || unionBounds([]);
    const center = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
    const size = new THREE.Vector3(bounds.size.x, bounds.size.y, bounds.size.z);
    const radius = Math.max(size.length() * 0.55, 20);
    this.controls.target.copy(center);
    this.camera.position.copy(center.clone().addScaledVector(direction, radius * 2.2));
    if (preset === "top" || preset === "bottom") {
      this.camera.up.set(0, 1, 0);
    } else {
      this.camera.up.set(0, 0, 1);
    }
    this.controls.update();
    this.render();
  }

  // 捕获多角度快照
  async captureAngleSnapshots(angles = ["iso", "front", "left", "top", "right", "back", "bottom"]) {
    const snapshots = [];
    const bounds = this.sceneData?.bounds;
    if (!bounds) {
      return snapshots;
    }

    const center = new THREE.Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
    const size = new THREE.Vector3(bounds.size.x, bounds.size.y, bounds.size.z);
    const radius = Math.max(size.length() * 0.55, 20);

    // 保存当前状态
    const originalTarget = this.controls.target.clone();
    const originalPosition = this.camera.position.clone();
    const originalUp = this.camera.up.clone();

    for (const angle of angles) {
      const direction = VIEW_DIRECTIONS[angle]?.clone() || VIEW_DIRECTIONS.iso.clone();
      this.controls.target.copy(center);
      this.camera.position.copy(center.clone().addScaledVector(direction, radius * 2.2));

      if (angle === "top" || angle === "bottom") {
        this.camera.up.set(0, 1, 0);
      } else {
        this.camera.up.set(0, 0, 1);
      }

      this.controls.update();
      this.render();

      // 等待一帧确保渲染完成
      await new Promise((resolve) => requestAnimationFrame(resolve));

      snapshots.push({
        angle,
        label: angleLabelMap[angle] || angle,
        dataUrl: this.canvas.toDataURL("image/png"),
      });
    }

    // 恢复原始状态
    this.controls.target.copy(originalTarget);
    this.camera.position.copy(originalPosition);
    this.camera.up.copy(originalUp);
    this.controls.update();
    this.render();

    return snapshots;
  }
}

const angleLabelMap = {
  iso: "等轴测",
  front: "前视",
  left: "左视",
  top: "顶视",
  right: "右视",
  back: "后视",
  bottom: "底视",
};
