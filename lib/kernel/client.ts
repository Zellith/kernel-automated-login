/**
 * Kernel.sh browser automation client for HRM time-tracking.
 *
 * Orchestrates the @onkernel/sdk to manage browser sessions and execute
 * Playwright automation code remotely. Each operation creates a fresh
 * headless browser, logs into the HRM WordPress admin, performs the
 * requested action, and tears down the session.
 */

import Kernel from "@onkernel/sdk";
import { buildLoginCode, buildTimeInOutCode } from "./automation";

/** Default time-in and time-out values for the daily check. */
export const DEFAULT_TIME_IN = "08:00";
export const DEFAULT_TIME_OUT = "16:00";

export interface TimeInOutResult {
  success: boolean;
  error?: string;
}

/**
 * Run the full HRM time-in/out automation using a Kernel.sh browser session.
 *
 * Reads KERNEL_API_KEY, HRM_USERNAME, and HRM_PASSWORD from environment
 * variables. Throws if any are missing.
 */
export async function runTimeInOut(
  timeIn: string = DEFAULT_TIME_IN,
  timeOut: string = DEFAULT_TIME_OUT,
): Promise<TimeInOutResult> {
  const apiKey = process.env.KERNEL_API_KEY;
  const username = process.env.HRM_USERNAME;
  const password = process.env.HRM_PASSWORD;

  if (!apiKey) throw new Error("KERNEL_API_KEY environment variable is not set");
  if (!username) throw new Error("HRM_USERNAME environment variable is not set");
  if (!password) throw new Error("HRM_PASSWORD environment variable is not set");

  const kernel = new Kernel({ apiKey });

  const browser = await kernel.browsers.create({
    headless: true,
    stealth: true,
    timeout_seconds: 180,
  });

  try {
    // Step 1: Login to WordPress admin
    const loginResult = await kernel.browsers.playwright.execute(
      browser.session_id,
      {
        code: buildLoginCode(username, password),
        timeout_sec: 60,
      },
    );

    if (!loginResult.success) {
      return {
        success: false,
        error: `Browser execution error during login: ${loginResult.error ?? "unknown"}`,
      };
    }

    const loginData = loginResult.result as {
      success: boolean;
      loggedIn: boolean;
      url: string;
      error?: string;
    };

    if (!loginData.loggedIn) {
      return {
        success: false,
        error: `HRM login failed: ${loginData.error ?? "credentials rejected"}`,
      };
    }

    // Step 2: Navigate to DailyCheck and set Time In/Out
    const timeResult = await kernel.browsers.playwright.execute(
      browser.session_id,
      {
        code: buildTimeInOutCode(timeIn, timeOut),
        timeout_sec: 90,
      },
    );

    if (!timeResult.success) {
      return {
        success: false,
        error: `Browser execution error during time entry: ${timeResult.error ?? "unknown"}`,
      };
    }

    const timeData = timeResult.result as {
      success: boolean;
      error?: string;
    };

    if (!timeData.success) {
      return {
        success: false,
        error: `Time In/Out failed: ${timeData.error ?? "unknown error"}`,
      };
    }

    return { success: true };
  } finally {
    // Always clean up the browser session
    await kernel.browsers.deleteByID(browser.session_id).catch(() => {
      // Session may already be cleaned up by Kernel
    });
  }
}
