import { NextRequest, NextResponse } from "next/server";
import {
  timeInOutJobStatusSchema,
  timeInOutRequestSchema,
  timeInOutResultSchema,
} from "@/lib/time-in-out";
import { DEFAULT_TIME_IN, DEFAULT_TIME_OUT } from "@/lib/kernel/client";
import { getTimeInOutJob, startTimeInOutJob } from "@/lib/kernel/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
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
    // Use defaults if the body is empty.
  }

  const job = startTimeInOutJob(timeIn, timeOut);
  return NextResponse.json(timeInOutJobStatusSchema.parse(job), { status: 202 });
}

export async function GET(req: NextRequest) {
  const authError = authenticate(req);
  if (authError) return authError;

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json(
      timeInOutResultSchema.parse({
        success: false,
        error: "Missing jobId query parameter.",
      }),
      { status: 400 },
    );
  }

  const job = getTimeInOutJob(jobId);
  if (!job) {
    return NextResponse.json(
      timeInOutResultSchema.parse({
        success: false,
        error: "Job not found or expired.",
      }),
      { status: 404 },
    );
  }

  return NextResponse.json(timeInOutJobStatusSchema.parse(job));
}

function authenticate(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const apiSecret = process.env.API_SECRET;

  if (isSameOriginRequest(req)) {
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

  const requestHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  if (!requestHost) return false;

  return originHost === requestHost;
}