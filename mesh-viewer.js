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

function toVector3(vector = { x: 0, y: 0, z: 0 }) {
  return new THREE.Vector3(vector.x || 0, vector.y || 0, vector.z || 0);
}

function createReasoningOverlayState() {
  return {
    focusPartIds: [],
    basePartId: null,
    assemblingPartId: null,
    baseFaceIds: [],
    assemblingFaceIds: [],
    insertionAxis: null,
    interferenceBoxes: [],
  };
}

function disposeObjectTree(object) {
  object.traverse((child) => {
    if (child.geometry) {
      child.geometry.dispose();
    }
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material?.dispose?.());
    }
  });
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

function indexToMaskHex(index) {
  const value = index + 1;
  return `#${value.toString(16).padStart(6, "0")}`;
}

export class WorkbenchViewer {
  constructor({ canvas, onObjectPick, onHintChange }) {
    this.canvas = canvas;
    this.onObjectPick = onObjectPick;
    this.onHintChange = onHintChange;
    this.sceneData = null;
    this.meshRecords = new Map();
    this.nodeMap = new Map();
    this.nodeMaskColors = new Map();
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
      reasoningOverlay: createReasoningOverlayState(),
    };

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.localClippingEnabled = true;
    this.renderer.setClearColor(0x111925, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111925);

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

    this.reasoningOverlayGroup = new THREE.Group();
    this.scene.add(this.reasoningOverlayGroup);

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

