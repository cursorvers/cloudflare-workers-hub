'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';

export interface ProviderStatus {
  provider: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  latencyP95Ms?: number;
  errorRate?: number;
  lastRequestAt?: number;
}

interface ProviderHealthProps {
  providers: ProviderStatus[];
}

const statusConfig: Record<ProviderStatus['status'], {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  icon: string;
}> = {
  healthy: { label: 'Healthy', variant: 'default', icon: '🟢' },
  degraded: { label: 'Degraded', variant: 'secondary', icon: '🟡' },
  unhealthy: { label: 'Unhealthy', variant: 'destructive', icon: '🔴' },
  unknown: { label: 'Unknown', variant: 'outline', icon: '⚪' },
};

const providerNames: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  glm: 'GLM-4.7',
  gemini: 'Gemini',
  manus: 'Manus',
};

// Format latency for human readability
function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function ProviderHealth({ providers }: ProviderHealthProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (providers.length === 0) {
    return null;
  }

  const unhealthyCount = providers.filter(
    (p) => p.status === 'unhealthy' || p.status === 'degraded'
  ).length;

  const healthyCount = providers.filter((p) => p.status === 'healthy').length;

  return (
    <div className="space-y-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full text-sm font-semibold text-zinc-700 dark:text-zinc-300 px-1 flex items-center gap-2 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
      >
        <span className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span>プロバイダー</span>
        {unhealthyCount > 0 ? (
          <Badge variant="destructive" className="text-xs">
            {unhealthyCount} issues
          </Badge>
        ) : (
          <Badge variant="default" className="text-xs">
            {healthyCount} healthy
          </Badge>
        )}
        <span className="text-xs text-zinc-400 ml-auto">
          {providers.length} providers
        </span>
      </button>

      {isExpanded && (
        <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden animate-fade-in">
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {providers.map((provider) => (
              <ProviderRow key={provider.provider} provider={provider} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface ProviderRowProps {
  provider: ProviderStatus;
}

function ProviderRow({ provider }: ProviderRowProps) {
  const config = statusConfig[provider.status];
  const displayName = providerNames[provider.provider] || provider.provider;

  return (
    <li className="flex items-center justify-between px-4 py-3">
      {/* Provider name with status icon */}
      <div className="flex items-center gap-2">
        <span className="text-sm" aria-hidden="true">
          {config.icon}
        </span>
        <span className="font-medium text-zinc-900 dark:text-zinc-100 text-sm">
          {displayName}
        </span>
      </div>

      {/* Metrics */}
      <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
        {/* Latency */}
        {provider.latencyP95Ms != null && (
          <span className="font-mono">
            {formatLatency(provider.latencyP95Ms)}
          </span>
        )}

        {/* Error rate */}
        {provider.errorRate != null && (
          <span
            className={`font-mono ${
              provider.errorRate > 5 ? 'text-red-500' : ''
            }`}
          >
            {provider.errorRate.toFixed(1)}%
          </span>
        )}

        {/* Status badge */}
        <Badge variant={config.variant} className="text-xs">
          {config.label}
        </Badge>
      </div>
    </li>
  );
}
