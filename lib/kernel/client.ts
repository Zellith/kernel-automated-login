import { createOpenAI } from "@ai-sdk/openai";
import { Experimental_Agent as Agent, stepCountIs } from "ai";
import { playwrightExecuteTool } from "@onkernel/ai-sdk";
import Kernel from "@onkernel/sdk";
import { z } from "zod";
import { timeInOutResultSchema, type TimeInOutResult } from "@/lib/time-in-out";

const DAILY_CHECK_URL = "https://hrm.kalicube.com/wp-admin/admin.php?page=hrm-dailycheck-app";
const TUNNEL_CONNECTION_ERROR_MARKER = "ERR_TUNNEL_CONNECTION_FAILED";
const OPENAI_MODEL = "gpt-5.1";
const DEFAULT_BROWSER_TIMEOUT_SECONDS = 300;
const DEFAULT_PLAYWRIGHT_TIMEOUT_SECONDS = 120;

const browserAutomationResultSchema = z.object({
  success: z.boolean(),
  summary: z.string(),
  log: z.array(z.string()).default([]),
  pageUrl: z.string().optional(),
  foundTimeInOutButton: z.boolean().optional(),
  error: z.string().optional(),
});

const kernelToolResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  result: z.unknown().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});

type BrowserAutomationResult = z.infer<typeof browserAutomationResultSchema>;
type KernelToolResponse = z.infer<typeof kernelToolResponseSchema>;

export const DEFAULT_TIME_IN = "08:00";
export const DEFAULT_TIME_OUT = "16:00";

export interface RunTimeInOutOptions {
  onSessionReady?: (session: {
    browserLiveViewUrl?: string;
    browserCdpWsUrl?: string;
    headless: boolean;
  }) => void;
  onLogUpdate?: (executionLog: string[]) => void;
}

type ExecutionLogFn = (message: string) => void;

interface RunTimeInOutAttemptOptions extends RunTimeInOutOptions {
  apiKey: string;
  openAiApiKey: string;
  username: string;
  password: string;
  headless: boolean;
  executionLog: string[];
  logStep: ExecutionLogFn;
}

function createExecutionLogger(
  onLogUpdate?: (executionLog: string[]) => void,
): { executionLog: string[]; logStep: ExecutionLogFn } {
  const executionLog: string[] = [];

  return {
    executionLog,
    logStep(message) {
      const line = `[${new Date().toISOString()}] ${message}`;
      executionLog.push(line);
      onLogUpdate?.([...executionLog]);
      console.info(`[kernel-automated-login] ${line}`);
    },
  };
}

function withExecutionLog(
  result: Omit<TimeInOutResult, "executionLog"> & { executionLog?: string[] },
  executionLog: string[],
  browserLog: string[] = [],
): TimeInOutResult {
  return timeInOutResultSchema.parse({
    ...result,
    executionLog: [...executionLog, ...browserLog.map((entry) => `[browser] ${entry}`)],
  });
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return undefined;
}

function resolveHeadlessMode(): boolean {
  const headlessEnv = parseBooleanEnv(process.env.KERNEL_HEADLESS);
  const headfulEnv = parseBooleanEnv(process.env.KERNEL_HEADFUL);

  return headfulEnv === true ? false : headlessEnv === true;
}

function resolveStealthMode(): boolean {
  return parseBooleanEnv(process.env.KERNEL_STEALTH) ?? true;
}

function resolveBrowserTimeoutSeconds(): number {
  const parsed = Number(process.env.KERNEL_TIMEOUT_SECONDS);

  if (Number.isFinite(parsed) && parsed >= 10) {
    return parsed;
  }

  return DEFAULT_BROWSER_TIMEOUT_SECONDS;
}

function isTunnelConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(TUNNEL_CONNECTION_ERROR_MARKER);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTunnelErrorGuidance(message: string): string {
  return `${message} Kernel could not open the target URL through its current network path. Try running headless, verify there is no proxy attached to the Kernel browser session, and retry with a fresh session.`;
}

function describeCredentialShape(secret: string): string {
  return [
    `length=${secret.length}`,
    `trimmedLength=${secret.trim().length}`,
    `leadingWhitespace=${String(/^\s/.test(secret))}`,
    `trailingWhitespace=${String(/\s$/.test(secret))}`,
    `containsSpace=${String(secret.includes(" "))}`,
    `containsTab=${String(secret.includes("\t"))}`,
    `containsNewline=${String(/[\r\n]/.test(secret))}`,
    `containsSingleQuote=${String(secret.includes("'"))}`,
    `containsDoubleQuote=${String(secret.includes('"'))}`,
    `containsBackslash=${String(secret.includes("\\"))}`,
    `containsNonAscii=${String(/[^\x20-\x7E]/.test(secret))}`,
  ].join(", ");
}

