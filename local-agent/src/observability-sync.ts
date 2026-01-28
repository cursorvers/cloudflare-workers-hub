/**
 * Observability Sync Module
 *
 * Reads telemetry data from local SQLite and syncs to Workers Hub via WebSocket
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = join(homedir(), '.claude', 'state', 'observability.db');

export interface ProviderHealth {
  provider: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  latency_p95_ms?: number;
  error_rate?: number;
  last_request_at?: number;
}

export interface CostData {
  date: string;
  provider: string;
  call_count: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface RequestSample {
  timestamp: number;
  provider: string;
  agent?: string;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  status?: 'success' | 'error' | 'timeout';
  error_message?: string;
}

export interface BudgetStatus {
  provider: string;
  daily_spent_usd: number;
  weekly_spent_usd?: number;
}

export interface ObservabilitySyncMessage {
  type: 'observability-sync';
  provider_health?: ProviderHealth[];
  costs?: CostData[];
  requests?: RequestSample[];
  budget_status?: BudgetStatus[];
}

/**
 * ObservabilitySync class
 * Collects and formats observability data for WebSocket sync
 */
export class ObservabilitySync {
  private db: Database.Database | null = null;
  private lastSyncTimestamp: number = 0;

  constructor() {
    this.initDb();
  }

  /**
   * Initialize database connection
   */
  private initDb(): void {
    if (!existsSync(DB_PATH)) {
      console.log('⚠️ Observability DB not found:', DB_PATH);
      return;
    }

    try {
      this.db = new Database(DB_PATH, { readonly: true });
      console.log('✅ Observability DB connected');
    } catch (error) {
      console.error('❌ Failed to connect to observability DB:', error);
    }
  }

  /**
   * Check if database is available
   */
  isAvailable(): boolean {
    return this.db !== null;
  }

  /**
   * Get provider health status
   */
  getProviderHealth(): ProviderHealth[] {
    if (!this.db) return [];

    try {
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 24);
      const cutoffStr = cutoff.toISOString();

      const stats = this.db.prepare(`
        SELECT
          provider,
          COUNT(*) as request_count,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
          MAX(timestamp) as last_request
        FROM requests
        WHERE timestamp >= ?
        GROUP BY provider
      `).all(cutoffStr) as any[];

      const providers = ['claude', 'codex', 'glm', 'gemini', 'manus'];
      const healthMap = new Map<string, ProviderHealth>();

      // Initialize all providers
      for (const p of providers) {
        healthMap.set(p, {
          provider: p,
          status: 'unknown',
        });
      }

      // Update with actual data
      for (const stat of stats) {
        const errorRate = stat.request_count > 0
          ? (stat.error_count / stat.request_count) * 100
          : 0;

        let status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' = 'healthy';
        if (errorRate > 25) status = 'unhealthy';
        else if (errorRate > 10) status = 'degraded';

        // Get P95 latency
        const p95 = this.getP95Latency(stat.provider);

        healthMap.set(stat.provider, {
          provider: stat.provider,
          status,
          latency_p95_ms: p95,
          error_rate: errorRate,
          last_request_at: stat.last_request
            ? Math.floor(new Date(stat.last_request).getTime() / 1000)
            : undefined,
        });
      }

      return Array.from(healthMap.values());
    } catch (error) {
      console.error('Failed to get provider health:', error);
      return [];
    }
  }

  /**
   * Get P95 latency for a provider
   */
  private getP95Latency(provider: string): number {
    if (!this.db) return 0;

    try {
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 24);

      const countResult = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM requests
        WHERE provider = ? AND timestamp >= ?
      `).get(provider, cutoff.toISOString()) as any;

      const totalCount = countResult?.cnt || 0;
      if (totalCount === 0) return 0;

      const p95Offset = Math.floor(totalCount * 0.95);
      const row = this.db.prepare(`
        SELECT latency_ms FROM requests
        WHERE provider = ? AND timestamp >= ?
        ORDER BY latency_ms
        LIMIT 1 OFFSET ?
      `).get(provider, cutoff.toISOString(), p95Offset) as any;

      return row?.latency_ms || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get cost data for the last 7 days
   */
  getCosts(): CostData[] {
    if (!this.db) return [];

    try {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const startDate = weekAgo.toISOString().split('T')[0];

      const rows = this.db.prepare(`
        SELECT date, provider, call_count, total_tokens, total_cost_usd
        FROM costs
        WHERE date >= ?
        ORDER BY date DESC
      `).all(startDate) as CostData[];

      return rows;
    } catch (error) {
      console.error('Failed to get costs:', error);
      return [];
    }
  }

  /**
   * Get recent request samples (for trend analysis)
   */
  getRecentRequests(limit: number = 100): RequestSample[] {
    if (!this.db) return [];

    try {
      // Only get requests since last sync
      const cutoff = this.lastSyncTimestamp > 0
        ? new Date(this.lastSyncTimestamp * 1000).toISOString()
        : new Date(Date.now() - 60 * 60 * 1000).toISOString(); // Last hour

      const rows = this.db.prepare(`
        SELECT
          strftime('%s', timestamp) as timestamp,
          provider,
          agent,
          latency_ms,
          input_tokens,
          output_tokens,
          cost_usd,
          status,
          error_message
        FROM requests
        WHERE timestamp >= ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(cutoff, limit) as any[];

      return rows.map(r => ({
        timestamp: parseInt(r.timestamp, 10),
        provider: r.provider,
        agent: r.agent,
        latency_ms: r.latency_ms,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cost_usd: r.cost_usd,
        status: r.status,
        error_message: r.error_message,
      }));
    } catch (error) {
      console.error('Failed to get recent requests:', error);
      return [];
    }
  }

  /**
   * Get budget status for all providers
   */
  getBudgetStatus(): BudgetStatus[] {
    if (!this.db) return [];

    try {
      const today = new Date().toISOString().split('T')[0];
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const weekStart = weekAgo.toISOString().split('T')[0];

      const dailyRows = this.db.prepare(`
        SELECT provider, total_cost_usd
        FROM costs
        WHERE date = ?
      `).all(today) as any[];

      const weeklyRows = this.db.prepare(`
        SELECT provider, SUM(total_cost_usd) as weekly_cost
        FROM costs
        WHERE date >= ?
        GROUP BY provider
      `).all(weekStart) as any[];

      const weeklyMap = new Map(weeklyRows.map(r => [r.provider, r.weekly_cost]));

      const providers = ['codex', 'glm', 'gemini']; // Only billable providers
      const result: BudgetStatus[] = [];

      for (const provider of providers) {
        const daily = dailyRows.find(r => r.provider === provider);
        result.push({
          provider,
          daily_spent_usd: daily?.total_cost_usd || 0,
          weekly_spent_usd: weeklyMap.get(provider) || 0,
        });
      }

      return result;
    } catch (error) {
      console.error('Failed to get budget status:', error);
      return [];
    }
  }

  /**
   * Collect all observability data for sync
   */
  collectSyncData(): ObservabilitySyncMessage {
    const message: ObservabilitySyncMessage = {
      type: 'observability-sync',
      provider_health: this.getProviderHealth(),
      costs: this.getCosts(),
      requests: this.getRecentRequests(50), // Sample of recent requests
      budget_status: this.getBudgetStatus(),
    };

    this.lastSyncTimestamp = Math.floor(Date.now() / 1000);

    return message;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
