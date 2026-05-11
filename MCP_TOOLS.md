# STEP CAD MCP Tools

This project exposes a stdio MCP server for assembly-oriented STEP CAD analysis.

Run it with:

```bash
npm run mcp
```

For image capture tools, start the Electron viewer separately:

```bash
npm start
```

The server reads cached projects from `project-data` by default. Override with:

```bash
set STEP_CAD_PROJECT_ROOT=D:\path\to\project-data
npm run mcp
```

## Tool Groups

Data and geometry facts:

- `cad_get_model_summary`
- `cad_get_assembly_tree`
- `cad_get_parts`
- `cad_get_part_faces`
- `cad_get_face_detail`
- `cad_get_contact_candidates`
- `cad_get_contact_pairs`
- `cad_find_clearance_directions`
- `cad_analyze_removal_directions`

View state and visual evidence:

- `cad_set_color_mode`
- `cad_reset_view_state`
- `cad_set_transparency`
- `cad_highlight_faces`
- `cad_set_exploded_view`
- `cad_render_view`
- `cad_render_section_view`
- `cad_render_target_section`
- `cad_render_part_multiview`
- `cad_render_contact_pair_multiview`
- `cad_render_move_preview`
- `cad_render_disassembly_exploded_view`
- `cad_render_multiview`
- `cad_collect_visual_evidence`

## Important Limits

Contact and removal tools are intentionally conservative heuristics. They return candidates, blockers, confidence, and method metadata. They do not replace exact CAD-kernel contact solving, motion planning, fastener recognition, or mechanical engineering judgement.

Visual evidence tools return image content directly when the Electron viewer is running. `cad_set_transparency` and `cad_set_exploded_view` apply the state and return a screenshot by default. `cad_render_view`, `cad_render_section_view`, and `cad_render_multiview` reload the same state before capture so screenshots include transparency, highlighted faces, exploded transforms, and section clipping.

For robust evidence, prefer `cad_collect_visual_evidence` over a single render call. It captures serial views, can sweep section offsets, and frames exploded layouts against the transformed assembly bounds so the exploded model is less likely to be cropped. To reduce MCP context usage, screenshots default to reduced image sizes; pass `image_max_size` only when a sharper render is needed.

For contact analysis, avoid pulling the full `cad_get_contact_pairs` payload unless needed. Use `cad_get_contact_pairs` with `compact: true` first, then render a specific pair with `cad_render_contact_pair_multiview`. The render isolates the two connected parts, highlights candidate contact faces in red, and returns 8 views.

Use `cad_reset_view_state` to restore normal view state: it clears transparency, highlighted faces, exploded view, per-part movement, and section clipping.

Most visual tools choose a human-friendly default view when `view` is omitted. For target faces, the camera is biased toward the face normal with a slight oblique angle. For parts, the camera is biased outward from the model center. For section views, `cad_render_target_section` chooses the section axis and offset from the target face or contact pair.

Agents can use fixed views with `view.preset`:

```json
{
  "view": { "preset": "front" }
}
```

Or choose their own camera:

```json
{
  "view": { "azimuth": 35, "elevation": 18, "distance": 240 }
}
```

Target section:

```json
{
  "face_id": "mesh-0:face-0"
}
```

Move preview:

```json
{
  "part_id": "node-2",
  "direction": [1, 0, 0],
  "distance": 40,
  "fade_context_level": 0.55
}
```

Contact pair visual evidence:

```json
{
  "pair_id": "node-2::node-4",
  "max_face_pairs": 4,
  "size": 256
}
```

Disassembly-style exploded view:

```json
{
  "factor": 1.2
}
```

Robust visual evidence:

```json
{
  "mode": "section_sweep",
  "part_ids": ["node-3", "node-7"],
  "section_axis": "x",
  "transparency_level": 0.55,
  "image_max_size": 480
}
```

Exploded evidence with recomputed framing:

```json
{
  "mode": "exploded",
  "exploded_factor": 1.2
}
```

## MCP Inspector

You can test the stdio server with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector npm run mcp
```

If the Inspector UI asks for command fields instead of accepting the one-line command, use:

- Command: `npm`
- Arguments: `run mcp`
- Working directory: this project directory

To test image-producing tools, start the Electron viewer in another terminal first:

```bash
npm start
```

Then call tools in this order:

1. `cad_get_model_summary`
2. `cad_get_parts`
3. `cad_get_part_faces` with a returned `part_id`
4. `cad_set_transparency`
5. `cad_highlight_faces`
6. `cad_set_exploded_view`
7. `cad_render_multiview`
8. `cad_collect_visual_evidence`

The Inspector documentation command could not be re-fetched in this session due to command approval rejection, so the Inspector command above is the standard MCP Inspector invocation pattern rather than a freshly verified doc quote.

## Build Dataset

Start the Electron viewer first:

```bash
npm start
```

Then run:

```bash
npm run build:contact-dataset -- 7a3178cd-a0fe-400a-b782-4718448ae92f
```

The script writes a dataset under:

```text
project-data/<project_id>/datasets/<timestamp>/
```

Outputs include:

- `manifest.json`
- `parts.json`
- `contact_pairs.json`
- `parts/parts.json` plus 8-view images for each part
- `contact_pairs/contact_pairs.json` plus 8-view images for each contact pair, with only candidate contact faces highlighted red

Options:

```bash
node build-contact-dataset.js <project_id> --out D:\tmp\cad-dataset --size 256 --max-pairs 200 --max-face-pairs 8
```
