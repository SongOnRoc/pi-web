#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseCommandLine } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const launchSettingsModule = require("./launch-settings");

const { LOOPBACK_HOSTNAMES, OPERATOR_LAUNCH_ENV_VARS, readLaunchSettingsFile } = launchSettingsModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNextNodeArgs } = require("./pi-web-node-args");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotatePreviewSecrets, getRotationWarning } = require("./rotate-preview-secrets");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openWhenServing } = require("./browser-opener");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRunRecordTracker, getOpenUrl, getRunDir } = require("./run-records");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPackageVersion, runCommand } = require("./pi-web-commands");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatReachableAddresses } = require("./network-addresses");

let launchOptions;
try {
  launchOptions = parseCommandLine();
} catch (error) {
  fs.writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

if (launchOptions.command === "start") {
  startServer(launchOptions);
} else {
  runCommand(launchOptions).then(
    exitWhenIdle,
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      exitWhenIdle(1);
    },
  );
}

// Leave once the event loop drains instead of calling process.exit() right
// after a fetch(): on Windows, Node.js 23 up to 24.19 / 26.6 can then abort
// with a libuv assertion (UV_HANDLE_CLOSING, win/async.c) while background
// work from the fetch is still winding down (#1174, nodejs/node#56645). The
// unref'd timer only fires if something still holds the loop open.
function exitWhenIdle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

function startServer({ port, hostname, openBrowser }) {

  const pkgDir = path.join(__dirname, "..");
  const nextDir = path.join(pkgDir, ".next");

  // The launch settings, put into the server's environment before Next.js
  // starts: a variable already set was chosen by whoever started this process,
  // so it wins over the file, and the file wins over the defaults.
  const launchSettings = readLaunchSettingsFile();

  // What the operator set before this launcher added anything of its own: only
  // these are "fixed by the environment", which Settings › Server shows as
  // read-only. The launcher always sets PI_WEB_HOSTNAME for Next, and pi-web
  // itself defaults PI_CODEMODE_MAX_WORKERS, so those cannot count.
  const fixedByEnvironment = OPERATOR_LAUNCH_ENV_VARS.filter((name) => process.env[name] !== undefined);
  process.env.PI_WEB_LAUNCH_FIXED_VARS = fixedByEnvironment.join(",");
  if (launchSettings.openBrowser === false) process.env.PI_WEB_NO_OPEN = "1";
  if (launchSettings.allowedHosts?.length && process.env.PI_WEB_ALLOWED_HOSTS === undefined) {
    process.env.PI_WEB_ALLOWED_HOSTS = launchSettings.allowedHosts.join(",");
  }
  if (launchSettings.appName && process.env.PI_WEB_APP_NAME === undefined) {
    process.env.PI_WEB_APP_NAME = launchSettings.appName;
  }
  if (launchSettings.idleTimeoutMs !== undefined && process.env.PI_WEB_IDLE_TIMEOUT_MS === undefined) {
    process.env.PI_WEB_IDLE_TIMEOUT_MS = String(launchSettings.idleTimeoutMs);
  }
  if (launchSettings.shutdownDeadlineMs !== undefined && process.env.PI_WEB_SHUTDOWN_DEADLINE_MS === undefined) {
    process.env.PI_WEB_SHUTDOWN_DEADLINE_MS = String(launchSettings.shutdownDeadlineMs);
  }
  if (launchSettings.codemodeMaxWorkers !== undefined && process.env.PI_CODEMODE_MAX_WORKERS === undefined) {
    process.env.PI_CODEMODE_MAX_WORKERS = String(launchSettings.codemodeMaxWorkers);
  }
  if (launchSettings.skipVersionCheck && process.env.PI_WEB_SKIP_VERSION_CHECK === undefined) {
    process.env.PI_WEB_SKIP_VERSION_CHECK = "1";
  }

  // Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
  // may not exist when installed via npx).
  let nextBin;
  try {
    nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
  } catch {
    // Fallback: locate next package root and derive the bin path manually.
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
      nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
    } catch {
      nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
    }
  }

  const loopbackHostnames = LOOPBACK_HOSTNAMES;
  const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

  if (!fs.existsSync(nextDir)) {
    console.error("Build artifacts not found. Please report this issue.");
    process.exit(1);
  }

  // Replace the published preview-mode secrets with fresh random values so the
  // previewModeId baked into the npm tarball cannot be used to skip the proxy
  // (via the x-prerender-revalidate header). Must happen before `next start`.
  const rotation = rotatePreviewSecrets(nextDir);
  if (!rotation.ok) {
    console.warn(getRotationWarning(rotation.reason));
  }

  if (!loopbackHostnames.has(hostname)) {
    if (passwordEnabled) {
      console.warn(
        `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
      );
    } else {
      console.warn(
        `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
      );
    }
  }

  const nextArgs = ["start", "-p", port];
  nextArgs.push("-H", hostname);

  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  const child = spawn(process.execPath, getNextNodeArgs(nextBin, nextArgs), {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env, PI_WEB_HOSTNAME: hostname },
  });
  wireChildProcessLifecycle(child);

  // Port 0 lets the OS pick a port we never learn, so such a server gets no record.
  const runRecord = createRunRecordTracker({
    dir: getRunDir,
    record: {
      pid: process.pid,
      nextPid: child.pid,
      port: Number(port),
      hostname,
      url: getOpenUrl(hostname, port),
      version: getPackageVersion(pkgDir),
      startedAt: new Date().toISOString(),
    },
  });

  let serverReady = false;
  const url = `http://${hostname}:${port}`;
  // Next.js repeats the `-H` value in its own "Network:" line, which a wildcard
  // bind makes unusable; name the interfaces and their addresses instead.
  const reachable = formatReachableAddresses(hostname, port);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!serverReady && text.includes("Ready")) {
      serverReady = true;
      if (reachable) process.stdout.write(`${reachable}\n`);
      // The record needs no wait: status, stop and open list a record only
      // once its URL answers. The browser waits for the first page.
      if (port !== "0") runRecord.markReady();
      if (openBrowser) openWhenServing({ hostname, port, url });
    }
  });
}
