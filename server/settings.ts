import {z} from 'zod';
export const settingsSchema=z.object({
  retention_days:z.number().int().min(1).max(365),snapshot_budget_mb:z.number().int().min(1).max(8192),max_text_kb:z.number().int().min(1).max(4096),
  collaboration_mode:z.enum(['parallel','sequential']),turn_timeout_seconds:z.number().int().min(60).max(7200),
  message_quota_total_kb:z.number().int().min(1).max(1048576),message_min_interval_seconds:z.number().int().min(0).max(3600)
}).strict();
