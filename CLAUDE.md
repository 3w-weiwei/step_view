# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

STEP Workbench MVP is an Electron-based desktop application for importing, parsing, caching, and visualizing STEP assembly files (CAD models). It renders 3D geometry using Three.js with real triangulated mesh display powered by OCCT (Open CASCADE).

## Run Commands

```bash
npm install
npm start
```

## Architecture

### Process Model
- **Main Process** (`main.js`): Electron main process handling IPC, dialogs, file system, TCP bridge for Python integration
- **Renderer Process** (`app.js`, `mesh-viewer.js`): UI and 3D rendering via Three.js
- **Parser Layer** (`occt-sidecar.js`, `step-parser.js`): STEP file parsing with fallback chain

### Parse Pipeline (3-tier fallback)
1. **OCCT Sidecar** (`occt-sidecar.js`): Forked child process using `occt-import-js` for real triangulated mesh + assembly hierarchy
2. **OCCT Embedded** (`occt-sidecar.js` `parseStepWithOcct`): Same library loaded directly in main process
3. **STEP Text Parser** (`step-parser.js`): Pure JavaScript Part 21 text parser extracting assembly structure + bbox proxy geometry

The fallback chain is in `project-service.js:runParsePipeline()`.

### Project Cache Structure
Each project gets a directory under `project-data/{projectId}/`:
- `source.step` - cached original file
- `manifest.json` - metadata, status, stats
- `assembly.json` - full assembly tree + meshes data
- `thumbnail.svg` - preview image

### Key Data Structures
- **Assembly JSON**: `{ rootId, nodes[], meshes[], bounds, stats, meta }`
- **Node**: `{ id, parentId, kind: "part"|"assembly", name, color, bbox, faces, children[], topology }`
- **Mesh**: `{ id, nodeId, name, color, attributes: {position, normal}, index, brepFaces[], bbox }`
- **Face**: `{ id, name, meshId, triangleFirst, triangleLast, normal, area, renderColor }`

### Renderer State
Two view modes share the same viewer:
- **Workbench** (`#/workbench/{id}`): Full interactive view with assembly tree, measurement, sectioning
- **Viz** (`#/viz/{id}`): Simplified part visualization with color mode toggle and parametric camera

### TCP Bridge
Main process runs a TCP server on port 3100 to receive invoke requests from external Python bridge. Viewer API methods exposed: `getState`, `loadProject`, `getParts`, `selectParts`, `setColorMode`, `setCamera`, `captureScreenshot`, etc.

### Viewer API Methods (TCP Bridge)
- `loadProject` / `listProjects` / `getParts` - project management
- `selectParts` / `clearSelection` / `getSelectedParts` - part selection
- `setColorMode` ("face" | "part") / `getColorMapping` - coloring
- `setCamera` / `getCamera` / `setViewPreset` / `fit` - camera control
- `captureScreenshot` / `captureMultiview` - export
- `setSection` - cross-section view

## File Guide

| File | Purpose |
|------|---------|
| `main.js` | Electron main process, window creation, IPC handlers, TCP bridge |
| `preload.js` | Context bridge exposing `window.cadViewerApi` to renderer |
| `app.js` | Renderer entry, UI state management, routing, event handling |
| `mesh-viewer.js` | Three.js `WorkbenchViewer` class - 3D rendering, picking, camera |
| `project-service.js` | Project CRUD, parse job management, cache I/O |
| `occt-sidecar.js` | OCCT parsing via `occt-import-js`, hierarchy building, thumbnail SVG |
| `step-parser.js` | STEP Part 21 text parser, assembly structure extraction |
| `viewer-api.js` | TCP bridge IPC registration |
