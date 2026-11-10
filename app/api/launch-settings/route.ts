import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  LAUNCH_SETTING_KEYS,
  LaunchSettingsRefusedError,
  readLaunchSettings,
  saveLaunchSettings,
} from "@/lib/launch-settings";

export const dynamic = "force-dynamic";

// Settings › Server: the launch settings the launcher reads from
// `<agent-dir>/pi-web-launch.json`. They take effect at the next start, and the
// panel says so; nothing here restarts the running server.

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function errorResponse(error: unknown) {
  return refusal(500, error instanceof Error ? error.message : String(error));
}

export async function GET() {
  try {
    return NextResponse.json(readLaunchSettings());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return refusal(403, "Untrusted API request");
  }
  if (!hasJsonContentType(req)) {
    return refusal(415, "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return refusal(400, "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refusal(400, "Expected a JSON object");
  }

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!LAUNCH_SETTING_KEYS.includes(key)) {
      return refusal(400, `Unknown setting: ${key}`);
    }
    changes[key] = value;
  }
  if (Object.keys(changes).length === 0) {
    return refusal(400, "No settings to save");
  }

  try {
    return NextResponse.json(saveLaunchSettings(changes));
  } catch (error) {
    // A setting that cannot be used is the caller's to correct, not a server fault.
    if (error instanceof LaunchSettingsRefusedError) return refusal(400, error.message);
    return errorResponse(error);
  }
}
