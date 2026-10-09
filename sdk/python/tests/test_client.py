import json
import io
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from model_runtime import ModelRuntimeClient


class FixtureHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/v1/executions":
            assert self.headers.get("Idempotency-Key") == "request-public"
            length = int(self.headers.get("Content-Length", "0"))
            json.loads(self.rfile.read(length))
            self._json(
                {
                    "execution_id": "execution-public",
                    "status": "accepted",
                    "created_at": "2026-01-01T00:00:00Z",
                    "idempotent_replay": False,
                }
            )
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path.startswith("/v1/executions/execution-public/events"):
            body = (
                'id: 1\nevent: execution.accepted\ndata: '
                '{"type":"execution.accepted","execution_id":"execution-public",'
                '"sequence":1,"time":"2026-01-01T00:00:00Z","status":"accepted"}\n\n'
                'data:{"type":"execution.completed","sequence":2,"status":"succeeded"}\n\n'
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def log_message(self, _format, *_args):
        pass

    def _json(self, value):
        body = json.dumps(value).encode()
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_submit_and_events(self):
        client = ModelRuntimeClient(f"http://127.0.0.1:{self.server.server_port}")
        submission = client.submit(
            {"ability": "text-generation", "input": [{"type": "text", "text": "fixture"}]},
            "request-public",
        )
        self.assertEqual(submission["execution_id"], "execution-public")
        events = list(client.events("execution-public"))
        self.assertEqual(events[0]["sequence"], 1)
        self.assertEqual(events[-1]["type"], "execution.completed")

    def test_rejects_credentials_in_base_url(self):
        with self.assertRaises(ValueError):
            ModelRuntimeClient("https://user:password@example.test")

    def test_rejects_query_and_invalid_cursor(self):
        with self.assertRaises(ValueError):
            ModelRuntimeClient("https://runtime.example.test?fixture=value")
        client = ModelRuntimeClient("https://runtime.example.test")
        for cursor in (-1, 0.5, True):
            with self.assertRaises(ValueError):
                list(client.events("fixture", cursor))

    def test_bounds_long_lines_and_multiline_frames(self):
        client = ModelRuntimeClient("https://runtime.example.test")
        for payload in (b"data:" + b"x" * (1024 * 1024), (b"data:" + b"x" * 1024 + b"\n") * 1024):
            response = io.BytesIO(payload)
            with patch("model_runtime.client.urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "frame exceeds"):
                    list(client.events("fixture"))
            self.assertTrue(response.closed)

    def test_reports_truncation_and_closes_response_on_early_stop(self):
        client = ModelRuntimeClient("https://runtime.example.test")
        payload = b'data:{"type":"execution.accepted","sequence":1}\r\n\r\n'
        with patch("model_runtime.client.urlopen", return_value=io.BytesIO(payload)):
            with self.assertRaisesRegex(RuntimeError, "before a terminal"):
                list(client.events("fixture"))
        response = io.BytesIO(payload)
        with patch("model_runtime.client.urlopen", return_value=response):
            stream = client.events("fixture")
            self.assertEqual(next(stream)["sequence"], 1)
            stream.close()
        self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main()
