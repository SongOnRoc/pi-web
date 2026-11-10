import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  FIXED_VARS_ENV,
  MAX_DURATION_MS,
  environmentLockedKeys,
  launchEnvironment,
  getLaunchSettingsPath,
  normalizeValue,
  readEnvironmentSettings,
  readLaunchSettingsFile,
  resolveLaunchSettings,
  splitHostnames,
  toOpenUrl,
  writeLaunchSettings,
} = require("../bin/launch-settings.js");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("defaults match the CLI's own", () => {
  const settings = resolveLaunchSettings({ env: {}, settingsPath: join(tmpdir(), "missing-launch.json") });
  assert.equal(settings.port, "30141");
  assert.equal(settings.hostname, "127.0.0.1");
  assert.equal(settings.openBrowser, true);
  assert.deepEqual(settings.allowedHosts, []);
  assert.equal(settings.appName, "");
  assert.equal(settings.idleTimeoutMs, 600_000);
  assert.equal(settings.shutdownDeadlineMs, 5_000);
  assert.equal(settings.codemodeMaxWorkers, 8);
  assert.equal(settings.skipVersionCheck, false);
});

test("validates each setting kind", () => {
  assert.deepEqual(normalizeValue("port", "8080"), { value: "8080" });
  assert.deepEqual(normalizeValue("port", 8080), { value: "8080" });
  assert.deepEqual(normalizeValue("port", "0"), { value: "0" });
  assert.match(normalizeValue("port", "70000").error, /Port must be a non-negative integer/);
  assert.match(normalizeValue("port", "80a").error, /Port must be a non-negative integer/);

  assert.deepEqual(normalizeValue("hostname", " 0.0.0.0 "), { value: "0.0.0.0" });
  assert.deepEqual(normalizeValue("hostname", "::1"), { value: "::1" });
  assert.match(normalizeValue("hostname", "http://host").error, /bind IP address or host name/);
  assert.match(normalizeValue("hostname", "").error, /bind IP address or host name/);
  assert.match(normalizeValue("hostname", "-bad").error, /bind IP address or host name/);

  assert.deepEqual(normalizeValue("allowedHosts", ["a.example", "b.example"]), { value: ["a.example", "b.example"] });
  assert.deepEqual(normalizeValue("allowedHosts", ["a.example", "a.example"]), { value: ["a.example"] });
  assert.deepEqual(normalizeValue("allowedHosts", []), { value: [] });
  assert.match(normalizeValue("allowedHosts", ["bad host"]).error, /Not a host name/);

  assert.deepEqual(normalizeValue("openBrowser", false), { value: false });
  assert.match(normalizeValue("openBrowser", "false").error, /true or false/);

  assert.deepEqual(normalizeValue("idleTimeoutMs", 0), { value: 0 });
  assert.deepEqual(normalizeValue("idleTimeoutMs", MAX_DURATION_MS), { value: MAX_DURATION_MS });
  assert.match(normalizeValue("idleTimeoutMs", -1).error, /milliseconds/);
  assert.match(normalizeValue("idleTimeoutMs", MAX_DURATION_MS + 1).error, /milliseconds/);
  assert.match(normalizeValue("idleTimeoutMs", 1.5).error, /milliseconds/);

  assert.deepEqual(normalizeValue("codemodeMaxWorkers", 16), { value: 16 });
  assert.match(normalizeValue("codemodeMaxWorkers", 0).error, /from 1 to 64/);

  assert.deepEqual(normalizeValue("appName", "  Work Pi  "), { value: "Work Pi" });
  assert.deepEqual(normalizeValue("appName", "   "), { value: "" });
  assert.match(normalizeValue("appName", "x".repeat(61)).error, /at most 60/);

  assert.match(normalizeValue("nope", 1).error, /Unknown setting/);
});

test("splits a comma-separated hostname list, dropping blanks and repeats", () => {
  assert.deepEqual(splitHostnames("a.example, b.example ,, a.example"), ["a.example", "b.example"]);
  assert.deepEqual(splitHostnames(""), []);
  assert.deepEqual(splitHostnames(undefined), []);
});

test("writes only deliberate changes and drops defaults", (t) => {
  const settingsPath = join(tempDir(t), "pi-web-launch.json");

  writeLaunchSettings({ port: "30141", hostname: "0.0.0.0" }, { env: {}, settingsPath });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { version: 1, hostname: "0.0.0.0" });

  writeLaunchSettings({ port: "8080", hostname: "127.0.0.1" }, { env: {}, settingsPath });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { version: 1, port: "8080" });

  // Saving everything back to its default leaves no file behind.
  writeLaunchSettings({ port: "30141" }, { env: {}, settingsPath });
  assert.throws(() => readFileSync(settingsPath, "utf8"), { code: "ENOENT" });
});

