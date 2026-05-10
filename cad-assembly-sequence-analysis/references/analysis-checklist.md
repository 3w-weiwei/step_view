# Assembly Sequence Analysis Checklist

Use this checklist for complex assemblies or low-confidence cases.

## Evidence checklist

- Model summary loaded and part count known.
- Assembly tree inspected for hierarchy and repeated components.
- Parts list inspected for names, IDs, visibility, bounding boxes, and likely roles.
- Contact pairs collected, with candidates checked when exact contacts look incomplete.
- Critical mating faces inspected with face details or highlighted render.
- Removal directions analyzed for each non-base part or subassembly.
- Clearance directions checked for blocked or ambiguous parts.
- Move previews rendered for at least the most consequential extraction directions.
- Section views rendered for hidden interfaces, nested parts, or enclosure contacts.
- Every cited visual render has `has_image: true` or a non-empty `image_path`.
- If the LangChain client only exposes text JSON, use returned `image_path` files as the visual evidence artifacts.
- Visual tools were called serially, not in parallel.
- Viewer state was reset or explicitly rebuilt before each independent visual investigation.
- Each visual capture records the intended state: color mode, transparency, highlights, section, exploded/move transform, selected parts, and camera/view preset.

## Mechanical heuristics

- Treat a large grounded body, frame, base plate, housing half, or enclosure as the likely assembly base only after checking contacts and containment.
- Prefer installing internal parts before covers, caps, housing closures, retaining plates, or parts that block later access.
- Prefer completing independent internal modules as subassemblies before installing them into the main housing when the module has dense internal contacts and a feasible insertion/removal direction.
- Prefer installing locating features, seats, rails, bearings, bushings, spacers, and supports before parts that depend on them.
- Prefer installing adjustment, retention, and closure parts after the constrained parts are seated, unless they are required as fixtures during insertion.
- Prefer installing shafts, pins, and dowels along their axial clearance direction when faces and bounding boxes support that inference.
- Prefer grouping repeated screws, pins, washers, or symmetric parts into one step only when they have equivalent contacts and access.
- Treat dense internal contacts with few external contacts as evidence for a subassembly.
- Treat contacts with low confidence or candidate-only status as weak evidence.
- Treat no-collision removal directions as strong evidence for possible disassembly, but not proof of real-world manufacturability.
- Reject a sequence that is only geometrically reversed from disassembly if it creates an obvious process problem: trapped internal part, blocked insertion path, inaccessible fastener-like part, or need to pass a large part through a closed enclosure.

## Precedence graph rules

- If part A blocks removal of part B, then B usually must be installed before A in assembly.
- If part B is enclosed by part A and no valid removal path exists while A is present, then B must be installed before A closes the enclosure.
- If a fastener-like part contacts both A and B and is externally accessible, install A/B first, then the fastener-like part.
- If a shaft-like part passes through multiple components, install supported components before or during shaft insertion according to the validated clearance direction.
- If two parts only contact the same base and not each other, their relative order is probably unconstrained unless access or blockers say otherwise.
- If a cluster of parts has many mutual contacts and one or two external interfaces, treat it as a candidate subassembly and verify its insertion into the parent assembly.
- If a cover, cap, housing half, plate, or retaining ring blocks visual or geometric access to internal contacts, schedule it after the internal components it encloses.

## Confidence labels

- High: supported by contact evidence, removal/clearance evidence, and visual confirmation.
- Medium: supported by two evidence types, or one strong tool result plus mechanically plausible geometry.
- Low: supported mainly by naming, weak contact candidates, incomplete visual evidence, or unresolved blockers.
- Do not assign High confidence to a step that lacks visual evidence when the interface is hidden, enclosed, or ambiguous.

## Required caveats

State these caveats when relevant:

- Contact/removal tools are conservative heuristics.
- The STEP model may not encode intended fastener operations, tolerances, deformation, welding, adhesive, or assembly tooling.
- A geometric sequence may require human engineering review before manufacturing use.
- Visual evidence is only valid when image content is present or a saved image path is available.
- Visual evidence may be contaminated by previous viewer state if the agent did not reset or explicitly rebuild the state before capture.
