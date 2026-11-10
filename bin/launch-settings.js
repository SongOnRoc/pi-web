"use strict";

// The launch settings Pi Web's CLI accepts, and the ones the web UI writes to
// `<agent-dir>/pi-web-launch.json`. The launcher (`bin/pi-web.js`) and the API
// route behind Settings › Server read this one file, so a field the UI offers
// is a field the launcher understands.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isIP } = require("node:net");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fileURLToPath } = require("node:url");

const LAUNCH_SETTINGS_VERSION = 1;
const DEFAULT_PORT = "30141";
const DEFAULT_HOSTNAME = "127.0.0.1";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Every stored launch setting, in the order Settings › Server lists them.
 *
 * `env` is the environment variable the setting stands in for, so the file and
 * the environment describe the same handful of things; `flag` is the CLI option
 * that overrides both. A setting held only in the file has no `env`.
 */
const LAUNCH_SETTING_FIELDS = [
  {
    key: "port",
    kind: "port",
    env: "PORT",
    flag: "--port",
    // Every layer starts at the same default, so a stored value equal to it is
    // not written; `0` is kept, since it asks the OS for a free port.
    defaultValue: DEFAULT_PORT,
  },
  {
    key: "hostname",
    kind: "hostname",
    env: "PI_WEB_HOSTNAME",
    flag: "--hostname",
    defaultValue: DEFAULT_HOSTNAME,
  },
  {
    key: "openBrowser",
    kind: "boolean",
    env: "PI_WEB_NO_OPEN",
    /** The environment spells this one backwards: `PI_WEB_NO_OPEN=1` turns the browser off. */
    envInverted: true,
    flag: "--no-open",
    defaultValue: true,
  },
  {
    key: "allowedHosts",
    kind: "hostnameList",
    env: "PI_WEB_ALLOWED_HOSTS",
    defaultValue: [],
  },
  {
    key: "appName",
    kind: "text",
    env: "PI_WEB_APP_NAME",
    defaultValue: "",
    maxLength: 60,
  },
  {
    key: "idleTimeoutMs",
    kind: "duration",
    env: "PI_WEB_IDLE_TIMEOUT_MS",
    defaultValue: 600_000,
  },
  {
    key: "shutdownDeadlineMs",
    kind: "duration",
    env: "PI_WEB_SHUTDOWN_DEADLINE_MS",
    defaultValue: 5_000,
  },
  {
    key: "codemodeMaxWorkers",
    kind: "integer",
    env: "PI_CODEMODE_MAX_WORKERS",
    defaultValue: 8,
    min: 1,
    max: 64,
  },
  {
    key: "skipVersionCheck",
    kind: "boolean",
    env: "PI_WEB_SKIP_VERSION_CHECK",
    defaultValue: false,
  },
];

const FIELDS_BY_KEY = new Map(LAUNCH_SETTING_FIELDS.map((field) => [field.key, field]));

/** Node's timer limit, which every duration must stay within. */
const MAX_DURATION_MS = 2_147_483_647;

// A hostname the server can bind: an IPv4/IPv6 literal, or a DNS name it can
// resolve. Anything with a scheme, port, path or blank is refused here rather
// than left for Next to fail on. IPv6 literals lead and trail with `:`, so the
// literal case is checked before the label rules apply.
const DNS_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/;

function getAgentDir(env = process.env, home = os.homedir()) {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(home, ".pi", "agent");
  if (configured === "~") return home;
  if (configured.startsWith("~/") || configured.startsWith("~\\")) return path.join(home, configured.slice(2));
  if (configured.startsWith("file://")) return fileURLToPath(configured);
  return configured;
}

/** The file the web UI writes and the launcher reads before it starts. */
function getLaunchSettingsPath(env = process.env, home = os.homedir()) {
  return path.join(getAgentDir(env, home), "pi-web-launch.json");
}

function isPort(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  const port = Number(value);
  return Number.isSafeInteger(port) && port <= 65535;
}

function isHostname(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;
  if (isIP(trimmed) !== 0) return true;
  // `localhost` and ordinary DNS names; a trailing dot is valid but never
  // reaches Next.js usefully, so it is refused with the other odd forms.
  return trimmed.split(".").every((label) => label.length <= 63 && DNS_LABEL.test(label));
}

function splitHostnames(value) {
  if (typeof value !== "string") return [];
  const seen = new Set();
  const hostnames = [];
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    hostnames.push(trimmed);
  }
  return hostnames;
}

function isDuration(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DURATION_MS;
}

