"use client";

import { useState } from "react";
import { timeInOutResultSchema, type TimeInOutResult } from "@/lib/time-in-out";

export default function Home() {
  const [timeIn, setTimeIn] = useState("08:00");
  const [timeOut, setTimeOut] = useState("16:00");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TimeInOutResult | null>(null);

  function toErrorResult(rawData: unknown, fallbackMessage: string): TimeInOutResult {
    const parsedError = timeInOutResultSchema.safeParse(rawData);

    if (parsedError.success) {
      return parsedError.data;
    }

    return {
      success: false,
      executionLog: [],
      error: fallbackMessage,
    };
  }

  async function handleRun() {
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("/api/time-in-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeIn, timeOut }),
      });

      const rawData = await res.json();
      const parsed = timeInOutResultSchema.safeParse(rawData);

      if (!parsed.success) {
        setResult(toErrorResult(rawData, "API returned an invalid response shape."));
        return;
      }

      setResult(parsed.data);
    } catch (error) {
      setResult({
        success: false,
        executionLog: [],
        error: error instanceof Error ? error.message : "Network error - check console.",
      });
    } finally {
      setLoading(false);
    }
  }

  const liveViewUrl = result?.browserLiveViewUrl;

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <main className="w-full max-w-3xl rounded-2xl bg-white p-8 shadow-sm dark:bg-zinc-800">
        <h1 className="mb-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          HRM Daily Check
        </h1>
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          Automates Time In/Out on{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            hrm.kalicube.com
          </span>{" "}
          via{" "}
          <a
            href="https://kernel.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Kernel.sh
          </a>
          .
        </p>

        <div className="mb-4 grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="timeIn"
              className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              Time In
            </label>
            <input
              id="timeIn"
              type="time"
              value={timeIn}
              onChange={(e) => setTimeIn(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-50"
            />
          </div>
          <div>
            <label
              htmlFor="timeOut"
              className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              Time Out
            </label>
            <input
              id="timeOut"
              type="time"
              value={timeOut}
              onChange={(e) => setTimeOut(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-50"
            />
          </div>
        </div>

        <button
          onClick={handleRun}
          disabled={loading}
          className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {loading ? "Running automation..." : "Run Time In/Out"}
        </button>

        {loading && (
          <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-100/80 p-4 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-200">
            <div>
              Automation is running. This can take 20-60 seconds depending on login and page load time.
            </div>
          </div>
        )}

        {result && (
          <div
            className={`mt-4 rounded-lg px-4 py-3 text-sm ${
              result.success
                ? "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300"
            }`}
          >
            {result.success ? (
              <>
                <div>Time In/Out completed.</div>

                <div className="mt-1">
                  Kernel mode: <strong>{result.headless ? "Headless" : "Headful"}</strong>
                </div>

                {result.agentResponse && (
                  <div className="mt-2 rounded-md bg-white/60 p-3 text-sm text-zinc-800 dark:bg-zinc-950/30 dark:text-zinc-100">
                    {result.agentResponse}
                  </div>
                )}

                {result.pageUrl && (
                  <div className="mt-1 break-all text-xs opacity-80">
                    URL: {result.pageUrl}
                  </div>
                )}

                {result.browserLiveViewUrl && (
                  <div className="mt-1 text-xs">
                    Live view:{" "}
                    <a
                      href={result.browserLiveViewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      {result.browserLiveViewUrl}
                    </a>
                  </div>
                )}

                {result.executionLog && result.executionLog.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-80">
                      Execution Log
                    </div>
                    <pre className="max-h-72 overflow-auto rounded-md bg-zinc-900/90 p-3 text-xs text-zinc-100">
                      {result.executionLog.join("\n")}
                    </pre>
                  </div>
                )}

              </>
            ) : (
              <>
                <div>x {result.error}</div>
                <div className="mt-2 text-xs opacity-80">
                  Kernel mode: <strong>{result.headless ? "Headless" : "Headful"}</strong>
                </div>
                {result.agentResponse && (
                  <div className="mt-2 rounded-md bg-black/5 p-3 text-sm text-current dark:bg-white/5">
                    {result.agentResponse}
                  </div>
                )}
                {result.pageUrl && (
                  <div className="mt-1 break-all text-xs opacity-80">
                    URL: {result.pageUrl}
                  </div>
                )}
                {result.browserLiveViewUrl && (
                  <div className="mt-1 text-xs">
                    Live view:{" "}
                    <a
                      href={result.browserLiveViewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      {result.browserLiveViewUrl}
                    </a>
                  </div>
                )}
                {result.executionLog && result.executionLog.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-80">
                      Execution Log
                    </div>
                    <pre className="max-h-72 overflow-auto rounded-md bg-zinc-900/90 p-3 text-xs text-zinc-100">
                      {result.executionLog.join("\n")}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
          Also runs automatically every weekday at 08:00 via Vercel Cron.
        </p>
      </main>
    </div>
  );
}
