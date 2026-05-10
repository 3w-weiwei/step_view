---
name: cad-assembly-sequence-analysis
description: Evidence-based mechanical assembly sequence analysis for STEP CAD assemblies using the local STEP CAD MCP tools. Use when Codex needs to inspect a CAD assembly, call tools such as cad_get_parts, cad_get_contact_pairs, cad_find_clearance_directions, cad_analyze_removal_directions, and visual render tools, then produce a justified assembly or disassembly order with fact references, confidence, constraints, and verification gaps.
---

# CAD Assembly Sequence Analysis

Use this skill to derive a mechanical assembly sequence from STEP CAD MCP evidence. Treat the MCP tools as fact sources and conservative heuristics, not as an exact CAD kernel, process planner, or replacement for engineering judgement.

## Required stance

- Ground every ordering claim in tool evidence: part hierarchy, contact pairs, face details, clearance/removal directions, visual sections, or move previews.
- Prefer disassembly reasoning first, then reverse it into assembly order. A part that can be removed late in disassembly usually must be installed early in assembly.
- Convert geometric feasibility into manufacturing plausibility: consider access, insertion direction, internal-before-external order, subassembly opportunities, fastening sequence, and whether later operations would be blocked.
- Report uncertainty explicitly. Do not convert heuristic confidence into fact.
- Separate geometric facts from inferred assembly logic.
- Never claim fastener recognition, mating intent, tolerance, force fit, flexible deformation, adhesive, weld, or required tooling unless directly supported by model metadata or visible geometry.
- Treat visual evidence as valid only when the render tool returns `evidence.has_image: true` or a non-empty `image_path`. If image content is not visible in the client, use `image_path` as the traceable evidence artifact.
- Treat visual MCP tools as shared-state operations. Do not call visual render/state tools in parallel. Data-only tools may be parallelized, but visual tools must be sequenced because transparency, highlights, exploded view, section clipping, camera, selected parts, and move previews share one viewer state.

## Tool workflow

1. Establish model scope:
   - Call `cad_get_model_summary`.
   - Call `cad_get_assembly_tree`.
   - Call `cad_get_parts`.
   - Identify fixed/base parts, repeated parts, large enclosure parts, shafts, plates, covers, pins, and likely fasteners from names and geometry only.

2. Build contact evidence:
   - Call `cad_get_contact_pairs` for confirmed or higher-confidence contacts.
   - Use `cad_get_contact_candidates` when contacts are sparse or the model appears to have small clearances.
   - For critical contacts, inspect `cad_get_part_faces`, `cad_get_face_detail`, and visual highlighting or section rendering.

3. Analyze removability:
   - For each candidate removable part or subassembly, call `cad_analyze_removal_directions`.
   - Use `cad_find_clearance_directions` when a candidate removal direction is unclear.
   - Prefer directions with fewer blockers, higher confidence, and mechanically plausible straight-line extraction.
   - Use `cad_render_move_preview` to visually check proposed extraction directions.

4. Validate visually:
   - Use `cad_reset_view_state` before a new visual investigation unless intentionally continuing from the previous visual state.
   - Call visual tools serially. Never issue simultaneous calls to `cad_set_transparency`, `cad_highlight_faces`, `cad_set_exploded_view`, `cad_render_view`, `cad_render_section_view`, `cad_render_target_section`, `cad_render_move_preview`, `cad_render_disassembly_exploded_view`, or `cad_render_multiview`.
   - For each visual evidence capture, explicitly define the intended state: color mode, transparent parts, highlighted faces, section, exploded/move transform, selected parts, and camera/view preset.
   - Use `cad_set_transparency`, `cad_highlight_faces`, `cad_render_target_section`, `cad_render_section_view`, `cad_render_disassembly_exploded_view`, or `cad_render_multiview` to collect visual evidence for ambiguous interfaces.
   - Use section views for hidden contacts and nested parts.
   - Check `evidence.has_image`, `evidence.image_path`, or multiview `views[].image_path`. If missing, state that visual validation failed and do not cite the render as visual proof.
   - After a move preview, exploded view, section view, or heavy highlighting, call `cad_reset_view_state` before investigating a different interface.

5. Derive sequence:
   - Construct a precedence graph: blockers and enclosing parts precede blocked or enclosed parts in assembly.
   - Group parts into subassemblies when contacts are dense internally and external interfaces are limited.
   - Apply process logic: install internal/nested parts before covers and external closures; install locating/support parts before dependent parts; install fastener-like parts after the parts they secure; keep access for later tools or insertion paths.
   - Prefer subassembly-first plans when a cluster can be assembled independently and then inserted into the main assembly without violating clearance evidence.
   - Reverse a defensible disassembly order into an assembly sequence.
   - Insert inspection or verification notes where the tool evidence is heuristic or incomplete.

6. Produce a result:
   - Output assembly steps in order.
   - For each step, include part IDs/names, action, direction/orientation when known, evidence, blockers resolved, confidence, and assumptions.
   - Include a separate "Fact Basis" section listing the exact MCP tool results used.
   - Include "Open Risks / Needs Human Review" for ambiguous contacts, inaccessible paths, missing fastener intent, or tool confidence limits.

## Reasoning pattern

Use this pattern internally:

```text
What is the stable base?
What parts are externally accessible?
Which contacts constrain each part?
Which parts block straight-line removal of others?
Can the model be decomposed into subassemblies?
What disassembly order is supported by clearance/removal evidence?
What assembly order is the reverse, with practical grouping?
Which parts should become subassemblies before joining the main product?
Does each step preserve access for later insertions, fasteners, covers, and adjustments?
Which visual render or image path verifies the most important interfaces?
Where does the evidence stop and inference begin?
```

## Output format

Use this compact structure unless the user asks for a different format:

```markdown
**Assembly Sequence**
| Step | Part / Subassembly | Operation | Evidence | Confidence |
|---:|---|---|---|---|
| 1 | ... | ... | ... | High/Medium/Low |

**Subassembly Strategy**
- ...

**Fact Basis**
- `cad_get_model_summary`: ...
- `cad_get_contact_pairs`: ...
- `cad_analyze_removal_directions`: ...
- Visual evidence: `image_path` / `views[].image_path` / `has_image`: ...
- Visual state hygiene: reset/state setup used before each cited render.

**Reasoning Notes**
- Base/reference part: ...
- Main precedence constraints: ...
- Subassemblies: ...
- Process constraints: ...

**Open Risks / Human Review**
- ...
```

## Use references when needed

Read `references/analysis-checklist.md` when the task is complex, the sequence has many parts, or the first pass has low confidence.