function buildSystemPrompt(): string {
  return [
    "You are a browser automation expert using Kernel's playwright_execute tool.",
    "You must solve the task with exactly one playwright_execute tool call in the first step.",
    "In the second step, provide a concise plain-English summary of what happened.",
    "The tool code must be a single self-contained JavaScript/TypeScript snippet that uses the provided page/context/browser variables.",
    "The tool code must create a log array, push short progress notes into it, and return a JSON-serializable object with these fields:",
    "The tool code must end with an explicit return statement. Do not rely on console.log or an implicit final expression.",
    '{ success: boolean, summary: string, log: string[], pageUrl?: string, foundTimeInOutButton?: boolean, error?: string }',
    "Use runtime discovery from visible text, labels, placeholders, autocomplete attributes, element names, ids, and surrounding DOM structure.",
    "Do not rely on a pre-supplied fixed selector list. It is acceptable to inspect the DOM and then choose selectors dynamically based on what you find.",
    "If login is required, detect the login page, fill the credentials, submit, and verify whether authentication succeeded.",
    "If the browser remains on a login page after submission, read the exact visible error text from WordPress notices such as #login_error, .message, form errors, or other prominent alerts, and include that exact text in the returned error and summary.",
    "If you click the Time In/Out trigger but cannot locate the time controls, inspect the currently visible dialog, form, and nearby inputs/selects before failing.",
    "When failing to locate the controls, include concise diagnostic log entries describing the visible modal title, candidate time fields, labels, placeholders, names, ids, and short HTML snippets of the active dialog or form.",
    "When setting the time fields, inspect the modal and choose the matching hour/minute controls for start and end times.",
    "If anything fails, catch the error and return success=false with a clear human-readable error.",
    `Set timeout_sec to ${DEFAULT_PLAYWRIGHT_TIMEOUT_SECONDS} on the tool call.`,
  ].join(" ");
}

function buildAutomationPrompt({
  timeIn,
  timeOut,
}: {
  timeIn: string;
  timeOut: string;
}): string {
  return [
    `The browser session has already been navigated to ${DAILY_CHECK_URL} and any required WordPress login has already been handled before this step.`,
    `Do not attempt authentication in this step. If the page is still on a login screen or another auth barrier, report that as an error instead of trying credentials again.`,
    `Ensure the active page is the HRM Daily Check app at ${DAILY_CHECK_URL}.`,
    `Open the Time In/Out workflow, find the modal or form used to submit the daily check, and set Time In to \"${timeIn}\" and Time Out to \"${timeOut}\".`,
    "Submit the form and verify whether the request succeeded by checking URL changes, network/application feedback, and any visible success or error notices.",
    "Your Playwright code must explicitly return the structured result object.",
    "Return the required structured object from the tool code. In your final text response after the tool call, summarise the outcome in one or two short sentences.",
  ].join(" ");
}

async function captureTimeInOutDiagnostics(
  kernel: Kernel,
  sessionId: string,
  logStep: ExecutionLogFn,
): Promise<string[]> {
  const response = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 30,
    code: `
      const logs = [];

      const truncate = (value, max = 500) => {
        if (!value) return "";
        return value.length <= max ? value : value.slice(0, max) + "...";
      };

      const normalize = (value) => (value || "").replace(/[\\t\\n\\r ]+/g, " ").trim();

      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const describeControl = (element) => {
        const id = element.getAttribute("id") || "";
        const name = element.getAttribute("name") || "";
        const type = element.getAttribute("type") || element.tagName.toLowerCase();
        const placeholder = element.getAttribute("placeholder") || "";
        const ariaLabel = element.getAttribute("aria-label") || "";
        const value = "value" in element ? String(element.value || "") : "";
        const labels = "labels" in element && element.labels
          ? Array.from(element.labels).map((label) => normalize(label.textContent)).filter(Boolean)
          : [];

        return [
          "tag=" + element.tagName.toLowerCase(),
          "type=" + type,
          id ? "id=" + id : "",
          name ? "name=" + name : "",
          placeholder ? "placeholder=" + placeholder : "",
          ariaLabel ? "ariaLabel=" + ariaLabel : "",
          labels.length ? "labels=" + labels.join("|") : "",
          value ? "value=" + value : "",
        ].filter(Boolean).join(", ");
      };

      const visibleDialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, .modal, .popup, .ui-dialog, .swal2-popup'))
        .filter(isVisible)
        .slice(0, 3);

      logs.push("Diagnostics URL: " + location.href);
      logs.push("Visible dialogs: " + String(visibleDialogs.length));

      visibleDialogs.forEach((dialog, index) => {
        logs.push("Dialog " + String(index + 1) + " text: " + truncate(normalize(dialog.textContent), 300));
        logs.push("Dialog " + String(index + 1) + " html: " + truncate(dialog.outerHTML, 800));
      });

      const visibleForms = Array.from(document.querySelectorAll('form')).filter(isVisible).slice(0, 3);
      visibleForms.forEach((form, index) => {
        logs.push("Form " + String(index + 1) + " html: " + truncate(form.outerHTML, 800));
      });

      const candidateControls = Array.from(document.querySelectorAll('input, select, textarea, button'))
        .filter(isVisible)
        .filter((element) => {
          const text = normalize(element.textContent);
          const attrs = normalize([
            element.getAttribute('name') || '',
            element.getAttribute('id') || '',
            element.getAttribute('placeholder') || '',
            element.getAttribute('aria-label') || '',
            'type' in element ? String(element.type || '') : '',
          ].join(' ')).toLowerCase();
          return /time|in|out|hour|minute|am|pm|clock|start|end|check/i.test(text) || /time|in|out|hour|minute|am|pm|clock|start|end|check/.test(attrs);
        })
        .slice(0, 12);

      candidateControls.forEach((element, index) => {
        logs.push("Candidate control " + String(index + 1) + ": " + describeControl(element));
      });

      const triggerButtons = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'))
        .filter(isVisible)
        .map((element) => normalize(element.textContent || element.getAttribute('value') || ''))
        .filter(Boolean)
        .slice(0, 20);
      logs.push("Visible trigger/button texts: " + JSON.stringify(triggerButtons));

      return {
        success: true,
        summary: 'Captured Time In/Out diagnostics.',
        log: logs,
        pageUrl: location.href,
      };
    `,
  });

  if (!response.success) {
    logStep(`Time In/Out diagnostics capture failed: ${response.error ?? "unknown error"}`);
    return [];
  }

  const diagnosticResult = normalizeBrowserAutomationResult(response.result);
  if (!diagnosticResult) {
    logStep("Time In/Out diagnostics capture returned an invalid shape.");
    return [];
  }

  for (const entry of diagnosticResult.log) {
    logStep(`Time In/Out diagnostics: ${entry}`);
  }

  return diagnosticResult.log;
}