function isIntegerInRange(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isTruthyEnvValue(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * One setting's value, normalized, or `{ error }` when it cannot be used.
 * `undefined` means "not set", which the caller resolves through the layers.
 * @param {string} key
 * @param {unknown} value
 * @returns {{ value?: unknown, error?: string }}
 */
function normalizeValue(key, value) {
  const field = FIELDS_BY_KEY.get(key);
  if (!field) return { error: `Unknown setting: ${key}` };
  if (value === undefined) return {};

  switch (field.kind) {
    case "port": {
      const text = typeof value === "number" ? String(value) : value;
      return isPort(text) ? { value: text } : { error: "Port must be a non-negative integer." };
    }
    case "hostname": {
      return isHostname(value) ? { value: String(value).trim() } : { error: "Enter a bind IP address or host name." };
    }
    case "hostnameList": {
      const entries = Array.isArray(value) ? value : splitHostnames(value);
      const hostnames = [];
      for (const entry of entries) {
        if (!isHostname(entry)) return { error: `Not a host name: ${String(entry).slice(0, 80)}` };
        if (!hostnames.includes(String(entry).trim())) hostnames.push(String(entry).trim());
      }
      return { value: hostnames };
    }
    case "boolean":
      return typeof value === "boolean" ? { value } : { error: "Must be true or false." };
    case "text": {
      if (typeof value !== "string") return { error: "Must be text." };
      const text = value.trim();
      if (text.length > (field.maxLength ?? 200)) return { error: `Must be at most ${field.maxLength ?? 200} characters.` };
      return { value: text };
    }
    case "duration":
      return isDuration(value)
        ? { value }
        : { error: `Must be a whole number of milliseconds from 0 to ${MAX_DURATION_MS}.` };
    case "integer":
      return isIntegerInRange(value, field.min, field.max)
        ? { value }
        : { error: `Must be a whole number from ${field.min} to ${field.max}.` };
    default:
      return { error: `Unknown setting: ${key}` };
  }
}

/**
 * The settings a file holds, ignoring anything it cannot use. A damaged file
 * must not stop the server, so an unusable entry falls back to the defaults
 * instead of raising: the launcher starts, and the UI shows the default.
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function normalizeStoredSettings(raw) {
  const stored = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return stored;
  for (const field of LAUNCH_SETTING_FIELDS) {
    const { value } = normalizeValue(field.key, raw[field.key]);
    if (value !== undefined) stored[field.key] = value;
  }
  return stored;
}

/** Reads the launch settings file; a missing or damaged file reads as empty. */
function readLaunchSettingsFile(settingsPath = getLaunchSettingsPath()) {
  let text;
  try {
    text = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return {};
  }
  try {
    return normalizeStoredSettings(JSON.parse(text));
  } catch {
    return {};
  }
}

/**
 * What the environment says about each setting, in the settings' own terms.
 * Only variables that are actually set appear, so an empty value stays a
 * deliberate choice rather than a fall-through to the file.
 * @param {NodeJS.ProcessEnv} env
 */
function readEnvironmentSettings(env = process.env) {
  const settings = {};
  for (const field of LAUNCH_SETTING_FIELDS) {
    if (!field.env || !Object.hasOwn(env, field.env)) continue;
    const raw = env[field.env];

    if (field.kind === "boolean") {
      if (field.envInverted) settings[field.key] = !isTruthyEnvValue(raw);
      else settings[field.key] = isTruthyEnvValue(raw);
      continue;
    }
    if (field.kind === "duration") {
      // pi treats `0` as "off" for the idle timeout; a blank value is unset.
      if (typeof raw === "string" && raw.trim() !== "") {
        const parsed = Number(raw);
        if (isDuration(parsed)) settings[field.key] = parsed;
      }
      continue;
    }
    if (field.kind === "integer") {
      if (typeof raw === "string" && raw.trim() !== "") {
        const parsed = Number(raw);
        if (isIntegerInRange(parsed, field.min, field.max)) settings[field.key] = parsed;
      }
      continue;
    }
    const { value, error } = normalizeValue(field.key, raw);
    if (error) throw new Error(`Invalid ${field.env}: ${error}`);
    if (value !== undefined) settings[field.key] = value;
  }
  return settings;
}

/** Every setting at its default, so a partial set of overrides stays complete. */
function defaultLaunchSettings() {
  const defaults = {};
  for (const field of LAUNCH_SETTING_FIELDS) {
    defaults[field.key] = Array.isArray(field.defaultValue) ? [...field.defaultValue] : field.defaultValue;
  }
  return defaults;
}

/**
 * The launch settings in effect: defaults, then the file, then the variables
 * the operator set, since one set for a run (or by a container) is meant to win
 * for that run. CLI options are applied on top by the launcher itself.
 *
 * Only the variables the launcher recorded count. A process that did not go
 * through the launcher (a dev server, a bare `next start`) has no record, and
 * its own PORT or PI_WEB_HOSTNAME is then not a statement about this file.
 * @param {{ settingsPath?: string, env?: NodeJS.ProcessEnv }} [options]
 */
function resolveLaunchSettings({ settingsPath, env = process.env } = {}) {
  const stored = readLaunchSettingsFile(settingsPath ?? getLaunchSettingsPath(env));
  const fromEnvironment = readEnvironmentSettings(launchEnvironment(env));
  return { ...defaultLaunchSettings(), ...stored, ...fromEnvironment };
}

/**
 * The variables the launcher records for Settings › Server, holding the ones
 * the operator set before pi-web added any of its own. Without that record,
 * every setting would look environment-fixed to the server: the launcher
 * always exports PI_WEB_HOSTNAME for Next, and `instrumentation-node` defaults
 * PI_CODEMODE_MAX_WORKERS.
 */
const FIXED_VARS_ENV = "PI_WEB_LAUNCH_FIXED_VARS";

/** Every variable that can fix a launch setting, as the launcher lists them. */
const OPERATOR_LAUNCH_ENV_VARS = LAUNCH_SETTING_FIELDS
  .map((field) => field.env)
  .filter((name) => typeof name === "string");

/**
 * The variables the operator set before pi-web added any of its own, as the
 * launcher recorded them. Absent means nothing recorded, which is the case for
 * a bare `next start` and for a dev server: the variables in such a process's
 * environment (Next's own PORT, a shell's PI_WEB_HOSTNAME) are not choices
 * about the launch settings file, so they neither override it nor lock it.
 */
function recordedEnvironmentVars(env = process.env) {
  const recorded = env[FIXED_VARS_ENV];
  return new Set(typeof recorded === "string" ? recorded.split(",").filter(Boolean) : []);
}

/** The settings an environment variable fixes, which the UI cannot override. */
function environmentLockedKeys(env = process.env) {
  const recorded = recordedEnvironmentVars(env);
  return LAUNCH_SETTING_FIELDS
    .filter((field) => field.env && recorded.has(field.env))
    .map((field) => field.key);
}

/**
 * The environment as it speaks about the launch settings: only the variables
 * the operator set, so a dev server's own PORT does not read as a setting.
 *
 * The values are kept as they are, unvalidated: a recorded variable that
 * cannot be used must fail the launch loudly rather than quietly fall back to
 * a default the operator did not choose. `readEnvironmentSettings` is what
 * decides whether a value is usable.
 */
function launchEnvironment(env = process.env) {
  const recorded = recordedEnvironmentVars(env);
  const subset = {};
  for (const field of LAUNCH_SETTING_FIELDS) {
    if (field.env && recorded.has(field.env)) subset[field.env] = env[field.env];
  }
  return subset;
}

/**
 * Writes the launch settings the UI chose. A value equal to the default is
 * dropped rather than stored, so a file holds only deliberate changes.
 * @param {Record<string, unknown>} changes
 * @param {{ settingsPath?: string, env?: NodeJS.ProcessEnv }} [options]
 */
function writeLaunchSettings(changes, { settingsPath, env = process.env } = {}) {
  const target = settingsPath ?? getLaunchSettingsPath(env);
  const stored = { ...readLaunchSettingsFile(target) };

  for (const [key, raw] of Object.entries(changes ?? {})) {
    const field = FIELDS_BY_KEY.get(key);
    if (!field) throw new Error(`Unknown setting: ${key}`);
    const { value, error } = normalizeValue(key, raw);
    if (error) throw new Error(error);

    const isDefault = field.kind === "hostnameList"
      ? value.length === 0
      : value === field.defaultValue;
    if (isDefault) delete stored[key];
    else stored[key] = value;
  }

  // Keep the fields in the canonical order, so a hand-edit and a UI write
  // produce the same file.
  const ordered = {};
  for (const field of LAUNCH_SETTING_FIELDS) {
    if (stored[field.key] !== undefined) ordered[field.key] = stored[field.key];
  }

  if (Object.keys(ordered).length === 0) {
    fs.rmSync(target, { force: true });
    return {};
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ version: LAUNCH_SETTINGS_VERSION, ...ordered }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return ordered;
}

/** The URL a browser on this machine opens for a bind address and port. */
function toOpenUrl(hostname, port) {
  let host = hostname;
  if (host === "0.0.0.0") host = "127.0.0.1";
  else if (host === "::" || host === "[::]") host = "::1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${port}`;
}

module.exports = {
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  FIXED_VARS_ENV,
  LAUNCH_SETTING_FIELDS,
  LAUNCH_SETTINGS_VERSION,
  LOOPBACK_HOSTNAMES,
  MAX_DURATION_MS,
  OPERATOR_LAUNCH_ENV_VARS,
  defaultLaunchSettings,
  environmentLockedKeys,
  getAgentDir,
  getLaunchSettingsPath,
  isDuration,
  isHostname,
  isPort,
  normalizeStoredSettings,
  normalizeValue,
  launchEnvironment,
  readEnvironmentSettings,
  readLaunchSettingsFile,
  resolveLaunchSettings,
  splitHostnames,
  toOpenUrl,
  writeLaunchSettings,
};
