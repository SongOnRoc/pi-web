"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const launchSettings = require("./launch-settings");

const { defaultLaunchSettings, launchEnvironment, readEnvironmentSettings, resolveLaunchSettings } = launchSettings;

const CLI_OPTIONS = {
  port: { type: "string", short: "p" },
  hostname: { type: "string", short: "H" },
  "no-open": { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

function normalizePort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error("Port must be a non-negative integer.");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new Error("Port must be between 0 and 65535.");
  }

  return String(port);
}

// Subcommands and their own options. Matched only as the first argument, so a
// bare `pi-web [options]` still starts the server.
const COMMAND_OPTIONS = {
  version: {},
  status: {},
  stop: { port: { type: "string", short: "p" } },
  open: { port: { type: "string", short: "p" } },
  update: { check: { type: "boolean" } },
};

function getHelpText() {
  return `Usage: pi-web [command] [options]

Start the Pi Web UI server, or run one of the commands below.

Commands:
  version                    Print the installed Pi Web version (also -v, --version)
  status                     List running Pi Web servers
  stop [--port <port>]       Stop a running server
  open [--port <port>]       Open a running server in the browser
  update [--check]           Update a global npm install to the latest version

Options:
  -p, --port <port>          Server port (default: 30141, or PORT)
  -H, --hostname <host>      Bind hostname (default: 127.0.0.1, or PI_WEB_HOSTNAME)
      --no-open              Do not open a browser automatically
  -h, --help                 Show this help message and exit

Settings › Server in the web UI writes <agent-dir>/pi-web-launch.json, which
holds the port, bind hostname, browser opening and the variables below that have
a setting. A command-line option overrides it, and so does an environment
variable that is set; 'pi-web status' lists the servers that are running.

Environment:
  PORT                       Default port when --port is omitted
  PI_WEB_HOSTNAME            Default hostname when --hostname is omitted
  PI_WEB_NO_OPEN             Set to 1/true/yes/on to disable browser open
  PI_WEB_APP_NAME            PWA manifest name (trimmed; default Pi Web)
  PI_WEB_PASSWORD            Enable browser password login and API Basic Auth
  PI_WEB_ALLOWED_HOSTS       Extra exact proxy/custom hostnames, comma-separated
  PI_WEB_SKIP_VERSION_CHECK  Set to 1 to disable Pi Web update checks
  PI_WEB_IDLE_TIMEOUT_MS     Session idle timeout in ms (0 disables; default 600000)
  PI_WEB_SHUTDOWN_DEADLINE_MS  Shutdown wait for extensions in ms (default 5000)
`;
}

function toParseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const err = new Error(`${message}\nUse --help to see available options.`);
  err.code = "ERR_PARSE_ARGS_UNKNOWN_OPTION";
  return err;
}

// Returns { command: "start", ...launch options } for a bare launch, or
// { command, help, port?, check? } for a subcommand.
//
// `storedSettings` is passed to the launch options of a bare launch; the
// subcommands do not start anything and so do not read the settings file.
function parseCommandLine(args = process.argv.slice(2), env = process.env, storedSettings) {
  const first = args[0];
  const command = first === "-v" || first === "--version" ? "version" : first;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    return { command: "start", ...parseLaunchOptions(args, env, storedSettings) };
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: args.slice(1),
      options: { ...COMMAND_OPTIONS[command], help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw toParseError(error);
  }
  if (values.help) return { command, help: true };
  return {
    command,
    help: false,
    port: values.port === undefined ? undefined : normalizePort(values.port),
    check: values.check === true,
  };
}

/**
 * The settings the launcher starts with. Command-line options win over
 * everything else; below them `resolveLaunchSettings` applies the variables the
 * operator set, then the file Settings › Server writes, then the defaults.
 *
 * The environment is not read again here: `resolveLaunchSettings` already did,
 * and only for the variables the launcher recorded (`PI_WEB_LAUNCH_FIXED_VARS`).
 * Reading `env.PORT` directly would let a shell's or a dev server's PORT
 * override the saved port without the operator meaning it to.
 *
 * @param {string[]} [args]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {Record<string, unknown>} [storedSettings] a partial set of overrides; omitted means read the file
 */
function parseLaunchOptions(args = process.argv.slice(2), env = process.env, storedSettings) {
  // An injected set of settings stands in for the file, but the variables the
  // operator set still apply over it, as they do over a real file.
  const stored = storedSettings === undefined
    ? resolveLaunchSettings({ env })
    : { ...defaultLaunchSettings(), ...storedSettings, ...readEnvironmentSettings(launchEnvironment(env)) };
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    throw toParseError(error);
  }

  if (values.help) {
    return { help: true };
  }

  if (positionals.length > 0) {
    throw new Error(
      `Unexpected argument(s): ${positionals.join(" ")}\nUse --help to see available options.`,
    );
  }

  return {
    help: false,
    port: normalizePort(values.port === undefined ? String(stored.port) : values.port),
    hostname: values.hostname === undefined ? String(stored.hostname) : values.hostname,
    // `--no-open` still turns the browser off for one run, whatever the file says.
    openBrowser: !values["no-open"] && stored.openBrowser !== false,
  };
}

module.exports = { parseCommandLine, parseLaunchOptions, getHelpText };
