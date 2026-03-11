import { z } from "zod";

const timeValueSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

export const timeInOutRequestSchema = z.object({
  timeIn: timeValueSchema.optional(),
  timeOut: timeValueSchema.optional(),
});

export const timeInOutResultSchema = z.object({
  success: z.boolean(),
  timeIn: timeValueSchema.optional(),
  timeOut: timeValueSchema.optional(),
  executionLog: z.array(z.string()).optional(),
  agentResponse: z.string().optional(),
  foundTimeInOutButton: z.boolean().optional(),
  pageUrl: z.string().optional(),
  browserLiveViewUrl: z.string().optional(),
  headless: z.boolean().optional(),
  error: z.string().optional(),
});

export const timeInOutJobStatusSchema = z.object({
  jobId: z.string(),
  status: z.enum(["starting", "running", "completed", "failed"]),
  browserLiveViewUrl: z.string().optional(),
  headless: z.boolean().optional(),
  result: timeInOutResultSchema.optional(),
});

export type TimeInOutRequest = z.infer<typeof timeInOutRequestSchema>;
export type TimeInOutResult = z.infer<typeof timeInOutResultSchema>;
export type TimeInOutJobStatus = z.infer<typeof timeInOutJobStatusSchema>;