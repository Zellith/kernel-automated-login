import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  timeInOutJobStatusSchema,
  timeInOutResultSchema,
  type TimeInOutJobStatus,
} from "@/lib/time-in-out";
import { runTimeInOut } from "./client";

const JOB_TTL_MS = 1000 * 60 * 30;
const JOBS_DIR = join(tmpdir(), "kernel-automated-login-jobs");

const globalJobs = globalThis as typeof globalThis & {
  __timeInOutJobs?: Map<string, TimeInOutJobStatus>;
};

const jobs = globalJobs.__timeInOutJobs ?? (globalJobs.__timeInOutJobs = new Map());

function ensureJobsDir(): void {
  if (!existsSync(JOBS_DIR)) {
    mkdirSync(JOBS_DIR, { recursive: true });
  }
}

function getJobFilePath(jobId: string): string {
  ensureJobsDir();
  return join(JOBS_DIR, `${jobId}.json`);
}

function writeJobToDisk(job: TimeInOutJobStatus): void {
  writeFileSync(getJobFilePath(job.jobId), JSON.stringify(job), "utf8");
}

function deleteJobFromDisk(jobId: string): void {
  rmSync(getJobFilePath(jobId), { force: true });
}

function readJobFromDisk(jobId: string): TimeInOutJobStatus | null {
  const jobFilePath = getJobFilePath(jobId);

  if (!existsSync(jobFilePath)) {
    return null;
  }

  const jobAge = Date.now() - statSync(jobFilePath).mtimeMs;
  if (jobAge > JOB_TTL_MS) {
    deleteJobFromDisk(jobId);
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(jobFilePath, "utf8"));
    return timeInOutJobStatusSchema.parse(raw);
  } catch {
    deleteJobFromDisk(jobId);
    return null;
  }
}

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
  writeJobToDisk(parsed);
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
        headless: current?.headless,
        result: timeInOutResultSchema.parse({
          success: false,
          browserLiveViewUrl: toReadOnlyLiveViewUrl(current?.browserLiveViewUrl),
          headless: current?.headless,
          error: message,
        }),
      });
    })
    .finally(() => {
      setTimeout(() => {
        jobs.delete(jobId);
        deleteJobFromDisk(jobId);
      }, JOB_TTL_MS);
    });

  return jobs.get(jobId)!;
}

export function getTimeInOutJob(jobId: string): TimeInOutJobStatus | null {
  const inMemoryJob = jobs.get(jobId);
  if (inMemoryJob) {
    return inMemoryJob;
  }

  const diskJob = readJobFromDisk(jobId);
  if (diskJob) {
    jobs.set(jobId, diskJob);
  }

  return diskJob;
}