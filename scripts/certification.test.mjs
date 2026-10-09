import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

async function run(args) {
  const child = spawn(process.execPath, ["scripts/certify-provider.mjs", ...args], {
    env: {},
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return { code, report: JSON.parse(stdout), stderr, stdout };
}

test("certification requires explicit fixture/live scope and dedicated credentials", async () => {
  for (const args of [
    [],
    ["--provider", "openai", "--model", "model-alpha"],
    [
      "--provider",
      "openai",
      "--model",
      "model-alpha",
      "--fixture",
      "--base-url",
      "https://provider.example.test",
    ],
    ["--provider", "openai", "--model", "model-alpha", "--live"],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 1);
    assert.equal(result.report.outcome, "failed");
    assert.equal(result.stderr, "");
  }
});

for (const kind of ["openai", "anthropic", "fal"]) {
  test(`certifies ${kind} protocol against a local fixture without capturing output`, async () => {
    let base = "";
    const server = createServer((request, response) => {
      request.resume();
      if (kind === "fal") {
        const value =
          request.method === "POST"
            ? {
                status_url: `${base}/status`,
                response_url: `${base}/result`,
                cancel_url: `${base}/cancel`,
              }
            : request.url === "/status"
              ? { status: "COMPLETED" }
              : { images: [{ url: "https://media.example.test/image.png" }] };
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
      } else {
        const events =
          kind === "openai"
            ? [
                { type: "response.output_text.delta", output_index: 0, delta: "READY" },
                { type: "response.completed", response: {} },
              ]
            : [
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "READY" },
                },
                { type: "message_stop" },
              ];
        response
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(events.map((event) => `data:${JSON.stringify(event)}\n\n`).join(""));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      const result = await run([
        "--provider",
        kind,
        "--model",
        "model-alpha",
        "--fixture",
        "--base-url",
        base,
      ]);
      assert.equal(result.code, 0);
      assert.equal(result.report.mode, "fixture");
      assert.equal(result.report.outcome, "passed");
      assert.equal(result.report.output_capture, false);
      assert.equal(result.report.credential_capture, false);
      assert.ok(!result.stdout.includes("fixture-credential"));
      assert.ok(!result.stdout.includes("https://media.example.test/image.png"));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
