"""Baseline-vs-MCP evaluation harness for VLM assembly analysis."""

from __future__ import annotations

import argparse
import base64
import json
import time
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from mcp_http_client import MCPStreamableHTTPClient, MCPClientError
from openai_vision_client import OpenAICompatibleVisionClient


FINAL_OUTPUT_SCHEMA_CN = """
你正在评测一个面向 CAD 装配分析的视觉语言模型。

请严格只返回 JSON，对应如下结构：
{
  "project_id": "字符串",
  "relation_hypotheses": [
    {
      "part_a": "字符串",
      "part_b": "字符串",
      "confidence": 0.0,
      "reason": "字符串"
    }
  ],
  "subassemblies": [
    {
      "part_ids": ["字符串"],
      "confidence": 0.0,
      "reason": "字符串"
    }
  ],
  "base_part": {
    "part_id": "字符串或 null",
    "confidence": 0.0,
    "reason": "字符串"
  },
  "grasp_plan": [
    {
      "part_id": "字符串",
      "face_ids": ["字符串"],
      "gripper_type": "字符串",
      "confidence": 0.0,
      "reason": "字符串"
    }
  ],
  "assembly_sequence": [
    {
      "step_index": 1,
      "base_part_id": "字符串或 null",
      "moving_part_id": "字符串",
      "confidence": 0.0,
      "reason": "字符串"
    }
  ],
  "uncertainties": ["字符串"]
}
""".strip()


ROUND1_PLAN_SCHEMA_CN = """
你现在处于第 1 轮分析。请基于 MCP 提供的结构化上下文与候选列表，先做初步判断，并决定下一轮最值得查看哪个候选。

请严格只返回 JSON，对应如下结构：
{
  "candidate_id": "字符串或 null",
  "analysis_focus": ["relation", "subassembly", "base", "grasp", "sequence"],
  "preliminary_findings": {
    "relations": [
      {
        "part_a": "字符串",
        "part_b": "字符串",
        "confidence": 0.0,
        "reason": "字符串"
      }
    ],
    "subassemblies": [
      {
        "part_ids": ["字符串"],
        "confidence": 0.0,
        "reason": "字符串"
      }
    ],
    "base_part_id": "字符串或 null",
    "grasp_targets": [
      {
        "part_id": "字符串",
        "reason": "字符串"
      }
    ],
    "sequence_outline": ["字符串"]
  },
  "evidence_request": {
    "need_evidence": true,
    "why": "字符串",
    "preferred_image_categories": ["字符串"]
  }
}
""".strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", default="tests/eval_cases.sample.json", help="Path to evaluation cases JSON.")
    parser.add_argument("--output", default="tests/output", help="Directory to write evaluation artifacts.")
    parser.add_argument("--mcp-url", default="http://127.0.0.1:3765/mcp", help="HTTP MCP endpoint.")
    parser.add_argument(
        "--health-url",
        default="http://127.0.0.1:3765/health",
        help="Health endpoint used before evaluation starts.",
    )
    parser.add_argument("--skip-vlm", action="store_true", help="Collect MCP artifacts only, do not call a VLM.")
    parser.add_argument("--timeout", type=int, default=180, help="HTTP timeout in seconds.")
    return parser.parse_args()


def wait_for_health(url: str, timeout: int) -> Dict[str, Any]:
    started = time.time()
    while time.time() - started < timeout:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception:
            time.sleep(1)
    raise RuntimeError(f"MCP health endpoint was not ready within {timeout} seconds: {url}")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def load_cases(path: Path) -> List[Dict[str, Any]]:
    return json.loads(path.read_text(encoding="utf-8"))


def slugify(value: str) -> str:
    return "".join(character if character.isalnum() or character in "-_" else "_" for character in value).strip("_")