    this.grid = new THREE.GridHelper(600, 30, 0x263244, 0x1a2433);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.z = -0.01;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(80);
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
    this.clearReasoningOverlay();
    this.renderer.dispose();
  }

  renderLoop() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(() => this.renderLoop());
  }

  render() {
    this.renderer.render(this.scene, this.camera);
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
            const faceColor = hexToColor(face.color || meshData.color);
            materials.push(createMaterial(faceColor));
            materialIndex = materials.length - 1;
            face.materialIndex = materialIndex;
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
    this.nodeMaskColors = new Map();
    this.disposeSceneObjects();

    sceneData.nodes
      .filter((node) => node.kind === "part")
      .forEach((node, index) => {
        this.nodeMaskColors.set(node.id, indexToMaskHex(index));
      });

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
        maskColorHex: this.nodeMaskColors.get(meshData.nodeId) || "#000001",
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

  clearReasoningOverlay() {
    while (this.reasoningOverlayGroup.children.length) {
      const child = this.reasoningOverlayGroup.children[0];
      this.reasoningOverlayGroup.remove(child);
      disposeObjectTree(child);
    }
  }

  renderReasoningOverlay() {
    this.clearReasoningOverlay();

    const overlay = this.state.reasoningOverlay || createReasoningOverlayState();
    if (overlay.insertionAxis) {
      const origin = toVector3(overlay.insertionAxis.origin || { x: 0, y: 0, z: 0 });
      const direction = toVector3(overlay.insertionAxis.direction || { x: 0, y: 0, z: 1 }).normalize();
      const length = Math.max(overlay.insertionAxis.length || 12, 12);
      const arrow = new THREE.ArrowHelper(direction, origin, length, 0x37d4c9, Math.min(length * 0.16, 16), Math.min(length * 0.1, 8));
      this.reasoningOverlayGroup.add(arrow);

      const anchor = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(length * 0.02, 1.8), 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x37d4c9 }),
      );
      anchor.position.copy(origin);
      this.reasoningOverlayGroup.add(anchor);
    }

    (overlay.interferenceBoxes || []).forEach((item) => {
      if (!item?.bbox) {
        return;
      }
      const helper = new THREE.Box3Helper(boxFromBounds(item.bbox), new THREE.Color(0xff6b6b));
      this.reasoningOverlayGroup.add(helper);
    });
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
      reasoningOverlay:
        partialState.reasoningOverlay === undefined
          ? this.state.reasoningOverlay
          : {
              ...createReasoningOverlayState(),
              ...(partialState.reasoningOverlay || {}),
            },
    };
    this.updateSectionPlane();
    this.applyVisualState();
  }

  setSelection(selection) {
    this.selection = selection;
    this.applyVisualState();
  }

  applyVisualState() {
    const overlay = this.state.reasoningOverlay || createReasoningOverlayState();
    const focusSet = new Set(overlay.focusPartIds || []);
    const baseFaceSet = new Set(overlay.baseFaceIds || []);
    const assemblingFaceSet = new Set(overlay.assemblingFaceIds || []);

    this.meshRecords.forEach((record) => {
      const visibleByHidden = !this.state.hiddenNodeIds.has(record.meshData.nodeId);
      const visibleByIsolation =
        !this.state.isolatedNodeIds || this.state.isolatedNodeIds.has(record.meshData.nodeId);
      record.mesh.visible = visibleByHidden && visibleByIsolation;
      record.edges.visible = record.mesh.visible;

      const materials = Array.isArray(record.mesh.material) ? record.mesh.material : [record.mesh.material];
      materials.forEach((material, index) => {
        material.color.copy(record.baseColors[index] || record.baseColors[0]);
        material.emissive = new THREE.Color(0x000000);
        material.opacity = 1;
        material.transparent = false;
        material.clippingPlanes = this.state.section.enabled ? [this.sectionPlane] : [];
        material.clipShadows = true;
      });
      record.edges.material.color.set(0x263244);
      record.edges.material.opacity = 0.35;

      if (focusSet.size && !focusSet.has(record.meshData.nodeId)) {
        materials.forEach((material) => {
          material.transparent = true;
          material.opacity = 0.16;
        });
        record.edges.material.opacity = 0.08;
      }

      const isBasePart = overlay.basePartId === record.meshData.nodeId;
      const isAssemblingPart = overlay.assemblingPartId === record.meshData.nodeId;
      if (isBasePart || isAssemblingPart) {
        materials.forEach((material) => {
          material.emissive = new THREE.Color(isBasePart ? 0x2c66c8 : 0x885200);
          material.emissiveIntensity = isBasePart ? 0.32 : 0.28;
        });
        record.edges.material.color.set(isBasePart ? 0x4eb4ff : 0xffc06d);
        record.edges.material.opacity = 0.9;
      }

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
        if (baseFaceSet.has(face.id)) {
          material.color.set(0x52b5ff);
          material.emissive = new THREE.Color(0x173764);
          material.emissiveIntensity = 0.42;
        } else if (assemblingFaceSet.has(face.id)) {
          material.color.set(0xffbf4d);
          material.emissive = new THREE.Color(0x6a4600);
          material.emissiveIntensity = 0.38;
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

    this.renderReasoningOverlay();
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

  getColorMap(mode = "display") {
    if (!this.sceneData) {
      return [];
    }

    return this.sceneData.nodes
      .filter((node) => node.kind === "part")
      .map((node) => {
        const firstMeshId = node.meshRefs?.[0];
        const record = firstMeshId ? this.meshRecords.get(firstMeshId) : null;
        return {
          nodeId: node.id,
          partId: node.id,
          name: node.name,
          colorHex:
            mode === "id-mask"
              ? this.nodeMaskColors.get(node.id) || "#000001"
              : record?.meshData?.color || node.color || "#8aa6d1",
          visible: Boolean(record?.mesh?.visible),
        };
      });
  }

  getMeshRecordsForNode(nodeId) {
    return [...this.meshRecords.values()].filter((record) => record.meshData.nodeId === nodeId);
  }

  applyNodeTranslationDelta(nodeId, delta) {
    this.getMeshRecordsForNode(nodeId).forEach((record) => {
      record.mesh.position.set(delta.x, delta.y, delta.z);
      record.edges.position.set(delta.x, delta.y, delta.z);
    });
  }

  async composeComparisonImage(beforeDataUrl, afterDataUrl, width, height, labels = ["Before", "After"]) {
    const loadImage = (src) =>
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = src;
      });

    const [beforeImage, afterImage] = await Promise.all([loadImage(beforeDataUrl), loadImage(afterDataUrl)]);
    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height + 44;
    const context = canvas.getContext("2d");

    context.fillStyle = "#0f1622";
    context.fillRect(0, 0, canvas.width, canvas.height);

    context.drawImage(beforeImage, 0, 0, width, height);
    context.drawImage(afterImage, width, 0, width, height);

    context.fillStyle = "rgba(255,255,255,0.9)";
    context.font = '600 18px "Segoe UI", "Microsoft YaHei", sans-serif';
    context.fillText(labels[0], 18, height + 28);
    context.fillText(labels[1], width + 18, height + 28);

    context.strokeStyle = "rgba(255,255,255,0.08)";
    context.beginPath();
    context.moveTo(width, 0);
    context.lineTo(width, canvas.height);
    context.stroke();

    return canvas.toDataURL("image/png");
  }

  capture(mode = "beauty", options = {}) {
    if (!this.sceneData) {
      throw new Error("当前没有可捕获的装配体。");
    }

    const previousSize = new THREE.Vector2();
    this.renderer.getSize(previousSize);
    const previousAspect = this.camera.aspect;
    const targetWidth = Math.max(1, options.width || previousSize.x || this.canvas.width || 1);
    const targetHeight = Math.max(1, options.height || previousSize.y || this.canvas.height || 1);

    if (options.fit) {
      this.fit();
    }

    this.renderer.setSize(targetWidth, targetHeight, false);
    this.camera.aspect = targetWidth / targetHeight;
    this.camera.updateProjectionMatrix();

    let dataUrl;
    if (mode === "id-mask") {
      dataUrl = this.captureMaskFrame();
    } else {
      this.render();
      dataUrl = this.canvas.toDataURL("image/png");
    }

    this.renderer.setSize(previousSize.x, previousSize.y, false);
    this.camera.aspect = previousAspect;
    this.camera.updateProjectionMatrix();
    this.render();

    return {
      dataUrl,
      mimeType: "image/png",
      width: targetWidth,
      height: targetHeight,
      colorMap: this.getColorMap(mode === "id-mask" ? "id-mask" : "display"),
    };
  }

  async captureStepPreview(step, options = {}) {
    if (!step) {
      throw new Error("缺少装配步骤数据。");
    }

    const previousSize = new THREE.Vector2();
    this.renderer.getSize(previousSize);
    const previousAspect = this.camera.aspect;
    const width = Math.max(1, options.width || previousSize.x || this.canvas.width || 1);
    const height = Math.max(1, options.height || previousSize.y || this.canvas.height || 1);

    const visibilitySnapshot = [...this.meshRecords.values()].map((record) => ({
      record,
      meshVisible: record.mesh.visible,
      edgesVisible: record.edges.visible,
      meshPosition: record.mesh.position.clone(),
      edgePosition: record.edges.position.clone(),
    }));

    const focusNodeIds = new Set([step.basePart.partId, step.assemblingPart.partId]);
    this.meshRecords.forEach((record) => {
      const visible = focusNodeIds.has(record.meshData.nodeId);
      record.mesh.visible = visible;
      record.edges.visible = visible;
    });

    if (options.fit !== false) {
      this.fit();
    }

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const delta = step.transformBefore?.translation && step.transformAfter?.translation
      ? {
          x: step.transformBefore.translation.x - step.transformAfter.translation.x,
          y: step.transformBefore.translation.y - step.transformAfter.translation.y,
          z: step.transformBefore.translation.z - step.transformAfter.translation.z,
        }
      : {
          x: -(step.deltaTransform?.translation?.x || 0),
          y: -(step.deltaTransform?.translation?.y || 0),
          z: -(step.deltaTransform?.translation?.z || 0),
        };

    this.applyNodeTranslationDelta(step.assemblingPart.partId, delta);
    this.render();
    const beforeDataUrl = this.canvas.toDataURL("image/png");

    this.applyNodeTranslationDelta(step.assemblingPart.partId, { x: 0, y: 0, z: 0 });
    this.render();
    const afterDataUrl = this.canvas.toDataURL("image/png");

    const compositeDataUrl = await this.composeComparisonImage(beforeDataUrl, afterDataUrl, width, height);

    visibilitySnapshot.forEach((snapshot) => {
      snapshot.record.mesh.visible = snapshot.meshVisible;
      snapshot.record.edges.visible = snapshot.edgesVisible;
      snapshot.record.mesh.position.copy(snapshot.meshPosition);
      snapshot.record.edges.position.copy(snapshot.edgePosition);
    });

    this.renderer.setSize(previousSize.x, previousSize.y, false);
    this.camera.aspect = previousAspect;
    this.camera.updateProjectionMatrix();
    this.applyVisualState();

    return {
      dataUrl: compositeDataUrl,
      beforeDataUrl,
      afterDataUrl,
      mimeType: "image/png",
      width: width * 2,
      height: height + 44,
      labels: ["Before", "After"],
    };
  }

  captureMaskFrame() {
    const previousBackground = this.scene.background;
    this.scene.background = new THREE.Color(0x000000);
    this.grid.visible = false;
    this.axes.visible = false;

    const restoreEntries = [];
    this.meshRecords.forEach((record) => {
      const materials = Array.isArray(record.mesh.material) ? record.mesh.material : [record.mesh.material];
      restoreEntries.push({
        record,
        edgeVisible: record.edges.visible,
        materialState: materials.map((material) => ({
          color: material.color.clone(),
          emissive: material.emissive?.clone?.() || new THREE.Color(0x000000),
          emissiveIntensity: material.emissiveIntensity || 0,
          transparent: material.transparent,
          opacity: material.opacity,
        })),
      });

      const maskColor = new THREE.Color(record.maskColorHex);
      materials.forEach((material) => {
        material.color.copy(maskColor);
        if (material.emissive) {
          material.emissive.set(0x000000);
          material.emissiveIntensity = 0;
        }
        material.transparent = false;
        material.opacity = 1;
      });
      record.edges.visible = false;
    });

    this.render();
    const dataUrl = this.canvas.toDataURL("image/png");

    restoreEntries.forEach(({ record, edgeVisible, materialState }) => {
      const materials = Array.isArray(record.mesh.material) ? record.mesh.material : [record.mesh.material];
      materials.forEach((material, index) => {
        const previous = materialState[index];
        material.color.copy(previous.color);
        if (material.emissive) {
          material.emissive.copy(previous.emissive);
          material.emissiveIntensity = previous.emissiveIntensity;
        }
        material.transparent = previous.transparent;
        material.opacity = previous.opacity;
      });
      record.edges.visible = edgeVisible;
    });

    this.grid.visible = true;
    this.axes.visible = true;
    this.scene.background = previousBackground;
    this.applyVisualState();

    return dataUrl;
  }
}







