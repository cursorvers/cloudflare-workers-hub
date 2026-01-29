'use client';

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

export function ProviderHealth({ providers }: ProviderHealthProps) {
  if (providers.length === 0) {
    return null;
  }

  const unhealthyCount = providers.filter(
    (p) => p.status === 'unhealthy' || p.status === 'degraded'
  ).length;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 px-1 flex items-center gap-2">
        <span>プロバイダー</span>
        {unhealthyCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            {unhealthyCount} issues
          </Badge>
        )}
      </h2>

      <div className="bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {providers.map((provider) => (
            <ProviderRow key={provider.provider} provider={provider} />
          ))}
        </ul>
      </div>
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
        {provider.latencyP95Ms !== undefined && (
          <span className="font-mono">
            {provider.latencyP95Ms}ms
          </span>
        )}

        {/* Error rate */}
        {provider.errorRate !== undefined && (
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
