/**
 * Daemon Health Monitoring Handler
 *
 * Tracks active daemons with heartbeat mechanism
 */

import { Env } from '../types';
import { safeLog } from '../utils/log-sanitizer';

export interface DaemonRegistration {
  daemonId: string;
  version: string;
  capabilities: string[];
  pollInterval: number;
  registeredAt: string;
}

export interface DaemonHeartbeat {
  daemonId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  tasksProcessed: number;
  currentTask?: string;
  lastHeartbeat: string;
}

export interface DaemonState extends DaemonRegistration {
  lastHeartbeat: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  tasksProcessed: number;
  currentTask?: string;
}

const DAEMON_TTL_SEC = 60; // Consider daemon stale if no heartbeat for 60 seconds

/**
 * Register a new daemon
 */
export async function registerDaemon(
  env: Env,
  registration: DaemonRegistration
): Promise<{ success: boolean; daemonId: string; registeredAt: string }> {
  if (!env.CACHE) {
    throw new Error('KV not configured');
  }

  const state: DaemonState = {
    ...registration,
    lastHeartbeat: registration.registeredAt,
    status: 'healthy',
    tasksProcessed: 0,
  };

  const key = `daemon:state:${registration.daemonId}`;
  await env.CACHE.put(key, JSON.stringify(state), { expirationTtl: DAEMON_TTL_SEC });

  // Add to active daemons list
  await addToActiveDaemons(env, registration.daemonId);

  safeLog.log('[Daemon] Registered', {
    daemonId: registration.daemonId,
    version: registration.version,
    capabilities: registration.capabilities,
  });

  return {
    success: true,
    daemonId: registration.daemonId,
    registeredAt: registration.registeredAt,
  };
}

/**
 * Update daemon heartbeat
 */
export async function updateHeartbeat(
  env: Env,
  heartbeat: DaemonHeartbeat
): Promise<{ success: boolean }> {
  if (!env.CACHE) {
    throw new Error('KV not configured');
  }

  const key = `daemon:state:${heartbeat.daemonId}`;
  const existing = await env.CACHE.get<DaemonState>(key, 'json');

  if (!existing) {
    safeLog.warn('[Daemon] Heartbeat for unregistered daemon', { daemonId: heartbeat.daemonId });
    return { success: false };
  }

  // Update state
  const updated: DaemonState = {
    ...existing,
    lastHeartbeat: heartbeat.lastHeartbeat,
    status: heartbeat.status,
    tasksProcessed: heartbeat.tasksProcessed,
    currentTask: heartbeat.currentTask,
  };

  await env.CACHE.put(key, JSON.stringify(updated), { expirationTtl: DAEMON_TTL_SEC });

  return { success: true };
}

/**
 * Get health status of all daemons
 *
 * OPTIMIZED: Uses Promise.all for parallel KV reads instead of sequential N+1
 */
export async function getDaemonHealth(env: Env): Promise<{
  activeDaemons: DaemonState[];
  stale: DaemonState[];
  totalActive: number;
}> {
  if (!env.CACHE) {
    throw new Error('KV not configured');
  }

  const activeDaemonIds = await getActiveDaemons(env);
  const now = Date.now();

  // OPTIMIZATION: Fetch all daemon states in parallel instead of sequential N+1
  const kv = env.CACHE;
  const statePromises = activeDaemonIds.map(daemonId => {
    const key = `daemon:state:${daemonId}`;
    return kv.get<DaemonState>(key, 'json').then(state => ({
      daemonId,
      state,
    }));
  });

  const results = await Promise.all(statePromises);

  const activeDaemons: DaemonState[] = [];
  const staleDaemons: DaemonState[] = [];
  const expiredDaemonIds: string[] = [];
  const staleDaemonIds: string[] = [];

  for (const { daemonId, state } of results) {
    if (!state) {
      // Daemon expired, mark for removal
      expiredDaemonIds.push(daemonId);
      continue;
    }

    const lastHeartbeatTime = new Date(state.lastHeartbeat).getTime();
    const ageSeconds = (now - lastHeartbeatTime) / 1000;

    if (ageSeconds > DAEMON_TTL_SEC) {
      staleDaemons.push(state);
      staleDaemonIds.push(daemonId);
    } else {
      activeDaemons.push(state);
    }
  }

  // Batch cleanup: remove expired and stale daemons in parallel
  const allToRemove = [...expiredDaemonIds, ...staleDaemonIds];
  if (allToRemove.length > 0) {
    await removeMultipleFromActiveDaemons(env, allToRemove);
  }

  return {
    activeDaemons,
    stale: staleDaemons,
    totalActive: activeDaemons.length,
  };
}

/**
 * Add daemon to active list
 */
async function addToActiveDaemons(env: Env, daemonId: string): Promise<void> {
  if (!env.CACHE) return;

  const activeList = await getActiveDaemons(env);
  if (!activeList.includes(daemonId)) {
    activeList.push(daemonId);
    await env.CACHE.put('daemon:active', JSON.stringify(activeList), { expirationTtl: 3600 });
  }
}

/**
 * Remove daemon from active list
 */
async function removeFromActiveDaemons(env: Env, daemonId: string): Promise<void> {
  if (!env.CACHE) return;

  const activeList = await getActiveDaemons(env);
  const filtered = activeList.filter(id => id !== daemonId);
  await env.CACHE.put('daemon:active', JSON.stringify(filtered), { expirationTtl: 3600 });
}

/**
 * Remove multiple daemons from active list (batch operation)
 * OPTIMIZATION: Single KV write instead of N writes
 */
async function removeMultipleFromActiveDaemons(env: Env, daemonIds: string[]): Promise<void> {
  if (!env.CACHE || daemonIds.length === 0) return;

  const removeSet = new Set(daemonIds);
  const activeList = await getActiveDaemons(env);
  const filtered = activeList.filter(id => !removeSet.has(id));
  await env.CACHE.put('daemon:active', JSON.stringify(filtered), { expirationTtl: 3600 });
}

/**
 * Get list of active daemon IDs
 */
async function getActiveDaemons(env: Env): Promise<string[]> {
  if (!env.CACHE) return [];

  const list = await env.CACHE.get<string[]>('daemon:active', 'json');
  return list || [];
}
