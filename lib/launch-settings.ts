import { createRequire } from "node:module";
import type { LaunchSettingKey, LaunchSettingsResponse, LaunchSettingsValues } from "./api-types";

// Settings › Server reads and writes `<agent-dir>/pi-web-launch.json`, the file
// the launcher (`bin/pi-web.js`) reads before it starts Next.js. The format,
// its defaults and its checks live in `bin/launch-settings.js`, which the
// launcher requires directly, so both sides read one definition.

const require_ = createRequire(import.meta.url);
const launchSettings = require_("../bin/launch-settings.js") as {
  DEFAULT_HOSTNAME: string;
  DEFAULT_PORT: string;
  LAUNCH_SETTING_FIELDS: readonly { key: string; env?: string; defaultValue: unknown }[];
  environmentLockedKeys: (env?: NodeJS.ProcessEnv) => string[];
  getLaunchSettingsPath: (env?: NodeJS.ProcessEnv) => string;
  normalizeValue: (key: string, value: unknown) => { value?: unknown; error?: string };
  readLaunchSettingsFile: (settingsPath?: string) => Record<string, unknown>;
  resolveLaunchSettings: (options?: { settingsPath?: string; env?: NodeJS.ProcessEnv }) => Record<string, unknown>;
  toOpenUrl: (hostname: string, port: string) => string;
  writeLaunchSettings: (
    changes: Record<string, unknown>,
    options?: { settingsPath?: string; env?: NodeJS.ProcessEnv },
  ) => Record<string, unknown>;
};

/**
 * A launch setting the caller must correct (or that an environment variable
 * already fixes), as opposed to the file itself failing to be written. The
 * route answers 400 for this and 500 for anything else.
 */
export class LaunchSettingsRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchSettingsRefusedError";
  }
}

export const LAUNCH_SETTING_KEYS = launchSettings.LAUNCH_SETTING_FIELDS.map((field) => field.key);

/** The environment variable each setting stands in for, as the UI labels them. */
export const LAUNCH_SETTING_ENV: Readonly<Record<string, string | undefined>> = Object.fromEntries(
  launchSettings.LAUNCH_SETTING_FIELDS.map((field) => [field.key, field.env]),
);

export function getLaunchSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return launchSettings.getLaunchSettingsPath(env);
}

/**
 * The settings in effect: defaults, then the stored file, then the environment.
 * `environmentKeys` are the ones a variable already fixes, which the UI shows
 * as read-only because a value saved there would not take effect on restart.
 */
export function readLaunchSettings(
  { env = process.env, settingsPath }: { env?: NodeJS.ProcessEnv; settingsPath?: string } = {},
): LaunchSettingsResponse {
  const values = launchSettings.resolveLaunchSettings({ env, settingsPath }) as unknown as LaunchSettingsValues;
  const stored = launchSettings.readLaunchSettingsFile(settingsPath ?? launchSettings.getLaunchSettingsPath(env));
  const environmentLocked = launchSettings.environmentLockedKeys(env);
  return {
    values,
    stored,
    environmentKeys: environmentLocked,
    path: settingsPath ?? launchSettings.getLaunchSettingsPath(env),
    // The address a browser on this machine would open; port 0 is never known.
    url: values.port === "0" ? null : launchSettings.toOpenUrl(values.hostname, values.port),
  };
}

/**
 * Saves one or more launch settings. Values equal to the default are dropped
 * rather than stored, so the file holds only deliberate changes.
 * @throws {LaunchSettingsRefusedError} when the settings cannot be accepted
 */
export function saveLaunchSettings(
  changes: Partial<Record<LaunchSettingKey, unknown>>,
  { env = process.env, settingsPath }: { env?: NodeJS.ProcessEnv; settingsPath?: string } = {},
): LaunchSettingsResponse {
  const locked = new Set(launchSettings.environmentLockedKeys(env));
  const accepted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!launchSettings.LAUNCH_SETTING_FIELDS.some((field) => field.key === key)) {
      throw new LaunchSettingsRefusedError(`Unknown setting: ${key}`);
    }
    const { value: normalized, error } = launchSettings.normalizeValue(key, value);
    if (error) throw new LaunchSettingsRefusedError(error);
    if (locked.has(key)) {
      throw new LaunchSettingsRefusedError(`${key} is fixed by ${LAUNCH_SETTING_ENV[key]} for this process, so saving it would not take effect.`);
    }
    accepted[key] = normalized;
  }
  launchSettings.writeLaunchSettings(accepted, { env, settingsPath });
  return readLaunchSettings({ env, settingsPath });
}
