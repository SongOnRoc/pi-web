"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { LaunchSettingsResponse } from "@/lib/api-types";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

// Settings › Server: the launch settings the pi-web launcher reads from
// `<agent-dir>/pi-web-launch.json` (bin/launch-settings.js). They take effect
// the next time the server starts; nothing here restarts it.

/** A form field's draft value, as the input holds it. */
interface Draft {
  port: string;
  hostname: string;
  openBrowser: boolean;
  allowedHosts: string;
  appName: string;
  idleTimeoutMinutes: string;
  shutdownDeadlineSeconds: string;
  codemodeMaxWorkers: string;
  skipVersionCheck: boolean;
}

const EMPTY_DRAFT: Draft = {
  port: "",
  hostname: "",
  openBrowser: true,
  allowedHosts: "",
  appName: "",
  idleTimeoutMinutes: "",
  shutdownDeadlineSeconds: "",
  codemodeMaxWorkers: "",
  skipVersionCheck: false,
};

function toDraft(values: LaunchSettingsResponse["values"]): Draft {
  return {
    port: values.port,
    hostname: values.hostname,
    openBrowser: values.openBrowser,
    allowedHosts: values.allowedHosts.join(", "),
    appName: values.appName,
    // Durations are stored in milliseconds, as pi reads them, and shown in the
    // unit a person sets them in.
    idleTimeoutMinutes: String(Math.round(values.idleTimeoutMs / 60_000)),
    shutdownDeadlineSeconds: String(Math.round(values.shutdownDeadlineMs / 1_000)),
    codemodeMaxWorkers: String(values.codemodeMaxWorkers),
    skipVersionCheck: values.skipVersionCheck,
  };
}

/** The settings a draft changed, in the shapes `PUT /api/launch-settings` takes. */
function toChanges(draft: Draft, values: LaunchSettingsResponse["values"]): Record<string, unknown> {
  const changes: Record<string, unknown> = {};

  if (draft.port !== values.port) changes.port = draft.port.trim();
  if (draft.hostname !== values.hostname) changes.hostname = draft.hostname.trim();
  if (draft.openBrowser !== values.openBrowser) changes.openBrowser = draft.openBrowser;
  if (draft.skipVersionCheck !== values.skipVersionCheck) changes.skipVersionCheck = draft.skipVersionCheck;

  const allowedHosts = draft.allowedHosts.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (allowedHosts.join(",") !== values.allowedHosts.join(",")) changes.allowedHosts = allowedHosts;

  const appName = draft.appName.trim();
  if (appName !== values.appName) changes.appName = appName;

  // A blank or unparsable duration is sent as NaN so the route refuses it with
  // the reason, rather than saving a zero the user did not ask for.
  const idleTimeoutMinutes = Number(draft.idleTimeoutMinutes);
  const idleTimeoutMs = draft.idleTimeoutMinutes.trim() === "" ? Number.NaN : Math.round(idleTimeoutMinutes * 60_000);
  if (idleTimeoutMs !== values.idleTimeoutMs) changes.idleTimeoutMs = idleTimeoutMs;

  const shutdownDeadlineSeconds = Number(draft.shutdownDeadlineSeconds);
  const shutdownDeadlineMs = draft.shutdownDeadlineSeconds.trim() === ""
    ? Number.NaN
    : Math.round(shutdownDeadlineSeconds * 1_000);
  if (shutdownDeadlineMs !== values.shutdownDeadlineMs) changes.shutdownDeadlineMs = shutdownDeadlineMs;

  const codemodeMaxWorkers = Number(draft.codemodeMaxWorkers);
  if (codemodeMaxWorkers !== values.codemodeMaxWorkers) {
    changes.codemodeMaxWorkers = draft.codemodeMaxWorkers.trim() === "" ? Number.NaN : codemodeMaxWorkers;
  }

  return changes;
}

interface Props {
  onClose: () => void;
}

