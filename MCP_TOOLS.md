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
- `cad_render_move_preview`
- `cad_render_disassembly_exploded_view`
- `cad_render_multiview`

## Important Limits

Contact and removal tools are intentionally conservative heuristics. They return candidates, blockers, confidence, and method metadata. They do not replace exact CAD-kernel contact solving, motion planning, fastener recognition, or mechanical engineering judgement.

Visual evidence tools return image content directly when the Electron viewer is running. `cad_set_transparency` and `cad_set_exploded_view` apply the state and return a screenshot by default. `cad_render_view`, `cad_render_section_view`, and `cad_render_multiview` reload the same state before capture so screenshots include transparency, highlighted faces, exploded transforms, and section clipping.

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

Disassembly-style exploded view:

```json
{
  "factor": 1.2
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

The Inspector documentation command could not be re-fetched in this session due to command approval rejection, so the Inspector command above is the standard MCP Inspector invocation pattern rather than a freshly verified doc quote.
