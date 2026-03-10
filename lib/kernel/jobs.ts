import { randomUUID } from "crypto";
import {
  timeInOutJobStatusSchema,
  timeInOutResultSchema,
  type TimeInOutJobStatus,
} from "@/lib/time-in-out";
import { runTimeInOut } from "./client";

const globalJobs = globalThis as typeof globalThis & {
  __timeInOutJobs?: Map<string, TimeInOutJobStatus>;
};

const jobs = globalJobs.__timeInOutJobs ?? (globalJobs.__timeInOutJobs = new Map());

function toReadOnlyLiveViewUrl(url?: string): string | undefined {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("read_only");
    parsed.searchParams.set("readOnly", "true");
    return parsed.toString();
  } catch {
    return url;
  }
}

function setJob(job: TimeInOutJobStatus): TimeInOutJobStatus {
  const parsed = timeInOutJobStatusSchema.parse(job);
  jobs.set(parsed.jobId, parsed);
  return parsed;
}

export function startTimeInOutJob(timeIn: string, timeOut: string): TimeInOutJobStatus {
  const jobId = randomUUID();

  setJob({
    jobId,
    status: "starting",
  });

  void runTimeInOut(timeIn, timeOut, {
    onSessionReady(session) {
      const current = jobs.get(jobId);
      if (!current) return;

      setJob({
        ...current,
        status: "running",
        browserLiveViewUrl: toReadOnlyLiveViewUrl(session.browserLiveViewUrl),
        replayId: session.replayId,
        replayViewUrl: session.replayViewUrl,
        replayError: session.replayError,
        headless: session.headless,
      });
    },
  })
    .then((result) => {
      const current = jobs.get(jobId);
      setJob({
        jobId,
        status: result.success ? "completed" : "failed",
        browserLiveViewUrl:
          current?.browserLiveViewUrl ?? toReadOnlyLiveViewUrl(result.browserLiveViewUrl),
        replayId: result.replayId,
        replayViewUrl: result.replayViewUrl,
        replayError: result.replayError,
        headless: result.headless,
        result,
      });
    })
    .catch((error) => {
      const current = jobs.get(jobId);
      const message = error instanceof Error ? error.message : String(error);

      setJob({
        jobId,
        status: "failed",
        browserLiveViewUrl: toReadOnlyLiveViewUrl(current?.browserLiveViewUrl),
        replayId: current?.replayId,
        replayViewUrl: current?.replayViewUrl,
        replayError: current?.replayError,
        headless: current?.headless,
        result: timeInOutResultSchema.parse({
          success: false,
          browserLiveViewUrl: toReadOnlyLiveViewUrl(current?.browserLiveViewUrl),
          replayId: current?.replayId,
          replayViewUrl: current?.replayViewUrl,
          replayError: current?.replayError,
          headless: current?.headless,
          error: message,
        }),
      });
    })
    .finally(() => {
      setTimeout(() => {
        jobs.delete(jobId);
      }, 1000 * 60 * 30);
    });

  return jobs.get(jobId)!;
}

export function getTimeInOutJob(jobId: string): TimeInOutJobStatus | null {
  return jobs.get(jobId) ?? null;
}