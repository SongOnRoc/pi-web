import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-launch-route-"));
// The launch settings take the environment into account, so a variable set by
// the machine running the tests (a dev shell, a container) must not decide what
// they assert: every launch variable is cleared and put back afterwards.
const LAUNCH_ENV_KEYS = [
  "PORT",
  "PI_WEB_HOSTNAME",
  "PI_WEB_NO_OPEN",
  "PI_WEB_ALLOWED_HOSTS",
  "PI_WEB_APP_NAME",
  "PI_WEB_IDLE_TIMEOUT_MS",
  "PI_WEB_SHUTDOWN_DEADLINE_MS",
  "PI_CODEMODE_MAX_WORKERS",
  "PI_WEB_SKIP_VERSION_CHECK",
  "PI_WEB_LAUNCH_FIXED_VARS",
];
const savedEnv = new Map(LAUNCH_ENV_KEYS.map((key) => [key, process.env[key]]));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
for (const key of LAUNCH_ENV_KEYS) delete process.env[key];
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

const settingsPath = path.join(agentDir, "pi-web-launch.json");

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/launch-settings", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("reads the defaults, then saves a change and reads it back", async () => {
  const initial = await (await GET()).json();
  assert.equal(initial.values.port, "30141");
  assert.equal(initial.values.hostname, "127.0.0.1");
  assert.deepEqual(initial.stored, {});
  assert.equal(initial.path, settingsPath);
  assert.equal(initial.url, "http://127.0.0.1:30141");

  const saved = await put({ port: "8080", hostname: "0.0.0.0" });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.values.port, "8080");
  // A wildcard bind still opens a loopback address in the browser.
  assert.equal(body.url, "http://127.0.0.1:8080");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    port: "8080",
    hostname: "0.0.0.0",
  });
});

test("saving a value back to its default removes it from the file", async () => {
  await rm(settingsPath, { force: true });
  await put({ port: "8080" });
  const saved = await put({ port: "30141" });
  assert.deepEqual((await saved.json()).stored, {});
  await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
});

test("refuses invalid values, unknown keys, foreign origins and non-JSON bodies", async () => {
  await rm(settingsPath, { force: true });
  await put({ port: "8080" });

  assert.equal((await put({ port: "99999" })).status, 400);
  assert.equal((await put({ hostname: "http://evil" })).status, 400);
  assert.equal((await put({ idleTimeoutMs: -1 })).status, 400);
  assert.equal((await put({ notASetting: 1 })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put("{")).status, 400);
  assert.equal((await put("[]")).status, 400);
  assert.equal((await put({ port: "9000" }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await put({ port: "9000" }, {
    host: "localhost",
    origin: "https://evil.example",
    "Content-Type": "application/json",
  })).status, 403);
  assert.equal((await put({ port: "9000" }, { host: "evil.example", "Content-Type": "application/json" })).status, 403);

  // None of the refusals touched the file.
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, port: "8080" });
});

test("a setting an environment variable fixes is refused instead of silently ignored", async () => {
  // The launcher records the variables the operator set; the route reads only those.
  process.env.PI_WEB_LAUNCH_FIXED_VARS = "PORT";
  process.env.PORT = "9100";
  try {
    const read = await (await GET()).json();
    assert.ok(read.environmentKeys.includes("port"));
    assert.equal(read.values.port, "9100");
    const refused = await put({ port: "8080" });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /fixed by PORT/);
  } finally {
    delete process.env.PORT;
    delete process.env.PI_WEB_LAUNCH_FIXED_VARS;
  }
});

test("port 0 has no address to open", async () => {
  const body = await (await put({ port: "0" })).json();
  assert.equal(body.values.port, "0");
  assert.equal(body.url, null);
  await writeFile(settingsPath, "{}\n");
});
