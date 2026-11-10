# Settings › Server and the launch settings file

## The file

Settings › Server edits `<agent-dir>/pi-web-launch.json`, beside pi's own files. `bin/launch-settings.js` defines every field once (`LAUNCH_SETTING_FIELDS`): its kind, the environment variable it stands in for, and its default. The launcher (`bin/pi-web.js`) requires that module directly, and `lib/launch-settings.ts` loads it through `createRequire` for the route, so a field the panel offers is a field the launcher understands. Add a setting there once, not in both places.

Only deliberate changes are stored: a value equal to the default (or an empty host-name list) is removed rather than written, so the file stays small and a hand-edit and a panel save produce the same bytes. Fields are written in the canonical order. A damaged file reads as empty instead of stopping the server: an unusable entry falls back to the default, and the panel shows what is in effect.

## Which layer wins

A command-line option, then an environment variable the operator set, then the file, then the default.

`resolveLaunchSettings()` implements that order, and `parseLaunchOptions()` applies `--port`, `--hostname` and `--no-open` on top. **The CLI layer must not read `env.PORT` or `env.PI_WEB_HOSTNAME` directly.** It used to, and the environment layer now lives inside `resolveLaunchSettings`; reading it twice would let a shell's or a dev server's `PORT` override the saved port without the operator meaning it to.

### Why the launcher records the operator's variables

`PI_WEB_LAUNCH_FIXED_VARS` holds the comma-separated names of the launch variables that were already set when `pi-web` started, before the launcher added any of its own. Only those count as "fixed by the environment".

Without that record every setting would look environment-fixed to the server:

- the launcher always exports `PI_WEB_HOSTNAME` to Next.js, so `--hostname` would lock the field;
- `instrumentation-node.ts` defaults `PI_CODEMODE_MAX_WORKERS`, so the worker count would lock itself;
- a dev server's environment has Next's own `PORT`, so the port would lock there, too.

A process that never went through the launcher (a `next dev`, a bare `next start`) has no record, and then **no** variable counts: its environment says nothing about this file. This is why the panel is fully editable under `npm run dev`.

A recorded variable with an unusable value fails the launch (`Invalid PORT: …`) rather than quietly keeping the file's value: running a port the operator did not choose is worse than not starting.

## What a saved setting becomes on start

The launcher exports the file's values into the server's environment before spawning Next.js, unless the operator already set that variable:

| Setting | Variable exported |
| --- | --- |
| `port`, `hostname` | Next's `-p` / `-H` arguments |
| `openBrowser` | `PI_WEB_NO_OPEN=1` when off |
| `allowedHosts` | `PI_WEB_ALLOWED_HOSTS` (comma-joined) |
| `appName` | `PI_WEB_APP_NAME` |
| `idleTimeoutMs` | `PI_WEB_IDLE_TIMEOUT_MS` |
| `shutdownDeadlineMs` | `PI_WEB_SHUTDOWN_DEADLINE_MS` |
| `codemodeMaxWorkers` | `PI_CODEMODE_MAX_WORKERS` |
| `skipVersionCheck` | `PI_WEB_SKIP_VERSION_CHECK=1` when on |

`PI_WEB_PASSWORD` has no setting on purpose: a password typed into a web form would be written in clear text to a file that the very interface it protects can be read from, and an unauthenticated visitor could change it. It stays an environment variable.

Durations are stored in milliseconds, as pi reads them, and shown in the unit a person sets them in (minutes for the idle timeout, seconds for the shutdown deadline). A blank or unparsable duration is sent as `NaN` so the route refuses it with a reason instead of saving a zero nobody asked for.

## The route and the panel

`PUT /api/launch-settings` takes a partial object, checks every key against the field list, validates each value, and refuses a setting an environment variable fixes rather than accepting a write that would not take effect. A value the caller must correct answers 400 (`LaunchSettingsRefusedError`); a failed file write answers 500.

`components/ServerConfig.tsx` is a plain form: it loads `GET /api/launch-settings`, drafts the values, and saves only the fields that changed. It never restarts the server, and it says so under **This server**. The panel is not a project section (`lib/settings-navigation.ts`): it configures the server the page is served by, whatever project is open.
