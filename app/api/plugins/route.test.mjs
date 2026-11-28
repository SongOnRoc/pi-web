import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-plugin-route-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "extensions"), { recursive: true });
await mkdir(cwd);
await writeFile(join(agentDir, "extensions", "rtk.ts"), "export default () => {};\n");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET, POST } = await jiti.import("./route.ts");
allowFileRoot(cwd);

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("lists auto-discovered top-level extensions", async () => {
  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.packages, []);
  assert.deepEqual(body.standaloneExtensions, [{
    kind: "extension",
    name: "rtk",
    path: join(agentDir, "extensions", "rtk.ts"),
    relativePath: "extensions/rtk.ts",
    scope: "global",
    enabled: true,
  }]);
  assert.equal(body.totals.extensions, 1);
});

test("reports the package description from package.json", async () => {
  const packageDir = join(root, "pkg-with-description");
  await mkdir(join(packageDir, "extensions"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name: "pkg-with-description",
    version: "1.2.3",
    description: "Adds descriptions to the Plugins panel.",
  }));
  await writeFile(join(packageDir, "extensions", "index.ts"), "export default () => {};\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageDir] }));

  const response = await GET(new Request(`http://localhost/api/plugins?cwd=${encodeURIComponent(cwd)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  const installed = body.packages.find((pkg) => pkg.source === packageDir);
  assert.ok(installed, "configured package is listed");
  assert.equal(installed.description, "Adds descriptions to the Plugins panel.");
});

async function makePackage(name) {
  const packageDir = join(root, name);
  await mkdir(join(packageDir, "extensions"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  await writeFile(join(packageDir, "extensions", "index.ts"), "export default () => {};\n");
  return packageDir;
}

const off = { extensions: [], skills: [], prompts: [], themes: [] };
const settingsPath = join(agentDir, "settings.json");

async function readPackages() {
  return JSON.parse(await readFile(settingsPath, "utf8")).packages;
}

function postPlugins(body, projectCwd = cwd) {
  return POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ cwd: projectCwd, ...body }),
  }));
}

test("bulk disable writes every listed package and reports each one", async () => {
  const [alpha, beta, gamma] = await Promise.all(["bulk-alpha", "bulk-beta", "bulk-gamma"].map(makePackage));
  await writeFile(settingsPath, JSON.stringify({
    packages: [alpha, { source: beta, ...off }, gamma],
  }));

  const response = await postPlugins({
    action: "disable",
    packages: [
      { source: alpha, scope: "global" },
      { source: beta, scope: "global" },
      { source: "npm:removed-since-load", scope: "global" },
    ],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results, [
    { source: alpha, scope: "global" },
    { source: beta, scope: "global" },
    { source: "npm:removed-since-load", scope: "global", error: "Package is not configured" },
  ]);
  // gamma was not listed, so the bulk write leaves it alone.
  assert.deepEqual(await readPackages(), [{ source: alpha, ...off }, { source: beta, ...off }, gamma]);
  const disabled = Object.fromEntries(body.packages.map((pkg) => [pkg.source, pkg.disabled]));
  assert.deepEqual(disabled, { [alpha]: true, [beta]: true, [gamma]: false });
});

test("bulk enable restores disabled packages and keeps a filtered one's filters", async () => {
  const [alpha, beta] = await Promise.all(["bulk-alpha", "bulk-beta"].map(makePackage));
  const filtered = { source: beta, extensions: ["extensions/index.ts"] };
  await writeFile(settingsPath, JSON.stringify({ packages: [{ source: alpha, ...off }, filtered] }));

  const response = await postPlugins({
    action: "enable",
    packages: [{ source: alpha, scope: "global" }, { source: beta, scope: "global" }],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.results.map((result) => result.error), [undefined, undefined]);
  assert.deepEqual(await readPackages(), [alpha, filtered]);
});

test("bulk toggles refuse an untrusted project's packages without stopping global ones", async () => {
  const alpha = await makePackage("bulk-alpha");
  const untrusted = join(root, "untrusted-project");
  await mkdir(join(untrusted, ".pi"), { recursive: true });
  const projectSettings = JSON.stringify({ packages: ["npm:project-only"] });
  await writeFile(join(untrusted, ".pi", "settings.json"), projectSettings);
  allowFileRoot(untrusted);
  await writeFile(settingsPath, JSON.stringify({ packages: [alpha] }));

  const response = await postPlugins({
    action: "disable",
    packages: [{ source: alpha, scope: "global" }, { source: "npm:project-only", scope: "project" }],
  }, untrusted);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.results[0].error, undefined);
  assert.match(body.results[1].error, /must be trusted/);
  assert.deepEqual(await readPackages(), [{ source: alpha, ...off }]);
  assert.equal(await readFile(join(untrusted, ".pi", "settings.json"), "utf8"), projectSettings);
});

test("bulk toggles report a settings file the SDK could not load instead of success", async () => {
  const alpha = await makePackage("bulk-alpha");
  await writeFile(settingsPath, `{ "packages": ["${alpha}"]`);

  const response = await postPlugins({ action: "disable", packages: [{ source: alpha, scope: "global" }] });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(body.results[0].error.startsWith(settingsPath), body.results[0].error);
  assert.equal(await readFile(settingsPath, "utf8"), `{ "packages": ["${alpha}"]`);
  await writeFile(settingsPath, JSON.stringify({ packages: [] }));
});

test("bulk toggles reject malformed package lists and other actions", async () => {
  const notAList = await postPlugins({ action: "disable", packages: "npm:x" });
  assert.equal(notAList.status, 400);
  const missingSource = await postPlugins({ action: "disable", packages: [{ scope: "global" }] });
  assert.equal(missingSource.status, 400);
  const remove = await postPlugins({ action: "remove", packages: [{ source: "npm:x", scope: "global" }] });
  assert.equal(remove.status, 400);
});

test("bulk disable leaves a filtered package alone and says why", async () => {
  const [alpha, beta] = await Promise.all(["bulk-alpha", "bulk-beta"].map(makePackage));
  const filtered = { source: beta, extensions: ["extensions/index.ts"] };
  await writeFile(settingsPath, JSON.stringify({ packages: [alpha, filtered] }));

  const response = await postPlugins({
    action: "disable",
    packages: [{ source: alpha, scope: "global" }, { source: beta, scope: "global" }],
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.results[0].error, undefined);
  assert.match(body.results[1].error, /resource filters/);
  // Disabling would have emptied its lists, and enabling cannot restore them.
  assert.deepEqual(await readPackages(), [{ source: alpha, ...off }, filtered]);
});

test("enabling keeps an entry's own settings such as autoload", async () => {
  const [alpha, beta] = await Promise.all(["bulk-alpha", "bulk-beta"].map(makePackage));
  await writeFile(settingsPath, JSON.stringify({
    packages: [{ source: alpha, autoload: false, ...off }, { source: beta, autoload: false, ...off }],
  }));

  const single = await postPlugins({ action: "enable", source: alpha, scope: "global" });
  assert.equal(single.status, 200);
  const bulk = await postPlugins({ action: "enable", packages: [{ source: beta, scope: "global" }] });
  assert.equal(bulk.status, 200);

  assert.deepEqual(await readPackages(), [{ source: alpha, autoload: false }, { source: beta, autoload: false }]);
});

test("set-builtin writes the scope's extensions list and nothing else", async () => {
  // The panel's switch: off appends `-builtin:<name>`, on drops it again, and
  // every other pattern in the list — a glob, a `!`, another built-in — stays.
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ extensions: ["!builtin:mcp", "builtin:codemode"], theme: "dark" }));
  // A project switch only counts once the folder is trusted, as for packages.
  new ProjectTrustStore(agentDir).set(cwd, true);
  const projectSettingsPath = join(cwd, ".pi", "settings.json");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(projectSettingsPath, JSON.stringify({ extensions: [] }));

  const off = await postPlugins({ action: "set-builtin", builtin: "ask-question", enabled: false, scope: "global" });
  assert.equal(off.status, 200);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    extensions: ["!builtin:mcp", "builtin:codemode", "-builtin:ask-question"],
    theme: "dark",
  });

  const body = await off.json();
  assert.deepEqual(
    body.builtins.map((builtin) => [builtin.name, builtin.enabled]),
    [["codemode", true], ["tool-search", true], ["mcp", false], ["ask-question", false]],
  );

  const on = await postPlugins({ action: "set-builtin", builtin: "ask-question", enabled: true, scope: "global" });
  assert.equal(on.status, 200);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).extensions, ["!builtin:mcp", "builtin:codemode"]);

  // A project's own switch applies there and leaves the global list alone.
  const project = await postPlugins({ action: "set-builtin", builtin: "ask-question", enabled: false, scope: "project" });
  assert.equal(project.status, 200);
  assert.deepEqual(JSON.parse(await readFile(projectSettingsPath, "utf8")).extensions, ["-builtin:ask-question"]);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).extensions, ["!builtin:mcp", "builtin:codemode"]);
  const projectAsk = (await project.json()).builtins.find((builtin) => builtin.name === "ask-question");
  assert.equal(projectAsk.enabled, false);
  assert.deepEqual(projectAsk.global, { enabled: true }, "the panel can show what the global switch alone says");

  await rm(projectSettingsPath);
});

test("set-builtin refuses a name it does not know and an untrusted project", async () => {
  const unknown = await postPlugins({ action: "set-builtin", builtin: "not-a-builtin", enabled: false, scope: "global" });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /Unknown built-in/);

  const untrusted = await POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "set-builtin", builtin: "ask-question", enabled: false, scope: "project", cwd }),
  }));
  assert.equal(untrusted.status, 403);
});
