"""OpenAI-compatible chat-completions client using Python stdlib only."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


class VisionClientError(RuntimeError):
    """Raised when the upstream VLM endpoint fails."""


class OpenAICompatibleVisionClient:
    """Small OpenAI-compatible VLM client.

    It targets the `/chat/completions` endpoint so it works with:
    - OpenAI-compatible gateways
    - many hosted OpenAI-like APIs
    - local compatible proxies
    """

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        timeout: int = 240,
    ) -> None:
        self.api_key = api_key or os.getenv("OPENAI_API_KEY") or "sk-3af0625d1a754b429a3855372f21db16"
        self.base_url = (base_url or os.getenv("OPENAI_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1").rstrip("/")
        self.model = model or os.getenv("OPENAI_MODEL") or "qwen3-vl-plus"
        self.timeout = timeout

        if not self.api_key:
            raise VisionClientError("OPENAI_API_KEY is not set.")
        if not self.model:
            raise VisionClientError("OPENAI_MODEL is not set.")

    def create_json_completion(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        image_paths: Optional[Iterable[Path]] = None,
        temperature: float = 0.2,
    ) -> Dict[str, Any]:
        messages = [
            {"role": "system", "content": system_prompt},
            self.build_user_message(text=user_prompt, image_paths=image_paths),
        ]
        return self.create_json_completion_from_messages(messages=messages, temperature=temperature)

    def create_json_completion_from_messages(
        self,
        *,
        messages: List[Dict[str, Any]],
        temperature: float = 0.2,
    ) -> Dict[str, Any]:
        payload = {
            "model": self.model,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
            "messages": messages,
        }

        endpoint = f"{self.base_url}/chat/completions"
        raw = self._post_json(endpoint, payload)
        message = (((raw.get("choices") or [{}])[0]).get("message") or {})
        text = message.get("content")
        if isinstance(text, list):
            text = "\n".join(
                item.get("text", "")
                for item in text
                if isinstance(item, dict) and item.get("type") == "text"
            )
        if not isinstance(text, str):
            raise VisionClientError(f"Unexpected VLM response payload: {raw!r}")

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            raise VisionClientError(f"Model did not return valid JSON: {text}") from exc

        return {
            "raw_response": raw,
            "text": text,
            "parsed": parsed,
            "messages": messages,
            "usage": self._extract_usage(raw),
        }

    @staticmethod
    def build_user_message(
        *,
        text: str,
        image_paths: Optional[Iterable[Path]] = None,
    ) -> Dict[str, Any]:
        content: List[Dict[str, Any]] = [{"type": "text", "text": text}]
        for image_path in image_paths or []:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": OpenAICompatibleVisionClient._path_to_data_url(image_path),
                    },
                },
            )
        return {"role": "user", "content": content}

    def _post_json(self, endpoint: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=data,
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            payload_text = exc.read().decode("utf-8", errors="replace")
            raise VisionClientError(f"HTTP {exc.code} from VLM endpoint: {payload_text}") from exc
        except urllib.error.URLError as exc:
            raise VisionClientError(f"Failed to reach VLM endpoint: {exc}") from exc

    @staticmethod
    def _extract_usage(raw: Dict[str, Any]) -> Dict[str, Any]:
        usage = raw.get("usage") or {}
        return {
            "input_tokens": usage.get("prompt_tokens"),
            "output_tokens": usage.get("completion_tokens"),
            "total_tokens": usage.get("total_tokens"),
            "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            "raw_usage": usage,
        }

    @staticmethod
    def _path_to_data_url(path: Path) -> str:
        mime_type = mimetypes.guess_type(path.name)[0] or "image/png"
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return f"data:{mime_type};base64,{encoded}"
