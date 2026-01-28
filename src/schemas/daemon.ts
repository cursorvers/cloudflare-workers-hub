/**
 * Zod validation schemas for Daemon API
 */

import { z } from 'zod';

/**
 * Zod schema for daemon registration payload validation
 *
 * @remarks
 * Validates daemon registration data including ID, version, capabilities,
 * poll interval (1s-5min), and registration timestamp.
 */
export const DaemonRegistrationSchema = z.object({
  daemonId: z.string().min(1, 'Daemon ID is required'),
  version: z.string().min(1, 'Version is required'),
  capabilities: z.array(z.string()).min(1, 'At least one capability is required'),
  pollInterval: z.number().int().min(1000).max(300000), // 1 second to 5 minutes
  registeredAt: z.string().datetime(),
});

export type DaemonRegistrationInput = z.infer<typeof DaemonRegistrationSchema>;

/**
 * Zod schema for daemon heartbeat payload validation
 *
 * @remarks
 * Validates heartbeat data including status (healthy/degraded/unhealthy),
 * task processing metrics, and timestamp.
 */
export const DaemonHeartbeatSchema = z.object({
  daemonId: z.string().min(1, 'Daemon ID is required'),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  tasksProcessed: z.number().int().min(0),
  currentTask: z.string().optional(),
  lastHeartbeat: z.string().datetime(),
});

export type DaemonHeartbeatInput = z.infer<typeof DaemonHeartbeatSchema>;