test("writes the fields in one canonical order", (t) => {
  const settingsPath = join(tempDir(t), "pi-web-launch.json");
  writeLaunchSettings({ skipVersionCheck: true, port: "8080", hostname: "0.0.0.0" }, { env: {}, settingsPath });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(settingsPath, "utf8"))), [
    "version",
    "port",
    "hostname",
    "skipVersionCheck",
  ]);
});

test("a damaged file reads as empty instead of stopping the server", (t) => {
  const settingsPath = join(tempDir(t), "pi-web-launch.json");
  writeFileSync(settingsPath, "{not json");
  assert.deepEqual(readLaunchSettingsFile(settingsPath), {});

  writeFileSync(settingsPath, JSON.stringify({ port: "70000", hostname: "0.0.0.0", unknown: 1 }));
  assert.deepEqual(readLaunchSettingsFile(settingsPath), { hostname: "0.0.0.0" });
});

test("the environment wins over the file, and an inverted switch keeps its meaning", (t) => {
  const settingsPath = join(tempDir(t), "pi-web-launch.json");
  writeLaunchSettings({ port: "8080", openBrowser: false }, { env: {}, settingsPath });

  assert.deepEqual(readEnvironmentSettings({ PI_WEB_NO_OPEN: "1" }), { openBrowser: false });
  assert.deepEqual(readEnvironmentSettings({ PI_WEB_NO_OPEN: "0" }), { openBrowser: true });
  assert.deepEqual(readEnvironmentSettings({}), {});

  // Only variables the launcher recorded for the operator count.
  const withEnv = resolveLaunchSettings({ env: { [FIXED_VARS_ENV]: "PORT", PORT: "9000" }, settingsPath });
  assert.equal(withEnv.port, "9000");
  assert.equal(withEnv.openBrowser, false);

  // A recorded variable that cannot be used fails loudly: silently keeping the
  // file's value would run a port the operator did not choose.
  assert.throws(
    () => resolveLaunchSettings({ env: { [FIXED_VARS_ENV]: "PORT", PORT: "nope" }, settingsPath }),
    /Invalid PORT/,
  );

  // A process that did not go through the launcher states nothing about the
  // file, so its own PORT is not a setting.
  assert.equal(resolveLaunchSettings({ env: { PORT: "9000" }, settingsPath }).port, "8080");
});

test("an empty environment variable is still a deliberate choice", () => {
  const env = { [FIXED_VARS_ENV]: "PI_WEB_ALLOWED_HOSTS", PI_WEB_ALLOWED_HOSTS: "" };
  assert.deepEqual(readEnvironmentSettings(launchEnvironment(env)), { allowedHosts: [] });
  assert.deepEqual(environmentLockedKeys(env), ["allowedHosts"]);
});

test("reports the variables that fix a setting for this process", () => {
  assert.deepEqual(environmentLockedKeys({
    [FIXED_VARS_ENV]: "PORT,PI_WEB_APP_NAME",
    PORT: "8080",
    PI_WEB_APP_NAME: "Work",
  }), ["port", "appName"]);
  assert.deepEqual(environmentLockedKeys({}), []);
});

test("only the variables the operator set count, not the ones pi-web exports itself", () => {
  // The launcher always exports PI_WEB_HOSTNAME for Next, and pi-web defaults
  // PI_CODEMODE_MAX_WORKERS; neither is the operator's choice.
  assert.deepEqual(environmentLockedKeys({
    [FIXED_VARS_ENV]: "",
    PI_WEB_HOSTNAME: "127.0.0.1",
    PI_CODEMODE_MAX_WORKERS: "8",
  }), []);
  assert.deepEqual(environmentLockedKeys({
    [FIXED_VARS_ENV]: "PORT,PI_WEB_PASSWORD",
    PI_WEB_HOSTNAME: "0.0.0.0",
  }), ["port"]);
});

test("stores the launch settings beside pi's own files", () => {
  assert.equal(getLaunchSettingsPath({}, "/home/pi"), join("/home/pi", ".pi", "agent", "pi-web-launch.json"));
  assert.equal(
    getLaunchSettingsPath({ PI_CODING_AGENT_DIR: "/data/agent" }, "/home/pi"),
    join("/data/agent", "pi-web-launch.json"),
  );
});

test("a wildcard bind opens the loopback address", () => {
  assert.equal(toOpenUrl("0.0.0.0", "30141"), "http://127.0.0.1:30141");
  assert.equal(toOpenUrl("::", "30141"), "http://[::1]:30141");
  assert.equal(toOpenUrl("192.168.1.5", "8080"), "http://192.168.1.5:8080");
});