def save_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_trace(trace: Dict[str, Any], *, event_type: str, name: str, payload: Dict[str, Any]) -> None:
    trace.setdefault("events", []).append(
        {
            "index": len(trace.get("events", [])) + 1,
            "timestamp": int(time.time()),
            "type": event_type,
            "name": name,
            "payload": payload,
        },
    )


def summarize_model_context(model_context: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "projectId": model_context.get("projectId"),
        "projectName": model_context.get("projectName"),
        "assembly": model_context.get("assembly"),
        "parts": [
            {
                "partId": part.get("partId"),
                "name": part.get("name"),
                "tags": part.get("tags"),
                "faceCount": part.get("faceCount"),
            }
            for part in model_context.get("parts", [])[:12]
        ],
    }


def summarize_candidates(candidates: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "relationCandidates": candidates.get("relationCandidates", [])[:8],
        "baseCandidates": candidates.get("baseCandidates", [])[:5],
        "subassemblyCandidates": candidates.get("subassemblyCandidates", [])[:5],
        "graspCandidates": candidates.get("graspCandidates", [])[:8],
    }


def summarize_bundle(bundle: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "target": bundle.get("target", {}),
        "images": {
            key: [
                {
                    "name": item.get("name"),
                    "label": item.get("label"),
                    "preset": item.get("preset"),
                    "resourceUri": item.get("resourceUri"),
                }
                for item in value
            ]
            for key, value in (bundle.get("images") or {}).items()
        },
        "colorMaps": bundle.get("colorMaps", {}),
        "metadata": bundle.get("metadata", {}),
    }


def choose_candidate_id(candidates: Dict[str, Any], explicit_id: Optional[str]) -> Optional[str]:
    if explicit_id:
        return explicit_id
    return (
        ((candidates.get("relationCandidates") or [{}])[0]).get("candidateId")
        or ((candidates.get("graspCandidates") or [{}])[0]).get("candidateId")
        or ((candidates.get("baseCandidates") or [{}])[0]).get("candidateId")
        or ((candidates.get("subassemblyCandidates") or [{}])[0]).get("candidateId")
    )


