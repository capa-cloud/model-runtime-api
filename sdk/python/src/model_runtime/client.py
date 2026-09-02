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
        ):
            raise ValueError("base_url must be HTTP or HTTPS without credentials or fragments")
        self.base_url = base_url.rstrip("/")
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
        query = urlencode({"after": after})
        request = Request(
            f"{self.base_url}/v1/executions/{quote(execution_id, safe='')}/events?{query}",
            headers={"Accept": "text/event-stream"},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                data: list[str] = []
                frame_bytes = 0
                for raw in response:
                    frame_bytes += len(raw)
                    if frame_bytes > 1024 * 1024:
                        raise RuntimeError("model runtime SSE frame exceeds 1 MiB")
                    line = raw.decode("utf-8").rstrip("\r\n")
                    if not line:
                        if data:
                            yield json.loads("\n".join(data))
                            data.clear()
                        frame_bytes = 0
                        continue
                    if line.startswith("data: "):
                        data.append(line[6:])
                if data:
                    yield json.loads("\n".join(data))
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
