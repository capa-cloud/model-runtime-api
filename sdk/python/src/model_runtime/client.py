from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen


class RuntimeHTTPError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"model runtime returned status {status}")
        self.status = status


class ModelRuntimeClient:
    def __init__(self, base_url: str, timeout: float = 30.0) -> None:
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.fragment
            or parsed.query
        ):
            raise ValueError("base_url must be HTTP or HTTPS without credentials or fragments")
        self.base_url = parsed.geturl().rstrip("/")
        self.timeout = timeout

    def submit(
        self,
        request: dict[str, Any],
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return self._json("POST", "/v1/executions", request, headers)

    def get(self, execution_id: str) -> dict[str, Any]:
        return self._json("GET", f"/v1/executions/{quote(execution_id, safe='')}")

    def result(self, execution_id: str) -> dict[str, Any]:
        return self._json("GET", f"/v1/executions/{quote(execution_id, safe='')}/result")

    def cancel(self, execution_id: str) -> dict[str, Any]:
        return self._json("POST", f"/v1/executions/{quote(execution_id, safe='')}/cancel")

    def events(self, execution_id: str, after: int = 0) -> Iterator[dict[str, Any]]:
        if type(after) is not int or after < 0:
            raise ValueError("event cursor must be a non-negative integer")
        query = urlencode({"after": after})
        request = Request(
            f"{self.base_url}/v1/executions/{quote(execution_id, safe='')}/events?{query}",
            headers={"Accept": "text/event-stream"},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                data: list[str] = []
                frame_bytes = 0
                last_type = None
                while True:
                    raw = response.readline(1024 * 1024 + 1)
                    if not raw:
                        break
                    frame_bytes += len(raw)
                    if frame_bytes > 1024 * 1024:
                        raise RuntimeError("model runtime SSE frame exceeds 1 MiB")
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if not line:
                        if data:
                            event = json.loads("\n".join(data))
                            last_type = event.get("type")
                            yield event
                            data.clear()
                        frame_bytes = 0
                        continue
                    if line.startswith("data:"):
                        value = line[5:]
                        data.append(value[1:] if value.startswith(" ") else value)
                if last_type is not None and last_type not in ("execution.completed", "execution.failed"):
                    raise RuntimeError("model runtime stream ended before a terminal event")
        except HTTPError as error:
            raise RuntimeHTTPError(error.code) from error

    def execute(self, request: dict[str, Any], idempotency_key: str | None = None) -> Iterator[dict[str, Any]]:
        submission = self.submit(request, idempotency_key)
        return self.events(str(submission["execution_id"]))

    def _json(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers=headers or {},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = response.read(4 * 1024 * 1024 + 1)
                if len(payload) > 4 * 1024 * 1024:
                    raise RuntimeError("model runtime response exceeds 4 MiB")
                return json.loads(payload)
        except HTTPError as error:
            raise RuntimeHTTPError(error.code) from error
