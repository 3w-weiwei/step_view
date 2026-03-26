"""Minimal Streamable HTTP MCP client implemented with Python stdlib only."""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional


DEFAULT_PROTOCOL_VERSION = "2025-03-26"


class MCPClientError(RuntimeError):
    """Raised when the MCP server returns an error or malformed response."""


@dataclass
class MCPHTTPResponse:
    body: Dict[str, Any]
    headers: Dict[str, str]


class MCPStreamableHTTPClient:
    """Very small MCP Streamable HTTP client.

    This client intentionally supports only the pieces needed for evaluation:
    - initialize
    - tools/list
    - tools/call
    - resources/read
    """

    def __init__(
        self,
        endpoint: str,
        *,
        protocol_version: str = DEFAULT_PROTOCOL_VERSION,
        timeout: int = 180,
        verify_ssl: bool = True,
    ) -> None:
        self.endpoint = endpoint
        self.protocol_version = protocol_version
        self.timeout = timeout
        self.session_id: Optional[str] = None
        self._next_id = 1
        self._ssl_context = None if verify_ssl else ssl._create_unverified_context()  # noqa: SLF001

    def initialize(
        self,
        *,
        client_name: str = "vlm-mcp-eval",
        client_version: str = "0.1.0",
    ) -> Dict[str, Any]:
        result = self.request(
            "initialize",
            {
                "protocolVersion": self.protocol_version,
                "capabilities": {},
                "clientInfo": {
                    "name": client_name,
                    "version": client_version,
                },
            },
        )
        self.notify("notifications/initialized", {})
        negotiated = result.get("protocolVersion")
        if isinstance(negotiated, str):
            self.protocol_version = negotiated
        return result

    def list_tools(self) -> Dict[str, Any]:
        return self.request("tools/list", {})

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self.request(
            "tools/call",
            {
                "name": name,
                "arguments": arguments or {},
            },
        )

    def read_resource(self, uri: str) -> Dict[str, Any]:
        return self.request(
            "resources/read",
            {
                "uri": uri,
            },
        )

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        message = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params or {},
        }
        self._post(message)

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        request_id = self._consume_id()
        message = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or {},
        }
        response = self._post(message)
        body = response.body

        if "error" in body:
            error = body["error"]
            raise MCPClientError(
                f"MCP request failed for {method}: code={error.get('code')} message={error.get('message')}",
            )

        if "result" not in body:
            raise MCPClientError(f"MCP request returned no result for {method}: {body!r}")

        return body["result"]

    def _consume_id(self) -> int:
        current = self._next_id
        self._next_id += 1
        return current

    def _post(self, payload: Dict[str, Any]) -> MCPHTTPResponse:
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "mcp-protocol-version": self.protocol_version,
        }
        if self.session_id:
            headers["mcp-session-id"] = self.session_id

        request = urllib.request.Request(
            self.endpoint,
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout, context=self._ssl_context) as response:
                response_text = response.read().decode("utf-8")
                if response.headers.get("mcp-session-id"):
                    self.session_id = response.headers["mcp-session-id"]
                parsed = self._parse_response_body(response_text)
                return MCPHTTPResponse(body=parsed, headers=dict(response.headers.items()))
        except urllib.error.HTTPError as exc:
            payload_text = exc.read().decode("utf-8", errors="replace")
            raise MCPClientError(
                f"HTTP {exc.code} while calling MCP: {payload_text}",
            ) from exc
        except urllib.error.URLError as exc:
            raise MCPClientError(f"Failed to reach MCP endpoint {self.endpoint}: {exc}") from exc

    @staticmethod
    def _parse_response_body(raw_text: str) -> Dict[str, Any]:
        text = raw_text.strip()
        if not text:
            return {}

        if text.startswith("{"):
            return json.loads(text)

        parsed_messages = []
        for event_block in text.split("\n\n"):
            event_block = event_block.strip()
            if not event_block:
                continue

            data_lines = []
            for line in event_block.splitlines():
                if line.startswith("data:"):
                    data_lines.append(line[len("data:") :].strip())

            if not data_lines:
                continue

            payload_text = "\n".join(data_lines)
            try:
                parsed_messages.append(json.loads(payload_text))
            except json.JSONDecodeError as exc:
                raise MCPClientError(
                    f"Could not decode SSE data payload as JSON: {payload_text!r}",
                ) from exc

        if parsed_messages:
            return parsed_messages[-1]

        raise MCPClientError(f"Unsupported MCP response body: {raw_text!r}")

