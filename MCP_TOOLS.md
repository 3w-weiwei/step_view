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
- `cad_analyze_removal_directions`

View state and visual evidence:

- `cad_set_color_mode`
- `cad_set_transparency`
- `cad_highlight_faces`
- `cad_set_exploded_view`
- `cad_render_multiview`

## Important Limits

Contact and removal tools are intentionally conservative heuristics. They return candidates, blockers, confidence, and method metadata. They do not replace exact CAD-kernel contact solving, motion planning, fastener recognition, or mechanical engineering judgement.

`cad_set_transparency`, `cad_highlight_faces`, and `cad_set_exploded_view` maintain MCP view state and now sync that state into the live Electron viewer when it is running. `cad_render_multiview` reloads the same state before capture so screenshots include transparency, highlighted faces, and exploded transforms.

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
