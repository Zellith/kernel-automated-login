import { NextRequest, NextResponse } from "next/server";

export function authenticateRequest(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const apiSecret = process.env.API_SECRET;

  if (isTrustedSameOriginRequest(req)) {
    return null;
  }

  if (cronSecret) {
    const authHeader = req.headers.get("authorization") ?? "";
    if (authHeader === `Bearer ${cronSecret}`) return null;
  }

  if (apiSecret) {
    const headerSecret = req.headers.get("x-api-secret") ?? "";
    if (headerSecret === apiSecret) return null;
  }

  if (!cronSecret && !apiSecret) {
    return null;
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function isTrustedSameOriginRequest(req: NextRequest): boolean {
  const requestHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  if (!requestHost) {
    return false;
  }

  const originHost = getHeaderHost(req.headers.get("origin"));
  if (originHost && originHost === requestHost) {
    return true;
  }

  const refererHost = getHeaderHost(req.headers.get("referer"));
  if (refererHost && refererHost === requestHost) {
    return true;
  }

  return req.headers.get("sec-fetch-site") === "same-origin";
}

function getHeaderHost(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}