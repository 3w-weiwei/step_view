# STEP Workbench MVP

当前版本已经从“包围盒代理演示”推进到了“OCCT-backed 真实网格查看”：

`导入 STEP -> 本地缓存 -> OCCT 解析 -> 真实三角网格 -> 工作台交互`

## 当前能力

- 模型中心页：导入、拖拽上传、搜索、状态筛选、项目卡片
- 本地缓存：一项目一目录，生成 `source.step`、`manifest.json`、`assembly.json`、`thumbnail.svg`
- 真实 STEP 解析：提取装配层级、零件 mesh、BRep face 分段、拓扑计数、包围盒
- 工作台：真实三角网格渲染、零件级选择、面级选择、距离测量、角度测量、剖切、截图导出

## 当前技术路线

- 宿主：Electron
- 渲染：原生 HTML / CSS / JS + Three.js
- OCCT 层：`occt-import-js`
- 进程模型：
  - 优先尝试独立 `occt-sidecar.js`
  - 如果当前环境不允许 `fork`，自动回退到嵌入式 OCCT 解析
  - 再失败才退回 STEP 文本解析 + bbox 代理几何

## 主要文件

```text
.
├─ app.js
├─ mesh-viewer.js
├─ occt-sidecar.js
├─ step-parser.js
├─ project-service.js
├─ main.js
├─ preload.js
├─ index.html
├─ src/styles.css
├─ TECHNICAL_ROUTE.md
└─ project-data/{projectId}/
```

## 运行方式

```bash
npm install
npm start
```

## 说明

- 当前 viewer 显示的已经是 OCCT 输出的真实三角网格，不再是随机 mock 盒子。
- 面级选择基于 `brep_faces` 三角面段映射。
- 距离与角度测量已经切到真实网格拾取点 / 面法向。
- 如果后续要继续提升到“精确 BRep 几何测量”和“解析级剖切结果”，建议继续接原生 C++ OCCT sidecar。