async function runDeterministicTimeInOutFlow(
  kernel: Kernel,
  sessionId: string,
  timeIn: string,
  timeOut: string,
  logStep: ExecutionLogFn,
): Promise<BrowserAutomationResult | null> {
  const response = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: 60,
    code: `
      const log = [];
      const timeIn = ${JSON.stringify(timeIn)};
      const timeOut = ${JSON.stringify(timeOut)};

      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalize = (value) => (value || "").replace(/[\\t\\n\\r ]+/g, " ").trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };

      const [startHour, startMinute] = timeIn.split(":");
      const [endHour, endMinute] = timeOut.split(":");

      const footerButton = Array.from(document.querySelectorAll("button.footer-btn"))
        .find((button) => {
          const text = normalize(button.textContent).toLowerCase();
          const onclick = button.getAttribute("onclick") || "";
          return text.includes("time in/out") || onclick.includes("roam_time_modal");
        });

      const modal = document.getElementById("roam_time_modal");
      const startHourSelect = document.getElementById("start_hh");
      const startMinuteSelect = document.getElementById("start_mm");
      const endHourSelect = document.getElementById("end_hh");
      const endMinuteSelect = document.getElementById("end_mm");
      const saveButton = document.getElementById("btn_save_time");

      if (!footerButton || !modal || !startHourSelect || !startMinuteSelect || !endHourSelect || !endMinuteSelect || !saveButton) {
        log.push("Virtual HQ deterministic controls were not all present; falling back to AI discovery.");
        return {
          success: false,
          summary: "Deterministic Virtual HQ controls were not all present.",
          log,
          pageUrl: location.href,
          foundTimeInOutButton: Boolean(footerButton),
          error: "deterministic-controls-missing",
        };
      }

      log.push("Detected Virtual HQ footer Time In/Out workflow.");
      footerButton.click();
      await wait(300);

      if (!isVisible(modal)) {
        log.push("Time In/Out modal did not become visible after clicking the footer button.");
        return {
          success: false,
          summary: "Time In/Out modal did not open.",
          log,
          pageUrl: location.href,
          foundTimeInOutButton: true,
          error: "deterministic-modal-not-open",
        };
      }

      log.push("Time In/Out modal opened. Setting select values.");

      startHourSelect.value = startHour;
      startHourSelect.dispatchEvent(new Event("change", { bubbles: true }));
      startMinuteSelect.value = startMinute;
      startMinuteSelect.dispatchEvent(new Event("change", { bubbles: true }));
      endHourSelect.value = endHour;
      endHourSelect.dispatchEvent(new Event("change", { bubbles: true }));
      endMinuteSelect.value = endMinute;
      endMinuteSelect.dispatchEvent(new Event("change", { bubbles: true }));

      log.push(
        "Selected values: start=" +
          startHourSelect.value +
          ":" +
          startMinuteSelect.value +
          ", end=" +
          endHourSelect.value +
          ":" +
          endMinuteSelect.value,
      );

      let capturedAlert = null;
      const originalAlert = window.alert;
      window.alert = (message) => {
        capturedAlert = String(message);
        log.push("Captured alert: " + capturedAlert);
      };

      try {
        saveButton.click();
        log.push("Clicked Save Time button.");

        const startTime = Date.now();
        while (Date.now() - startTime < 15000) {
          if (capturedAlert) {
            break;
          }

          if (!isVisible(modal)) {
            log.push("Modal closed after save.");
            break;
          }

          await wait(250);
        }
      } finally {
        window.alert = originalAlert;
      }

      if (capturedAlert && !/error/i.test(capturedAlert)) {
        return {
          success: true,
          summary: capturedAlert,
          log,
          pageUrl: location.href,
          foundTimeInOutButton: true,
        };
      }

      if (capturedAlert && /error/i.test(capturedAlert)) {
        return {
          success: false,
          summary: capturedAlert,
          error: capturedAlert,
          log,
          pageUrl: location.href,
          foundTimeInOutButton: true,
        };
      }

      if (!isVisible(modal)) {
        return {
          success: true,
          summary: "Time In/Out modal submitted and closed.",
          log,
          pageUrl: location.href,
          foundTimeInOutButton: true,
        };
      }

      return {
        success: false,
        summary: "Time In/Out modal stayed open after save.",
        error: "Time In/Out modal stayed open after save.",
        log,
        pageUrl: location.href,
        foundTimeInOutButton: true,
      };
    `,
  });

  if (!response.success) {
    logStep(`Deterministic Time In/Out flow failed to execute: ${response.error ?? "unknown error"}`);
    return null;
  }

  const deterministicResult = normalizeBrowserAutomationResult(response.result);
  if (!deterministicResult) {
    logStep("Deterministic Time In/Out flow returned an invalid shape.");
    return null;
  }

  for (const entry of deterministicResult.log) {
    logStep(`Deterministic Time In/Out: ${entry}`);
  }

  if (
    deterministicResult.error === "deterministic-controls-missing" ||
    deterministicResult.error === "deterministic-modal-not-open"
  ) {
    logStep("Deterministic Time In/Out path is not applicable on this page. Falling back to GPT discovery.");
    return null;
  }

  return deterministicResult;
}

