import { NextRequest, NextResponse } from "next/server";
import { timeInOutRequestSchema, timeInOutResultSchema } from "@/lib/time-in-out";
import { runTimeInOut, DEFAULT_TIME_IN, DEFAULT_TIME_OUT } from "@/lib/kernel/client";
import { authenticateRequest } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const authError = authenticateRequest(req);
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
          executionLog: result.executionLog,
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
      executionLog: result.executionLog,
      agentResponse: result.agentResponse,
      foundTimeInOutButton: result.foundTimeInOutButton,
      pageUrl: result.pageUrl,
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
  const authError = authenticateRequest(req);
  if (authError) return authError;

  try {
    const result = await runTimeInOut();

    if (!result.success) {
      return NextResponse.json(
        timeInOutResultSchema.parse({
          success: false,
          error: result.error,
          executionLog: result.executionLog,
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
      executionLog: result.executionLog,
      agentResponse: result.agentResponse,
      foundTimeInOutButton: result.foundTimeInOutButton,
      pageUrl: result.pageUrl,
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

