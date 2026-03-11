import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { playwrightExecuteTool } from "@onkernel/ai-sdk";
import Kernel from "@onkernel/sdk";
import { z } from "zod";
import { timeInOutResultSchema, type TimeInOutResult } from "@/lib/time-in-out";

const DAILY_CHECK_URL = "https://hrm.kalicube.com/wp-admin/admin.php?page=hrm-dailycheck-app";
const TUNNEL_CONNECTION_ERROR_MARKER = "ERR_TUNNEL_CONNECTION_FAILED";
const OPENAI_MODEL = "gpt-5";
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
    headless: boolean;
  }) => void;
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

function createExecutionLogger(): { executionLog: string[]; logStep: ExecutionLogFn } {
  const executionLog: string[] = [];

  return {
    executionLog,
    logStep(message) {
      const line = `[${new Date().toISOString()}] ${message}`;
      executionLog.push(line);
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

function buildSystemPrompt(): string {
  return [
    "You are a browser automation expert using Kernel's playwright_execute tool.",
    "You must solve the task with exactly one playwright_execute tool call in the first step.",
    "In the second step, provide a concise plain-English summary of what happened.",
    "The tool code must be a single self-contained JavaScript/TypeScript snippet that uses the provided page/context/browser variables.",
    "The tool code must create a log array, push short progress notes into it, and return a JSON-serializable object with these fields:",
    '{ success: boolean, summary: string, log: string[], pageUrl?: string, foundTimeInOutButton?: boolean, error?: string }',
    "Use runtime discovery from visible text, labels, placeholders, autocomplete attributes, element names, ids, and surrounding DOM structure.",
    "Do not rely on a pre-supplied fixed selector list. It is acceptable to inspect the DOM and then choose selectors dynamically based on what you find.",
    "If login is required, detect the login page, fill the credentials, submit, and verify whether authentication succeeded.",
    "When setting the time fields, inspect the modal and choose the matching hour/minute controls for start and end times.",
    "If anything fails, catch the error and return success=false with a clear human-readable error.",
    `Set timeout_sec to ${DEFAULT_PLAYWRIGHT_TIMEOUT_SECONDS} on the tool call.`,
  ].join(" ");
}

function buildAutomationPrompt({
  username,
  password,
  timeIn,
  timeOut,
}: {
  username: string;
  password: string;
  timeIn: string;
  timeOut: string;
}): string {
  return [
    `Open ${DAILY_CHECK_URL}.`,
    `If the browser lands on a WordPress login page or another auth page, log in with username \"${username}\" and password \"${password}\".`,
    `After login, ensure the active page is the HRM Daily Check app at ${DAILY_CHECK_URL}.`,
    `Open the Time In/Out workflow, find the modal or form used to submit the daily check, and set Time In to \"${timeIn}\" and Time Out to \"${timeOut}\".`,
    "Submit the form and verify whether the request succeeded by checking URL changes, network/application feedback, and any visible success or error notices.",
    "Return the required structured object from the tool code. In your final text response after the tool call, summarise the outcome in one or two short sentences.",
  ].join(" ");
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

  let sessionId: string | undefined;
  let browserLiveViewUrl: string | undefined;
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
    logStep(`Kernel browser launched. Session ID acquired: ${sessionId}.`);
    logStep(
      browserLiveViewUrl
        ? `Retrieved browser live view URL for session ${sessionId}.`
        : `Browser session ${sessionId} did not expose a live view URL.`,
    );

    onSessionReady?.({
      browserLiveViewUrl,
      headless: browserSession.headless,
    });

    const aiResult = await generateText({
      model: openai(OPENAI_MODEL),
      system: buildSystemPrompt(),
      prompt: buildAutomationPrompt({ username, password, timeIn, timeOut }),
      tools: {
        playwright_execute: playwrightExecuteTool({
          client: kernel,
          sessionId,
          toolDescription: `Execute one Playwright script against the live HRM session. Always pass timeout_sec=${DEFAULT_PLAYWRIGHT_TIMEOUT_SECONDS}.`,
        }),
      },
      stopWhen: stepCountIs(2),
      prepareStep: ({ stepNumber }) => {
        if (stepNumber === 0) {
          return {
            toolChoice: {
              type: "tool",
              toolName: "playwright_execute",
            },
          };
        }

        return {
          toolChoice: "none",
        };
      },
      experimental_onStart: () => {
        logStep(`Starting GPT-5 orchestration for ${timeIn} to ${timeOut}.`);
      },
      experimental_onStepStart: ({ stepNumber }) => {
        logStep(`Starting LLM step ${stepNumber + 1}.`);
      },
      experimental_onToolCallStart: ({ toolCall }) => {
        logStep(`Invoking ${toolCall.toolName} on the Kernel browser session.`);
      },
      experimental_onToolCallFinish: (event) => {
        if (!event.success) {
          logStep(`Tool call failed: ${toErrorMessage(event.error)}`);
          return;
        }

        const parsed = kernelToolResponseSchema.safeParse(event.output);
        if (!parsed.success) {
          logStep("Tool call finished with an unexpected output shape.");
          return;
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
      },
      onStepFinish: ({ stepNumber, finishReason }) => {
        logStep(`Completed LLM step ${stepNumber + 1} with finish reason ${finishReason}.`);
      },
      onFinish: ({ totalUsage }) => {
        logStep(
          `GPT-5 orchestration finished. Token usage: ${totalUsage.inputTokens} input / ${totalUsage.outputTokens} output.`,
        );
      },
    });

    const toolResponses = collectToolResponses(aiResult.steps);
    const toolResponse = findLatestPlaywrightToolOutput(toolResponses);

    if (!toolResponse) {
      result = withExecutionLog(
        {
          success: false,
          agentResponse: aiResult.text || "GPT-5 did not execute the Playwright tool.",
          browserLiveViewUrl,
          headless,
          error: "GPT-5 did not execute the Playwright tool, so the HRM workflow never ran.",
        },
        executionLog,
      );
      return result;
    }

    if (!toolResponse.success) {
      if (toolResponse.error && isTunnelConnectionError(toolResponse.error)) {
        throw new Error(toolResponse.error);
      }

      result = withExecutionLog(
        {
          success: false,
          agentResponse: aiResult.text || "Kernel tool execution failed.",
          browserLiveViewUrl,
          headless,
          error: toolResponse.error ?? "Kernel Playwright execution failed.",
        },
        executionLog,
      );
      return result;
    }

    const browserResultParse = browserAutomationResultSchema.safeParse(toolResponse.result);
    if (!browserResultParse.success) {
      result = withExecutionLog(
        {
          success: false,
          agentResponse: aiResult.text || "The browser workflow returned an invalid result.",
          browserLiveViewUrl,
          headless,
          error: "Kernel Playwright execution completed, but the returned automation result had an invalid shape.",
        },
        executionLog,
      );
      return result;
    }

    const browserResult: BrowserAutomationResult = browserResultParse.data;

    if (!browserResult.success) {
      result = withExecutionLog(
        {
          success: false,
          agentResponse: aiResult.text || browserResult.summary,
          foundTimeInOutButton: browserResult.foundTimeInOutButton,
          pageUrl: browserResult.pageUrl,
          browserLiveViewUrl,
          headless,
          error: browserResult.error ?? browserResult.summary,
        },
        executionLog,
        browserResult.log,
      );
      return result;
    }

    result = withExecutionLog(
      {
        success: true,
        agentResponse: aiResult.text || browserResult.summary,
        foundTimeInOutButton: browserResult.foundTimeInOutButton,
        pageUrl: browserResult.pageUrl,
        browserLiveViewUrl,
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
  const { executionLog, logStep } = createExecutionLogger();

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