def save_mcp_resource_images(
    client: MCPStreamableHTTPClient,
    bundle: Dict[str, Any],
    output_dir: Path,
    trace: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    saved = []
    for category, entries in (bundle.get("images") or {}).items():
        for index, entry in enumerate(entries or [], start=1):
            resource_uri = entry.get("resourceUri")
            if not resource_uri:
                continue
            resource = client.read_resource(resource_uri)
            if trace is not None:
                append_trace(
                    trace,
                    event_type="mcp_resource_read",
                    name="resources/read",
                    payload={
                        "uri": resource_uri,
                        "category": category,
                    },
                )
            content = ((resource.get("contents") or [{}])[0]) or {}
            blob = content.get("blob")
            mime_type = content.get("mimeType") or entry.get("mimeType") or "image/png"
            if not blob:
                continue
            extension = "jpg" if mime_type == "image/jpeg" else "png"
            filename = f"{category}_{index:02d}_{slugify(entry.get('name') or 'image')}.{extension}"
            file_path = output_dir / filename
            file_path.write_bytes(base64.b64decode(blob))
            saved.append(
                {
                    "category": category,
                    "name": entry.get("name"),
                    "path": file_path,
                    "resource_uri": resource_uri,
                    "mime_type": mime_type,
                },
            )
    return saved


def select_images(saved_images: Iterable[Dict[str, Any]], categories: Iterable[str]) -> List[Path]:
    wanted = set(categories)
    return [item["path"] for item in saved_images if item["category"] in wanted]


def build_baseline_prompt(case: Dict[str, Any], model_context: Dict[str, Any]) -> str:
    context_excerpt = summarize_model_context(model_context)
    return (
        "请仅根据提供的美观渲染图进行装配分析，不要假设你能访问隐藏的 CAD 内部细节。\n"
        f"案例编号：{case['case_id']}\n"
        f"项目编号：{model_context['projectId']}\n"
        f"结构化摘要：\n{json.dumps(context_excerpt, ensure_ascii=False, indent=2)}\n"
        "请给出你对装配关系、子装配、基座、夹持方案和装配顺序的最佳判断。"
    )


def build_round1_prompt(case: Dict[str, Any], model_context: Dict[str, Any], candidates: Dict[str, Any]) -> str:
    context_excerpt = summarize_model_context(model_context)
    candidate_excerpt = summarize_candidates(candidates)
    return (
        "你正在进行第 1 轮分析。当前还没有局部证据图，请先阅读 MCP 提供的结构化上下文和候选列表，"
        "做出初步判断，并决定下一轮最值得查看哪个候选。\n"
        f"案例编号：{case['case_id']}\n"
        f"结构化上下文：\n{json.dumps(context_excerpt, ensure_ascii=False, indent=2)}\n"
        f"候选列表：\n{json.dumps(candidate_excerpt, ensure_ascii=False, indent=2)}"
    )


def build_augmented_prompt(
    case: Dict[str, Any],
    model_context: Dict[str, Any],
    candidates: Dict[str, Any],
    bundle: Dict[str, Any],
    round1_result: Dict[str, Any],
) -> str:
    return (
        "你正在进行第 2 轮分析。现在除了结构化上下文和候选列表外，还提供了针对候选局部抓取的 MCP 证据包。\n"
        f"案例编号：{case['case_id']}\n"
        f"第 1 轮初判：\n{json.dumps(round1_result, ensure_ascii=False, indent=2)}\n"
        f"模型上下文摘要：\n{json.dumps(summarize_model_context(model_context), ensure_ascii=False, indent=2)}\n"
        f"候选摘要：\n{json.dumps(summarize_candidates(candidates), ensure_ascii=False, indent=2)}\n"
        f"证据包摘要：\n{json.dumps(summarize_bundle(bundle), ensure_ascii=False, indent=2)}\n"
        "请综合图片、palette mask、raw mask、局部 overlay 与结构化上下文，给出最终判断。"
    )



def summarize_token_usage(*results: Dict[str, Any]) -> Dict[str, Any]:
    summary = {
        "rounds": {},
        "totals": {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "reasoning_tokens": 0,
            "cached_tokens": 0,
        },
    }

    for result in results:
        if not result:
            continue
        round_name = result.get("round_name") or result.get("name") or "unknown_round"
        usage = result.get("usage") or {}
        summary["rounds"][round_name] = usage
        for key in ["input_tokens", "output_tokens", "total_tokens", "reasoning_tokens", "cached_tokens"]:
            value = usage.get(key)
            if isinstance(value, int):
                summary["totals"][key] += value

    return summary
def score_output(result: Dict[str, Any], expected: Dict[str, Any]) -> Dict[str, Any]:
    scores: Dict[str, Any] = {}

    if expected.get("base_part_id"):
        predicted_base = (((result.get("base_part") or {})).get("part_id"))
        scores["base_part_match"] = predicted_base == expected["base_part_id"]

    if expected.get("relation_pairs"):
        expected_pairs = {tuple(sorted(pair)) for pair in expected["relation_pairs"]}
        predicted_pairs = {
            tuple(sorted((item.get("part_a"), item.get("part_b"))))
            for item in result.get("relation_hypotheses", [])
            if item.get("part_a") and item.get("part_b")
        }
        overlap = expected_pairs & predicted_pairs
        precision = len(overlap) / len(predicted_pairs) if predicted_pairs else 0.0
        recall = len(overlap) / len(expected_pairs) if expected_pairs else 0.0
        scores["relation_precision"] = round(precision, 4)
        scores["relation_recall"] = round(recall, 4)

    if expected.get("subassemblies"):
        expected_sets = {tuple(sorted(item)) for item in expected["subassemblies"]}
        predicted_sets = {
            tuple(sorted(item.get("part_ids") or []))
            for item in result.get("subassemblies", [])
            if item.get("part_ids")
        }
        scores["subassembly_exact_match_count"] = len(expected_sets & predicted_sets)

    if expected.get("sequence_part_order"):
        predicted_order = [item.get("moving_part_id") for item in result.get("assembly_sequence", []) if item.get("moving_part_id")]
        expected_order = expected["sequence_part_order"]
        prefix_matches = 0
        for expected_part, predicted_part in zip(expected_order, predicted_order):
            if expected_part == predicted_part:
                prefix_matches += 1
        scores["sequence_prefix_match_count"] = prefix_matches

    return scores


def call_mcp_tool(
    client: MCPStreamableHTTPClient,
    trace: Dict[str, Any],
    tool_name: str,
    arguments: Dict[str, Any],
) -> Dict[str, Any]:
    append_trace(
        trace,
        event_type="mcp_call",
        name=tool_name,
        payload={
            "arguments": arguments,
        },
    )
    result = client.call_tool(tool_name, arguments)
    append_trace(
        trace,
        event_type="mcp_result",
        name=tool_name,
        payload={
            "structuredContent": result.get("structuredContent"),
            "content": result.get("content"),
        },
    )
    result["round_name"] = round_name
    return result.get("structuredContent") or {}


def call_vlm_round(
    vlm: OpenAICompatibleVisionClient,
    trace: Dict[str, Any],
    *,
    round_name: str,
    system_prompt: str,
    user_prompt: str,
    image_paths: Iterable[Path],
) -> Dict[str, Any]:
    image_list = [str(path) for path in image_paths]
    append_trace(
        trace,
        event_type="vlm_call",
        name=round_name,
        payload={
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "image_paths": image_list,
        },
    )
    result = vlm.create_json_completion(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        image_paths=[Path(path) for path in image_list],
    )
    append_trace(
        trace,
        event_type="vlm_result",
        name=round_name,
        payload={
            "text": result.get("text"),
            "parsed": result.get("parsed"),
        },
    )
    result["round_name"] = round_name
    return result


def match_relation_candidate_id(candidates: Dict[str, Any], part_a: Optional[str], part_b: Optional[str]) -> Optional[str]:
    if not part_a or not part_b:
        return None
    target = {part_a, part_b}
    for candidate in candidates.get("relationCandidates", []):
        if {candidate.get("partAId"), candidate.get("partBId")} == target:
            return candidate.get("candidateId")
    return None


def main() -> None:
    args = parse_args()
    cases_path = Path(args.cases)
    output_root = Path(args.output)
    ensure_dir(output_root)

    health = wait_for_health(args.health_url, args.timeout)
    print("MCP health:", health)

    client = MCPStreamableHTTPClient(args.mcp_url, timeout=args.timeout)
    init_result = client.initialize()
    print("Initialized MCP session with server:", init_result.get("serverInfo"))

    vlm = None
    if not args.skip_vlm:
        vlm = OpenAICompatibleVisionClient(timeout=args.timeout)

    for case in load_cases(cases_path):
        case_id = case["case_id"]
        case_output = output_root / f"{slugify(case_id)}-{int(time.time())}"
        ensure_dir(case_output)

        print(f"[case] {case_id}")
        project_id = case["project_id"]
        trace: Dict[str, Any] = {
            "case_id": case_id,
            "project_id": project_id,
            "health": health,
            "mcp_initialize": init_result,
            "events": [],
        }

        model_context = call_mcp_tool(
            client,
            trace,
            "assembly.get_model_context",
            {
                "projectId": project_id,
                **(case.get("tool_arguments", {}).get("model_context", {})),
            },
        )
        candidates = call_mcp_tool(
            client,
            trace,
            "assembly.get_relation_candidates",
            {
                "projectId": project_id,
                **(case.get("tool_arguments", {}).get("relation_candidates", {})),
            },
        )

        if not model_context or not candidates:
            raise MCPClientError(f"Missing structured content for case {case_id}")

        save_json(case_output / "model_context.json", model_context)
        save_json(case_output / "relation_candidates.json", candidates)

        candidate_id = choose_candidate_id(candidates, case.get("candidate_id"))

        if args.skip_vlm:
            evidence_bundle = call_mcp_tool(
                client,
                trace,
                "assembly.capture_evidence_bundle",
                {
                    "projectId": project_id,
                    "candidateId": candidate_id,
                    **(case.get("tool_arguments", {}).get("evidence_bundle", {})),
                },
            )
            save_json(case_output / "evidence_bundle.json", evidence_bundle)
            save_mcp_resource_images(client, evidence_bundle, case_output, trace=trace)
            save_json(case_output / "interaction_trace.json", trace)
            continue

        round1 = call_vlm_round(
            vlm,
            trace,
            round_name="mcp_round1_plan",
            system_prompt=ROUND1_PLAN_SCHEMA_CN,
            user_prompt=build_round1_prompt(case, model_context, candidates),
            image_paths=[],
        )
        save_json(case_output / "mcp_round1_plan.json", round1)

        chosen_candidate_id = round1.get("parsed", {}).get("candidate_id") or candidate_id
        evidence_bundle = call_mcp_tool(
            client,
            trace,
            "assembly.capture_evidence_bundle",
            {
                "projectId": project_id,
                "candidateId": chosen_candidate_id,
                **(case.get("tool_arguments", {}).get("evidence_bundle", {})),
            },
        )
        save_json(case_output / "evidence_bundle.json", evidence_bundle)
        saved_images = save_mcp_resource_images(client, evidence_bundle, case_output, trace=trace)

        baseline_images = select_images(saved_images, ["globalBeautyViews"])
        augmented_images = select_images(
            saved_images,
            [
                "globalBeautyViews",
                "globalPartMaskViews",
                "localOverlayViews",
                "localFaceMaskViews",
            ],
        )

        baseline = call_vlm_round(
            vlm,
            trace,
            round_name="baseline_vlm",
            system_prompt=FINAL_OUTPUT_SCHEMA_CN,
            user_prompt=build_baseline_prompt(case, model_context),
            image_paths=baseline_images,
        )
        save_json(case_output / "baseline_vlm.json", baseline)

        augmented = call_vlm_round(
            vlm,
            trace,
            round_name="mcp_augmented_vlm",
            system_prompt=FINAL_OUTPUT_SCHEMA_CN,
            user_prompt=build_augmented_prompt(case, model_context, candidates, evidence_bundle, round1.get("parsed", {})),
            image_paths=augmented_images,
        )
        save_json(case_output / "mcp_augmented_vlm.json", augmented)

        relation_hypotheses = augmented.get("parsed", {}).get("relation_hypotheses", [])
        top_relation = relation_hypotheses[0] if relation_hypotheses else {}
        validation_candidate_id = match_relation_candidate_id(
            candidates,
            top_relation.get("part_a"),
            top_relation.get("part_b"),
        )
        if validation_candidate_id:
            validation = call_mcp_tool(
                client,
                trace,
                "assembly.validate_hypothesis",
                {
                    "projectId": project_id,
                    "hypothesis": {
                        "type": "relation",
                        "relationCandidateId": validation_candidate_id,
                        "partAId": top_relation.get("part_a"),
                        "partBId": top_relation.get("part_b"),
                    },
                },
            )
            save_json(case_output / "validation.json", validation)

        token_usage_summary = summarize_token_usage(baseline, round1, augmented)
        save_json(case_output / "token_usage_summary.json", token_usage_summary)

        if case.get("expected"):
            comparison = {
                "baseline": score_output(baseline["parsed"], case["expected"]),
                "mcp_augmented": score_output(augmented["parsed"], case["expected"]),
                "token_usage": token_usage_summary,
            }
            save_json(case_output / "score_summary.json", comparison)

        save_json(case_output / "interaction_trace.json", trace)


if __name__ == "__main__":
    main()


