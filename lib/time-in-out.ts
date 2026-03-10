import { z } from "zod";

const timeValueSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);
const optionalHtmlSchema = z.string().nullable().optional();

export const timeInOutRequestSchema = z.object({
  timeIn: timeValueSchema.optional(),
  timeOut: timeValueSchema.optional(),
});

export const timeInOutResultSchema = z.object({
  success: z.boolean(),
  timeIn: timeValueSchema.optional(),
  timeOut: timeValueSchema.optional(),
  foundTimeInOutButton: z.boolean().optional(),
  loginFormHtml: optionalHtmlSchema,
  loginErrorHtml: optionalHtmlSchema,
  buttonHtml: optionalHtmlSchema,
  modalHtml: optionalHtmlSchema,
  pageUrl: z.string().optional(),
  replayId: z.string().optional(),
  replayViewUrl: z.string().optional(),
  replayError: z.string().optional(),
  browserLiveViewUrl: z.string().optional(),
  headless: z.boolean().optional(),
  error: z.string().optional(),
});

export const loginExecutionResultSchema = z.object({
  success: z.boolean(),
  loggedIn: z.boolean(),
  url: z.string(),
  loginFormHtml: optionalHtmlSchema,
  loginErrorHtml: optionalHtmlSchema,
  error: z.string().optional(),
});

export const timeInOutJobStatusSchema = z.object({
  jobId: z.string(),
  status: z.enum(["starting", "running", "completed", "failed"]),
  browserLiveViewUrl: z.string().optional(),
  replayId: z.string().optional(),
  replayViewUrl: z.string().optional(),
  replayError: z.string().optional(),
  headless: z.boolean().optional(),
  result: timeInOutResultSchema.optional(),
});

export const inspectExecutionResultSchema = z.object({
  success: z.boolean(),
  foundTimeInOutButton: z.boolean().optional(),
  buttonHtml: optionalHtmlSchema,
  modalHtml: optionalHtmlSchema,
  pageUrl: z.string().optional(),
  error: z.string().optional(),
});

export type TimeInOutRequest = z.infer<typeof timeInOutRequestSchema>;
export type TimeInOutResult = z.infer<typeof timeInOutResultSchema>;
export type TimeInOutJobStatus = z.infer<typeof timeInOutJobStatusSchema>;
export type LoginExecutionResult = z.infer<typeof loginExecutionResultSchema>;
export type InspectExecutionResult = z.infer<typeof inspectExecutionResultSchema>;