import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getHelpText, parseLaunchOptions: parseLaunchOptionsWithFile } = require("../bin/pi-web-options.js");
const cliPath = fileURLToPath(new URL("../bin/pi-web.js", import.meta.url));

// Every test states the settings file explicitly, so none of them depends on
// what the machine running them happens to have in ~/.pi/agent. An injected
// environment goes through the same recording rule the launcher applies: only
// variables named in PI_WEB_LAUNCH_FIXED_VARS count.
function parseLaunchOptions(args, env = {}, storedSettings = {}) {
  return parseLaunchOptionsWithFile(args, env, storedSettings);
}

test("opens the browser by default", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    help: false,
    port: "30141",
    hostname: "127.0.0.1",
    openBrowser: true,
  });
});

test("supports --help and -h without starting the server", () => {
  assert.deepEqual(parseLaunchOptions(["--help"], {}), { help: true });
  assert.deepEqual(parseLaunchOptions(["-h"], {}), { help: true });
  assert.match(getHelpText(), /Usage: pi-web/);
  assert.match(getHelpText(), /--port/);
  assert.match(getHelpText(), /--hostname/);
  assert.match(getHelpText(), /--no-open/);
  assert.match(getHelpText(), /PI_WEB_SKIP_VERSION_CHECK/);
  assert.match(getHelpText(), /PI_WEB_IDLE_TIMEOUT_MS/);
  assert.match(getHelpText(), /PI_WEB_APP_NAME/);
});

test("rejects unknown options with a help hint", () => {
  assert.throws(
    () => parseLaunchOptions(["--unknown-flag"], {}),
    /Use --help to see available options/,
  );
});

test("rejects unexpected positional arguments", () => {
  assert.throws(
    () => parseLaunchOptions(["start"], {}),
    /Unexpected argument/,
  );
});

test("CLI writes help and parse errors before exiting", () => {
  const help = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: pi-web/);
  assert.match(help.stdout, /PI_WEB_APP_NAME/);

  const invalid = spawnSync(process.execPath, [cliPath, "--unknown-flag"], {
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Use --help to see available options/);
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy PI_WEB_NO_OPEN values the launcher recorded", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(
      parseLaunchOptions([], { PI_WEB_LAUNCH_FIXED_VARS: "PI_WEB_NO_OPEN", PI_WEB_NO_OPEN: value }).openBrowser,
      false,
    );
  }
  // A process that did not come from the launcher states nothing about the
  // launch settings, so its own variables do not apply.
  assert.equal(parseLaunchOptions([], { PI_WEB_NO_OPEN: "1" }).openBrowser, true);
});

test("does not disable browser opening for false PI_WEB_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(
      parseLaunchOptions([], { PI_WEB_LAUNCH_FIXED_VARS: "PI_WEB_NO_OPEN", PI_WEB_NO_OPEN: value }).openBrowser,
      true,
    );
  }
});

test("preserves port and hostname options", () => {
  assert.deepEqual(
    parseLaunchOptions(["-p", "8080", "-H", "0.0.0.0"], {}),
    {
      help: false,
      port: "8080",
      hostname: "0.0.0.0",
      openBrowser: true,
    },
  );
});

test("rejects port values that could inject cmd arguments", () => {
  assert.throws(
    () => parseLaunchOptions(["-p", "30141&whoami"], {}),
    /Port must be a non-negative integer/,
  );
  assert.throws(
    () => parseLaunchOptions([], { PI_WEB_LAUNCH_FIXED_VARS: "PORT", PORT: "30141&whoami" }),
    /Port must be a non-negative integer/,
  );
});

test("supports PI_WEB_HOSTNAME without trusting the ambient system HOSTNAME", () => {
  // HOSTNAME is a shell or container variable, never a launch setting.
  assert.equal(
    parseLaunchOptions([], { HOSTNAME: "container-id" }).hostname,
    "127.0.0.1",
  );
  assert.equal(
    parseLaunchOptions([], { PI_WEB_LAUNCH_FIXED_VARS: "PI_WEB_HOSTNAME", PI_WEB_HOSTNAME: "0.0.0.0" }).hostname,
    "0.0.0.0",
  );
  // An unrecorded PI_WEB_HOSTNAME (a dev server's, say) is not a statement
  // about the launch settings.
  assert.equal(parseLaunchOptions([], { PI_WEB_HOSTNAME: "0.0.0.0" }).hostname, "127.0.0.1");
});

test("the stored launch settings apply when nothing else sets them", () => {
  const stored = { port: "8080", hostname: "0.0.0.0", openBrowser: false };
  assert.deepEqual(parseLaunchOptions([], {}, stored), {
    help: false,
    port: "8080",
    hostname: "0.0.0.0",
    openBrowser: false,
  });
});

test("a command-line option wins over the stored settings, and so does a recorded environment variable", () => {
  const stored = { port: "8080", hostname: "0.0.0.0" };
  assert.equal(parseLaunchOptions(["-p", "9000"], {}, stored).port, "9000");
  assert.equal(parseLaunchOptions(["-H", "::1"], {}, stored).hostname, "::1");
  assert.equal(parseLaunchOptions(["--no-open"], {}, stored).openBrowser, false);
});