function findLatestPlaywrightToolOutput(toolResponses: KernelToolResponse[]): KernelToolResponse | null {
  return toolResponses.at(-1) ?? null;
}

function collectToolResponses(steps: Array<{ toolResults: Array<{ toolName: string; output: unknown }> }>): KernelToolResponse[] {
  const responses: KernelToolResponse[] = [];

  for (const step of steps) {
    for (const toolResult of step.toolResults) {
      if (toolResult.toolName !== "playwright_execute") {
        continue;
      }

      const parsed = kernelToolResponseSchema.safeParse(toolResult.output);
      if (parsed.success) {
        responses.push(parsed.data);
      }
    }
  }

  return responses;
}

function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateForLog(value: string, maxLength: number = 4000): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function parseJsonString(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeBrowserAutomationResult(value: unknown): BrowserAutomationResult | null {
  const visited = new Set<unknown>();
  let candidate: unknown = value;

  for (let depth = 0; depth < 4; depth += 1) {
    if (candidate == null || visited.has(candidate)) {
      return null;
    }

    visited.add(candidate);

    if (typeof candidate === "string") {
      const parsed = parseJsonString(candidate);
      if (parsed === candidate) {
        return null;
      }

      candidate = parsed;
      continue;
    }

    const directParse = browserAutomationResultSchema.safeParse(candidate);
    if (directParse.success) {
      return directParse.data;
    }

    if (typeof candidate !== "object") {
      return null;
    }

    const record = candidate as Record<string, unknown>;

    const looseSuccess = record.success;
    const looseSummary = record.summary ?? record.message ?? record.error;
    const looseLog = Array.isArray(record.log)
      ? record.log.map((entry) => (typeof entry === "string" ? entry : stringifyForLog(entry)))
      : [];
    const loosePageUrl = typeof record.pageUrl === "string"
      ? record.pageUrl
      : typeof record.page_url === "string"
        ? record.page_url
        : undefined;
    const looseFoundButton = typeof record.foundTimeInOutButton === "boolean"
      ? record.foundTimeInOutButton
      : typeof record.found_time_in_out_button === "boolean"
        ? record.found_time_in_out_button
        : undefined;
    const looseError = typeof record.error === "string" ? record.error : undefined;

    const normalizedParse = browserAutomationResultSchema.safeParse({
      success: typeof looseSuccess === "boolean" ? looseSuccess : undefined,
      summary: typeof looseSummary === "string" ? looseSummary : undefined,
      log: looseLog,
      pageUrl: loosePageUrl,
      foundTimeInOutButton: looseFoundButton,
      error: looseError,
    });

    if (normalizedParse.success) {
      return normalizedParse.data;
    }

    if ("result" in record) {
      candidate = record.result;
      continue;
    }

    if ("value" in record) {
      candidate = record.value;
      continue;
    }

    if ("data" in record) {
      candidate = record.data;
      continue;
    }

    return null;
  }

  return null;
}

async function navigateToDailyCheckPage(
  kernel: Kernel,
  sessionId: string,
  username: string,
  password: string,
  logStep: ExecutionLogFn,
) : Promise<BrowserAutomationResult> {
  logStep(`Preflight navigation: opening ${DAILY_CHECK_URL} before agent execution.`);

  const response = await kernel.browsers.playwright.execute(sessionId, {
    timeout_sec: DEFAULT_PLAYWRIGHT_TIMEOUT_SECONDS,
    code: `
      const log = [];
      const targetUrl = ${JSON.stringify(DAILY_CHECK_URL)};
      const username = ${JSON.stringify(username)};
      const password = ${JSON.stringify(password)};

      async function waitForPageSettled() {
        await page.waitForLoadState("domcontentloaded").catch(() => {
          log.push("domcontentloaded wait timed out; continuing with current page state");
        });
        await page.waitForLoadState("networkidle").catch(() => {
          log.push("networkidle wait timed out; continuing with current page state");
        });
      }

      async function isLoginPage() {
        if (page.url().includes("/wp-login.php")) {
          return true;
        }

        return (await page.locator("form#loginform, input#user_login, input[name='log'], input[name='pwd']").count()) > 0;
      }

      async function readLoginError() {
        const errorSelectors = [
          "#login_error",
          ".login .message",
          ".notice-error",
          ".notice-error p",
          "form#loginform + div",
        ];

        const normalizeNoticeText = (value) => value
          .replace(/[\\t\\n\\r\\f ]+/g, " ")
          .replace(/\\u00a0/g, " ")
          .trim();

        for (const selector of errorSelectors) {
          const locator = page.locator(selector).first();
          if (await locator.count()) {
            const textContent = normalizeNoticeText(
              await locator.evaluate((node) => node.textContent || "").catch(() => ""),
            );
            const innerText = normalizeNoticeText(
              await locator.innerText().catch(() => ""),
            );

            if (textContent && textContent !== innerText) {
              log.push(
                "Login error candidate mismatch for " +
                  selector +
                  ": textContent=" +
                  JSON.stringify(textContent) +
                  " innerText=" +
                  JSON.stringify(innerText),
              );
            }

            if (textContent) {
              return textContent;
            }

            if (innerText) {
              return innerText;
            }
          }
        }

        return null;
      }

      log.push("Navigating to HRM Daily Check URL");
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await waitForPageSettled();

      if (await isLoginPage()) {
        log.push("Preflight detected WordPress login page; submitting credentials deterministically");

        const usernameField = page.locator("input#user_login, input[name='log'], input[type='email'], input[autocomplete='username']").first();
        const passwordField = page.locator("input#user_pass, input[name='pwd'], input[type='password'], input[autocomplete='current-password']").first();
        const submitButton = page.locator("input#wp-submit, button[type='submit'], input[type='submit']").first();

        await usernameField.waitFor({ state: "visible", timeout: 15000 });
        await passwordField.waitFor({ state: "visible", timeout: 15000 });

        log.push("Typing credentials with keyboard events instead of fill()");

        await usernameField.click();
        await page.keyboard.press("Control+A").catch(() => undefined);
        await page.keyboard.press("Meta+A").catch(() => undefined);
        await page.keyboard.press("Backspace");
        await page.keyboard.type(username, { delay: 50 });

        await passwordField.click();
        await page.keyboard.press("Control+A").catch(() => undefined);
        await page.keyboard.press("Meta+A").catch(() => undefined);
        await page.keyboard.press("Backspace");
        await page.keyboard.type(password, { delay: 50 });

        const typedUsername = await usernameField.inputValue().catch(() => "");
        const typedPassword = await passwordField.inputValue().catch(() => "");

        log.push(
          "Credential field diagnostics: usernameMatches=" +
            String(typedUsername === username) +
            ", usernameLength=" +
            String(typedUsername.length) +
            ", expectedUsernameLength=" +
            String(username.length) +
            ", passwordMatches=" +
            String(typedPassword === password) +
            ", passwordLength=" +
            String(typedPassword.length) +
            ", expectedPasswordLength=" +
            String(password.length),
        );

        log.push("Submitting WordPress login form during preflight");
        await Promise.all([
          submitButton.click(),
          page.waitForLoadState("domcontentloaded").catch(() => undefined),
        ]);

        await waitForPageSettled();

        if (await isLoginPage()) {
          const errorText = await readLoginError();
          const message = errorText ? "Error: " + errorText : "Error: WordPress login did not succeed during preflight.";
          log.push("Preflight login failed: " + message);

          return {
            success: false,
            summary: message,
            error: message,
            log,
            pageUrl: page.url(),
            foundTimeInOutButton: false,
          };
        }

        log.push("Preflight login succeeded");
        if (page.url() !== targetUrl) {
          log.push("Re-opening HRM Daily Check page after successful login");
          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          await waitForPageSettled();
        }
      }

      return {
        success: true,
        summary: "Opened the initial HRM page before agent execution and verified authentication state.",
        log,
        pageUrl: page.url(),
      };
    `,
  });

  logStep(`Preflight navigation response: ${truncateForLog(stringifyForLog(response))}`);

  if (!response.success) {
    throw new Error(response.error ?? "Failed to navigate to the HRM Daily Check URL before agent execution.");
  }

  const preflightResult = normalizeBrowserAutomationResult(response.result);
  if (!preflightResult) {
    throw new Error("Preflight navigation returned an invalid result shape.");
  }

  if (preflightResult.pageUrl) {
    logStep(`Preflight navigation landed on URL: ${preflightResult.pageUrl}`);
  }

  return preflightResult;
}

function createAutomationAgent({
  kernel,
  sessionId,
  model,
  stopWhen,
  prepareStep,
  onStepFinish,
}: {
  kernel: Kernel;
  sessionId: string;
  model: ReturnType<ReturnType<typeof createOpenAI>>;
  stopWhen: ReturnType<typeof stepCountIs>;
  prepareStep?: ({ stepNumber }: { stepNumber: number }) => {
    activeTools?: Array<"playwright_execute">;
    toolChoice?: "none" | { type: "tool"; toolName: "playwright_execute" };
  };
  onStepFinish: (stepResult: {
    finishReason: string;
    toolCalls: Array<{ toolName: string }>;
    toolResults: Array<{ toolName: string; output: unknown }>;
  }) => void;
}) {
  return new Agent({
    model,
    system: buildSystemPrompt(),
    tools: {
      playwright_execute: playwrightExecuteTool({
        client: kernel,
        sessionId,
        toolDescription: `Execute one Playwright script against the live HRM session. Always pass timeout_sec=${DEFAULT_PLAYWRIGHT_TIMEOUT_SECONDS}.`,
      }),
    },
    stopWhen,
    prepareStep,
    onStepFinish,
  });
}

async function runTimeInOutAttempt(
  timeIn: string,
  timeOut: string,
  {
    apiKey,
    openAiApiKey,
    username,
    password,
    headless,
    onSessionReady,
    executionLog,
    logStep,
  }: RunTimeInOutAttemptOptions,
): Promise<TimeInOutResult> {
  const kernel = new Kernel({ apiKey });
  const openaiProvider = createOpenAI({ apiKey: openAiApiKey });

  let sessionId: string | undefined;
  let browserLiveViewUrl: string | undefined;
  let browserCdpWsUrl: string | undefined;
  let result: TimeInOutResult | null = null;

  try {
    logStep(`Launching Kernel browser in ${headless ? "headless" : "headful"} mode via the SDK.`);
    const browserSession = await kernel.browsers.create({
      headless,
      stealth: resolveStealthMode(),
      timeout_seconds: resolveBrowserTimeoutSeconds(),
    });

    sessionId = browserSession.session_id;
    browserLiveViewUrl = browserSession.browser_live_view_url;
    browserCdpWsUrl = browserSession.cdp_ws_url;
    logStep(`Kernel browser launched. Session ID acquired: ${sessionId}.`);
    logStep(
      browserLiveViewUrl
        ? `Retrieved browser live view URL for session ${sessionId}.`
        : `Browser session ${sessionId} did not expose a live view URL.`,
    );
    logStep(
      browserCdpWsUrl
        ? `Retrieved CDP websocket URL for session ${sessionId}.`
        : `Browser session ${sessionId} did not expose a CDP websocket URL.`,
    );

    onSessionReady?.({
      browserLiveViewUrl,
      browserCdpWsUrl,
      headless: browserSession.headless,
    });

    const preflightResult = await navigateToDailyCheckPage(kernel, sessionId, username, password, logStep);

    if (!preflightResult.success) {
      logStep(`Preflight authentication/navigation failed: ${preflightResult.error ?? preflightResult.summary}`);
      result = withExecutionLog(
        {
          success: false,
          agentResponse: preflightResult.summary,
          foundTimeInOutButton: preflightResult.foundTimeInOutButton,
          pageUrl: preflightResult.pageUrl,
          browserLiveViewUrl,
          browserCdpWsUrl,
          headless,
          error: preflightResult.error ?? preflightResult.summary,
        },
        executionLog,
        preflightResult.log,
      );
      return result;
    }

    const deterministicTimeInOutResult = await runDeterministicTimeInOutFlow(
      kernel,
      sessionId,
      timeIn,
      timeOut,
      logStep,
    );

    if (deterministicTimeInOutResult) {
      logStep(`Deterministic Time In/Out result: ${deterministicTimeInOutResult.summary}`);

      result = withExecutionLog(
        {
          success: deterministicTimeInOutResult.success,
          agentResponse: deterministicTimeInOutResult.summary,
          foundTimeInOutButton: deterministicTimeInOutResult.foundTimeInOutButton,
          pageUrl: deterministicTimeInOutResult.pageUrl,
          browserLiveViewUrl,
          browserCdpWsUrl,
          headless,
          error: deterministicTimeInOutResult.success ? undefined : deterministicTimeInOutResult.error ?? deterministicTimeInOutResult.summary,
        },
        executionLog,
        deterministicTimeInOutResult.log,
      );
      return result;
    }

    logStep("Requesting GPT-5 orchestration and forcing the first step to use the Kernel Playwright tool.");

    const handleStepFinish = (stepResult: {
      finishReason: string;
      toolCalls: Array<{ toolName: string }>;
      toolResults: Array<{ toolName: string; output: unknown }>;
    }) => {
      logStep(
        `Completed LLM step with finish reason ${stepResult.finishReason}. Tool calls: ${stepResult.toolCalls.length}. Tool results: ${stepResult.toolResults.length}.`,
      );

      if (stepResult.toolCalls.length === 0) {
        logStep("This step completed without any tool call.");
      }

      for (const toolCall of stepResult.toolCalls) {
        logStep(`Invoking ${toolCall.toolName} on the Kernel browser session.`);
      }

      for (const toolResult of stepResult.toolResults) {
        if (toolResult.toolName !== "playwright_execute") {
          continue;
        }

        const parsed = kernelToolResponseSchema.safeParse(toolResult.output);
        if (!parsed.success) {
          logStep("Tool call finished with an unexpected output shape.");
          continue;
        }

        logStep(
          parsed.data.success
            ? "Kernel Playwright execution completed successfully."
            : `Kernel Playwright execution reported an error: ${parsed.data.error ?? "unknown error"}`,
        );

        if (parsed.data.stdout?.trim()) {
          logStep(`Tool stdout: ${parsed.data.stdout.trim()}`);
        }

        if (parsed.data.stderr?.trim()) {
          logStep(`Tool stderr: ${parsed.data.stderr.trim()}`);
        }
      }
    };

    const primaryAgent = createAutomationAgent({
      kernel,
      sessionId,
      model: openaiProvider(OPENAI_MODEL),
      stopWhen: stepCountIs(2),
      prepareStep: ({ stepNumber }) => {
        if (stepNumber === 0) {
          return {
            activeTools: ["playwright_execute"],
            toolChoice: {
              type: "tool",
              toolName: "playwright_execute",
            },
          };
        }

        return {
          activeTools: [],
          toolChoice: "none",
        };
      },
      onStepFinish: handleStepFinish,
    });

    let aiResult = await primaryAgent.generate({
      prompt: buildAutomationPrompt({ timeIn, timeOut }),
      providerOptions: {
        openai: {
          parallelToolCalls: false,
          reasoningEffort: "medium",
        },
      },
    });

    const totalToolCalls = aiResult.steps.reduce((count, step) => count + step.toolCalls.length, 0);
    const totalToolResults = aiResult.steps.reduce((count, step) => count + step.toolResults.length, 0);

    logStep(
      `GPT-5 orchestration finished. Steps: ${aiResult.steps.length}. Tool calls: ${totalToolCalls}. Tool results: ${totalToolResults}. Token usage: ${aiResult.totalUsage.inputTokens} input / ${aiResult.totalUsage.outputTokens} output.`,
    );

    let toolResponses = collectToolResponses(aiResult.steps);
    let toolResponse = findLatestPlaywrightToolOutput(toolResponses);

    if (!toolResponse) {
      logStep(
        aiResult.text
          ? `GPT-5 returned text without executing the browser tool: ${aiResult.text}`
          : "GPT-5 returned without executing the browser tool and without any final text.",
      );

      if ((aiResult.warnings?.length ?? 0) > 0) {
        logStep(`GPT-5 returned ${aiResult.warnings!.length} warning(s): ${aiResult.warnings!.map((warning) => JSON.stringify(warning)).join(" | ")}`);
      }

      logStep("Retrying with a stricter single-step tool-only prompt because the first orchestration produced no browser action.");

      const fallbackAgent = createAutomationAgent({
        kernel,
        sessionId,
        model: openaiProvider(OPENAI_MODEL),
        stopWhen: stepCountIs(1),
        onStepFinish: handleStepFinish,
      });

      aiResult = await fallbackAgent.generate({
        prompt: `${buildAutomationPrompt({ timeIn, timeOut })} Your response must be exactly one playwright_execute tool call. Do not output plain text before the tool call, instead of the tool call, or after the tool call.`,
        providerOptions: {
          openai: {
            parallelToolCalls: false,
            reasoningEffort: "low",
          },
        },
        providerMetadata: undefined,
      });

      const fallbackTotalToolCalls = aiResult.steps.reduce((count, step) => count + step.toolCalls.length, 0);
      const fallbackTotalToolResults = aiResult.steps.reduce((count, step) => count + step.toolResults.length, 0);

      logStep(
        `Fallback GPT-5 orchestration finished. Steps: ${aiResult.steps.length}. Tool calls: ${fallbackTotalToolCalls}. Tool results: ${fallbackTotalToolResults}. Token usage: ${aiResult.totalUsage.inputTokens} input / ${aiResult.totalUsage.outputTokens} output.`,
      );

      if ((aiResult.warnings?.length ?? 0) > 0) {
        logStep(`Fallback GPT-5 warnings: ${aiResult.warnings!.map((warning) => JSON.stringify(warning)).join(" | ")}`);
      }

      toolResponses = collectToolResponses(aiResult.steps);
      toolResponse = findLatestPlaywrightToolOutput(toolResponses);
    }

    if (!toolResponse) {
      logStep("No Playwright tool response was available after GPT-5 orchestration completed.");
      result = withExecutionLog(
        {
          success: false,
          agentResponse: aiResult.text || "GPT-5 did not execute the Playwright tool.",
          browserLiveViewUrl,
          browserCdpWsUrl,
          headless,
          error: "GPT-5 did not execute the Playwright tool, so the HRM workflow never ran.",
        },
        executionLog,
      );
      return result;
    }

    logStep(`Raw Kernel Playwright response: ${truncateForLog(stringifyForLog(toolResponse))}`);

    if (toolResponse.success && toolResponse.result === undefined) {
      logStep("Kernel Playwright execution succeeded but returned no result value. Retrying once with an explicit return-value instruction.");

      const noReturnRecoveryAgent = createAutomationAgent({
        kernel,
        sessionId,
        model: openaiProvider(OPENAI_MODEL),
        stopWhen: stepCountIs(1),
        onStepFinish: handleStepFinish,
      });

      aiResult = await noReturnRecoveryAgent.generate({
        prompt: `${buildAutomationPrompt({ timeIn, timeOut })} The previous playwright_execute call ran but returned no value. Execute playwright_execute again against the current browser state. Your code must end with an explicit \`return { success, summary, log, pageUrl, foundTimeInOutButton, error }\` object. Do not use console.log as the final output.`,
        providerOptions: {
          openai: {
            parallelToolCalls: false,
            reasoningEffort: "low",
          },
        },
      });

      const noReturnRetryToolCalls = aiResult.steps.reduce((count, step) => count + step.toolCalls.length, 0);
      const noReturnRetryToolResults = aiResult.steps.reduce((count, step) => count + step.toolResults.length, 0);

      logStep(
        `No-return recovery orchestration finished. Steps: ${aiResult.steps.length}. Tool calls: ${noReturnRetryToolCalls}. Tool results: ${noReturnRetryToolResults}. Token usage: ${aiResult.totalUsage.inputTokens} input / ${aiResult.totalUsage.outputTokens} output.`,
      );

      if ((aiResult.warnings?.length ?? 0) > 0) {
        logStep(`No-return recovery warnings: ${aiResult.warnings!.map((warning) => JSON.stringify(warning)).join(" | ")}`);
      }

      toolResponses = collectToolResponses(aiResult.steps);
      toolResponse = findLatestPlaywrightToolOutput(toolResponses);

      if (!toolResponse) {
        logStep("No-return recovery produced no Playwright tool response.");
      } else {
        logStep(`Raw Kernel Playwright response after no-return recovery: ${truncateForLog(stringifyForLog(toolResponse))}`);
      }
    }

    if (!toolResponse || !toolResponse.success) {
      if (toolResponse?.error && isTunnelConnectionError(toolResponse.error)) {
        throw new Error(toolResponse.error);
      }

      logStep(`Kernel Playwright tool returned success=false with error: ${toolResponse?.error ?? "unknown error"}`);

      result = withExecutionLog(
        {
          success: false,
          agentResponse: aiResult.text || "Kernel tool execution failed.",
          browserLiveViewUrl,
          browserCdpWsUrl,
          headless,
          error: toolResponse?.error ?? "Kernel Playwright execution failed.",
        },
        executionLog,
      );
      return result;
    }

    const browserResult = normalizeBrowserAutomationResult(toolResponse.result);
    if (!browserResult) {
      logStep(`Browser workflow result had an invalid shape: ${stringifyForLog(toolResponse.result)}`);
      result = withExecutionLog(
        {
          success: false,
          agentResponse: aiResult.text || "The browser workflow returned an invalid result.",
          browserLiveViewUrl,
          browserCdpWsUrl,
          headless,
          error: "Kernel Playwright execution completed, but the returned automation result had an invalid shape.",
        },
        executionLog,
      );
      return result;
    }

    logStep(`Normalized browser workflow result: ${truncateForLog(stringifyForLog(browserResult))}`);

    logStep(`Browser workflow summary: ${browserResult.summary}`);

    if (browserResult.pageUrl) {
      logStep(`Browser workflow ended on URL: ${browserResult.pageUrl}`);
    }

    if (browserResult.foundTimeInOutButton !== undefined) {
      logStep(`Browser workflow reported foundTimeInOutButton=${browserResult.foundTimeInOutButton}.`);
    }

    if (!browserResult.success) {
      logStep(`Browser workflow reported failure: ${browserResult.error ?? browserResult.summary}`);

      let diagnosticBrowserLog: string[] = [];
      const shouldCaptureTimeDiagnostics =
        browserResult.foundTimeInOutButton === true &&
        /Unable to locate and set both Time In \(08:00\) and Time Out \(16:00\) fields\.|Unable to locate and set both Time In .* and Time Out .* fields\.|Failed to set and submit Time In\/Out/i.test(
          browserResult.error ?? browserResult.summary,
        );

      if (shouldCaptureTimeDiagnostics) {
        logStep("Trigger was found but time fields were not. Capturing deterministic Time In/Out diagnostics before closing the browser session.");
        diagnosticBrowserLog = await captureTimeInOutDiagnostics(kernel, sessionId, logStep);
      }

      result = withExecutionLog(
        {
          success: false,
          agentResponse: aiResult.text || browserResult.summary,
          foundTimeInOutButton: browserResult.foundTimeInOutButton,
          pageUrl: browserResult.pageUrl,
          browserLiveViewUrl,
          browserCdpWsUrl,
          headless,
          error: browserResult.error ?? browserResult.summary,
        },
        executionLog,
        [...browserResult.log, ...diagnosticBrowserLog],
      );
      return result;
    }

    logStep("Browser workflow reported success. Returning final result to the caller.");

    result = withExecutionLog(
      {
        success: true,
        agentResponse: aiResult.text || browserResult.summary,
        foundTimeInOutButton: browserResult.foundTimeInOutButton,
        pageUrl: browserResult.pageUrl,
        browserLiveViewUrl,
        browserCdpWsUrl,
        headless,
      },
      executionLog,
      browserResult.log,
    );
    return result;
  } finally {
    if (sessionId) {
      await kernel.browsers.deleteByID(sessionId).catch(() => {
        // The Kernel session may already be closed.
      });
      logStep("Kernel browser session closed.");
    }
  }
}

export async function runTimeInOut(
  timeIn: string = DEFAULT_TIME_IN,
  timeOut: string = DEFAULT_TIME_OUT,
  options: RunTimeInOutOptions = {},
): Promise<TimeInOutResult> {
  const { executionLog, logStep } = createExecutionLogger(options.onLogUpdate);

  logStep(`Starting automation run for ${timeIn} to ${timeOut}.`);
  const apiKey = process.env.KERNEL_API_KEY;
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const username = process.env.HRM_USERNAME;
  const password = process.env.HRM_PASSWORD;

  if (!apiKey) {
    logStep("Automation aborted because KERNEL_API_KEY is not set.");
    return withExecutionLog(
      {
        success: false,
        error: "KERNEL_API_KEY environment variable is not set",
      },
      executionLog,
    );
  }

  if (!openAiApiKey) {
    logStep("Automation aborted because OPENAI_API_KEY is not set.");
    return withExecutionLog(
      {
        success: false,
        error: "OPENAI_API_KEY environment variable is not set",
      },
      executionLog,
    );
  }

  if (!username) {
    logStep("Automation aborted because HRM_USERNAME is not set.");
    return withExecutionLog(
      {
        success: false,
        error: "HRM_USERNAME environment variable is not set",
      },
      executionLog,
    );
  }

  if (!password) {
    logStep("Automation aborted because HRM_PASSWORD is not set.");
    return withExecutionLog(
      {
        success: false,
        error: "HRM_PASSWORD environment variable is not set",
      },
      executionLog,
    );
  }

  logStep("Required environment variables are present.");
  logStep(`HRM username diagnostics: ${describeCredentialShape(username)}`);
  logStep(`HRM password diagnostics: ${describeCredentialShape(password)}`);

  const headless = resolveHeadlessMode();
  logStep(`Browser mode resolved to ${headless ? "headless" : "headful"}.`);

  try {
    return await runTimeInOutAttempt(timeIn, timeOut, {
      apiKey,
      openAiApiKey,
      username,
      password,
      headless,
      executionLog,
      logStep,
      ...options,
    });
  } catch (error) {
    if (!headless && isTunnelConnectionError(error)) {
      logStep(
        `Headful run hit ${TUNNEL_CONNECTION_ERROR_MARKER}. Retrying automatically in headless mode.`,
      );

      try {
        return await runTimeInOutAttempt(timeIn, timeOut, {
          apiKey,
          openAiApiKey,
          username,
          password,
          headless: true,
          executionLog,
          logStep,
          ...options,
        });
      } catch (retryError) {
        logStep(`Automatic headless retry failed: ${toErrorMessage(retryError)}`);
        return withExecutionLog(
          {
            success: false,
            headless: true,
            error: withTunnelErrorGuidance(
              `Initial headful session failed with ${TUNNEL_CONNECTION_ERROR_MARKER}, and the automatic headless retry also failed: ${toErrorMessage(retryError)}.`,
            ),
          },
          executionLog,
        );
      }
    }

    if (isTunnelConnectionError(error)) {
      logStep(`Tunnel connection error encountered: ${toErrorMessage(error)}`);
      return withExecutionLog(
        {
          success: false,
          headless,
          error: withTunnelErrorGuidance(toErrorMessage(error)),
        },
        executionLog,
      );
    }

    logStep(`Automation threw an unexpected error: ${toErrorMessage(error)}`);
    throw error;
  }
}