export function ServerConfig({ onClose }: Props) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<LaunchSettingsResponse | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/launch-settings", { cache: "no-store", signal });
      const data = await response.json() as LaunchSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSettings(data);
      setDraft(toDraft(data.values));
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    if (!settings || saving) return;
    const changes = toChanges(draft, settings.values);
    if (Object.keys(changes).length === 0) {
      setSaved(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/launch-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await response.json() as LaunchSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setSettings(data);
      setDraft(toDraft(data.values));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const locked = new Set(settings?.environmentKeys ?? []);
  const field = (
    key: string,
    label: string,
    input: React.ReactNode,
    description?: string,
  ) => (
    <div className="settings-server-field" key={key}>
      <label className="settings-server-label" htmlFor={`settings-server-${key}`}>{label}</label>
      {input}
      {locked.has(key) && <p className="settings-server-note">{t("settings.server.environmentLocked")}</p>}
      {description && <p className="settings-server-hint">{description}</p>}
    </div>
  );

  const textInput = (
    key: keyof Draft,
    type: "text" | "number" = "text",
    extra: Record<string, unknown> = {},
  ) => (
    <input
      id={`settings-server-${key}`}
      className="settings-server-input"
      type={type}
      value={String(draft[key])}
      disabled={loading || saving || locked.has(key)}
      onChange={(event) => update(key, event.target.value as Draft[typeof key])}
      {...extra}
    />
  );

  return (
    <div className="settings-server">
      {loading && <p className="settings-server-hint">{t("settings.server.loading")}</p>}

      {settings && (
        <>
          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.server.network")}</h3>
            <p className="settings-general-description">{t("settings.server.networkDescription")}</p>
            <div className="settings-server-fields">
              {field(
                "port",
                t("settings.server.port"),
                textInput("port", "number", { min: 0, max: 65535, step: 1 }),
                t("settings.server.portHint"),
              )}
              {field(
                "hostname",
                t("settings.server.hostname"),
                textInput("hostname"),
                t("settings.server.hostnameHint"),
              )}
              {field(
                "allowedHosts",
                t("settings.server.allowedHosts"),
                textInput("allowedHosts"),
                t("settings.server.allowedHostsHint"),
              )}
            </div>
            <div className="settings-chat-options">
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("settings.server.openBrowser")}</span>
                <ConfigSwitch
                  checked={draft.openBrowser}
                  disabled={loading || saving || locked.has("openBrowser")}
                  label={t("settings.server.openBrowser")}
                  onChange={(enabled) => update("openBrowser", enabled)}
                />
              </div>
            </div>
            <p className="settings-server-hint">{t("settings.server.openBrowserHint")}</p>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.server.runtime")}</h3>
            <p className="settings-general-description">{t("settings.server.runtimeDescription")}</p>
            <div className="settings-server-fields">
              {field(
                "appName",
                t("settings.server.appName"),
                textInput("appName"),
                t("settings.server.appNameHint"),
              )}
              {field(
                "idleTimeoutMinutes",
                t("settings.server.idleTimeout"),
                textInput("idleTimeoutMinutes", "number", { min: 0, step: 1 }),
                t("settings.server.idleTimeoutHint"),
              )}
              {field(
                "shutdownDeadlineSeconds",
                t("settings.server.shutdownDeadline"),
                textInput("shutdownDeadlineSeconds", "number", { min: 1, step: 1 }),
                t("settings.server.shutdownDeadlineHint"),
              )}
              {field(
                "codemodeMaxWorkers",
                t("settings.server.codemodeMaxWorkers"),
                textInput("codemodeMaxWorkers", "number", { min: 1, max: 64, step: 1 }),
                t("settings.server.codemodeMaxWorkersHint"),
              )}
            </div>
            <div className="settings-chat-options">
              <div className="settings-chat-option settings-chat-switch-option">
                <span>{t("settings.server.skipVersionCheck")}</span>
                <ConfigSwitch
                  checked={draft.skipVersionCheck}
                  disabled={loading || saving || locked.has("skipVersionCheck")}
                  label={t("settings.server.skipVersionCheck")}
                  onChange={(enabled) => update("skipVersionCheck", enabled)}
                />
              </div>
            </div>
          </section>

          <section className="settings-general-section">
            <h3 className="settings-general-heading">{t("settings.server.current")}</h3>
            <div className="settings-server-current">
              <span>{t("settings.server.currentUrl")}</span>
              <code>{settings.url ?? t("settings.server.portZero")}</code>
            </div>
            <p className="settings-server-hint">{t("settings.server.filePath")} <code>{settings.path}</code></p>
            <p className="settings-server-hint">{t("settings.server.restartNotice")}</p>
          </section>

          <div className="settings-server-actions">
            <ConfigButton disabled={saving || loading} onClick={() => void save()}>
              {saving ? t("settings.server.saving") : t("settings.server.save")}
            </ConfigButton>
            <ConfigButton variant="ghost" disabled={saving} onClick={onClose}>
              {t("i18n.close")}
            </ConfigButton>
            {saved && <span role="status" className="settings-server-saved">{t("settings.server.saved")}</span>}
          </div>
          {error && <p role="alert" className="settings-general-error">{error}</p>}
        </>
      )}
    </div>
  );
}
