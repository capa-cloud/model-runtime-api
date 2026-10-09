import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const image = process.argv[2];
if (!image || process.argv.length !== 3 || !/^[a-z0-9][a-z0-9/._:-]{0,255}$/.test(image)) {
  process.stderr.write("Usage: node scripts/container-smoke.mjs IMAGE\n");
  process.exit(2);
}
const marker = randomUUID();
const name = `model-runtime-smoke-${marker}`;
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
let id;
try {
  id = docker([
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `model-runtime.smoke=${marker}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--env",
    "MODEL_RUNTIME_CONFIG=",
    "--env",
    "MODEL_RUNTIME_HOST=127.0.0.1",
    "--env",
    "MODEL_RUNTIME_PORT=4320",
    image,
  ]).trim();
  const probe = `
    const assert = require("node:assert/strict");
    const base = "http://127.0.0.1:4320";
    const request = (path, options={}) => fetch(base+path,{...options,signal:AbortSignal.timeout(5000)});
    (async()=>{
      assert.notEqual(process.getuid(),0);
      let ready=false;
      for(let i=0;i<50;i++){try{const r=await request("/v1/runtime");if(r.ok){assert.equal((await r.json()).state,"ready");ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
      assert.ok(ready,"runtime readiness");
      const providers=await (await request("/v1/providers")).json();
      assert.equal(providers.data.length,1);assert.equal(providers.data[0].provider,"provider-mock");
      const options={method:"POST",headers:{"content-type":"application/json","idempotency-key":"container-smoke-fixture"},body:JSON.stringify({ability:"text-generation",input:[{type:"text",text:"synthetic fixture"}]})};
      const first=await request("/v1/executions",options);assert.equal(first.status,202);const submission=await first.json();
      const stream=await request("/v1/executions/"+submission.execution_id+"/events");assert.ok(stream.headers.get("content-type").includes("text/event-stream"));
      const events=await stream.text();assert.ok(events.includes('"type":"execution.completed"'));
      const snapshot=await (await request("/v1/executions/"+submission.execution_id)).json();assert.equal(snapshot.status,"succeeded");
      const result=await (await request("/v1/executions/"+submission.execution_id+"/result")).json();assert.deepEqual(result.result,{outputs:[{index:0,type:"text",text:"hello from mock"}],tool_calls:[]});
      const replay=await request("/v1/executions",options);assert.equal(replay.status,200);const repeated=await replay.json();assert.equal(repeated.execution_id,submission.execution_id);assert.equal(repeated.idempotent_replay,true);
      process.stdout.write("Container HTTP/SSE/idempotency smoke passed.\\n");
    })().catch(()=>{process.stderr.write("Container probe failed.\\n");process.exit(1);});
  `;
  const output = docker(["exec", id, "node", "-e", probe]);
  process.stdout.write(output);
  docker(["stop", "--time", "10", id]);
  const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", id]));
  if (state.ExitCode !== 0) throw new Error("Container shutdown was not clean");
  process.stdout.write("Read-only nonroot container shutdown passed.\n");
} catch {
  process.stderr.write("Container verification failed; no release claim is available.\n");
  process.exitCode = 1;
} finally {
  try {
    const ownership = docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "model-runtime.smoke"}}',
      id ?? name,
    ]).trim();
    if (ownership === marker) docker(["rm", "--force", id ?? name]);
  } catch {
    process.stderr.write("Verify task-owned container cleanup before proceeding.\n");
    process.exitCode = 1;
  }
}
