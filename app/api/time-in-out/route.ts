import { NextRequest, NextResponse } from "next/server";
import { timeInOutRequestSchema, timeInOutResultSchema } from "@/lib/time-in-out";
import { runTimeInOut, DEFAULT_TIME_IN, DEFAULT_TIME_OUT } from "@/lib/kernel/client";

/**
 * POST /api/time-in-out
 *
 * Triggers the HRM daily time-in/out automation via Kernel.sh.
 *
 * Optional JSON body:
 *   { "timeIn": "08:00", "timeOut": "16:00" }
 *
 * Protected by CRON_SECRET when called from Vercel Cron Jobs
 * (Authorization: Bearer <CRON_SECRET>), or by API_SECRET for
 * direct API calls (x-api-secret header).
 */
export async function POST(req: NextRequest) {
  // Authenticate the request
  const authError = authenticate(req);
  if (authError) return authError;

  let timeIn = DEFAULT_TIME_IN;
  let timeOut = DEFAULT_TIME_OUT;

  try {
    const body = await req.json().catch(() => ({}));
    const parsedBody = timeInOutRequestSchema.safeParse(body);

    if (!parsedBody.success) {
      return NextResponse.json(
        timeInOutResultSchema.parse({
          success: false,
          error: "Invalid request body. Expected HH:MM time values.",
        }),
        { status: 400 },
      );
    }

    if (parsedBody.data.timeIn) timeIn = parsedBody.data.timeIn;
    if (parsedBody.data.timeOut) timeOut = parsedBody.data.timeOut;
  } catch {
    // No body is fine — use defaults
  }

  try {
    const result = await runTimeInOut(timeIn, timeOut);

    if (!result.success) {
      return NextResponse.json(
        timeInOutResultSchema.parse({
          success: false,
          error: result.error,
          replayId: result.replayId,
          replayViewUrl: result.replayViewUrl,
          browserLiveViewUrl: result.browserLiveViewUrl,
          headless: result.headless,
          pageUrl: result.pageUrl,
        }),
        { status: 422 },
      );
    }

    return NextResponse.json(timeInOutResultSchema.parse({
      success: true,
      timeIn,
      timeOut,
      foundTimeInOutButton: result.foundTimeInOutButton,
      buttonHtml: result.buttonHtml,
      modalHtml: result.modalHtml,
      pageUrl: result.pageUrl,
      replayId: result.replayId,
      replayViewUrl: result.replayViewUrl,
      browserLiveViewUrl: result.browserLiveViewUrl,
      headless: result.headless,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      timeInOutResultSchema.parse({ success: false, error: message }),
      { status: 500 },
    );
  }
}

/**
 * GET /api/time-in-out
 *
 * Same as POST but used by Vercel Cron Jobs (which send GET requests).
 */
export async function GET(req: NextRequest) {
  const authError = authenticate(req);
  if (authError) return authError;

  try {
    const result = await runTimeInOut();

    if (!result.success) {
      return NextResponse.json(
        timeInOutResultSchema.parse({
          success: false,
          error: result.error,
          replayId: result.replayId,
          replayViewUrl: result.replayViewUrl,
          browserLiveViewUrl: result.browserLiveViewUrl,
          headless: result.headless,
          pageUrl: result.pageUrl,
        }),
        { status: 422 },
      );
    }

    return NextResponse.json(timeInOutResultSchema.parse({
      success: true,
      timeIn: DEFAULT_TIME_IN,
      timeOut: DEFAULT_TIME_OUT,
      foundTimeInOutButton: result.foundTimeInOutButton,
      buttonHtml: result.buttonHtml,
      modalHtml: result.modalHtml,
      pageUrl: result.pageUrl,
      replayId: result.replayId,
      replayViewUrl: result.replayViewUrl,
      browserLiveViewUrl: result.browserLiveViewUrl,
      headless: result.headless,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      timeInOutResultSchema.parse({ success: false, error: message }),
      { status: 500 },
    );
  }
}

/**
 * Validate incoming requests.
 *
 * Accepts either:
 *   - Vercel Cron: `Authorization: Bearer <CRON_SECRET>`
 *   - Direct API:  `x-api-secret: <API_SECRET>`
 *
 * Returns a 401 response on failure, or null when authenticated.
 */
function authenticate(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const apiSecret = process.env.API_SECRET;

  // Allow manual runs from the app UI (same-origin browser requests).
  if (isSameOriginRequest(req)) {
    return null;
  }

  // Vercel Cron authentication
  if (cronSecret) {
    const authHeader = req.headers.get("authorization") ?? "";
    if (authHeader === `Bearer ${cronSecret}`) return null;
  }

  // Direct API secret authentication
  if (apiSecret) {
    const headerSecret = req.headers.get("x-api-secret") ?? "";
    if (headerSecret === apiSecret) return null;
  }

  // Allow unauthenticated access only when neither secret is configured
  // (e.g. during local development without secrets set up)
  if (!cronSecret && !apiSecret) return null;

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function isSameOriginRequest(req: NextRequest): boolean {
  const originHeader = req.headers.get("origin");
  if (!originHeader) return false;

  let originHost: string;
  try {
    originHost = new URL(originHeader).host;
  } catch {
    return false;
  }

  const requestHost =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";

  if (!requestHost) return false;

  return originHost === requestHost;
}
