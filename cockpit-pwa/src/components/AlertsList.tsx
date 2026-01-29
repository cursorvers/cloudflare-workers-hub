'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface Alert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message?: string;
  source?: string;
  createdAt?: number;
  acknowledged?: boolean;
}

interface AlertsListProps {
  alerts: Alert[];
  onAcknowledge?: (alertId: string) => void;
  maxVisible?: number;
}

const severityConfig: Record<Alert['severity'], {
  label: string;
  variant: 'destructive' | 'secondary' | 'outline';
  icon: string;
  bgClass: string;
}> = {
  critical: {
    label: 'Critical',
    variant: 'destructive',
    icon: '🚨',
    bgClass: 'bg-red-500/10 border-red-500/30',
  },
  warning: {
    label: 'Warning',
    variant: 'secondary',
    icon: '⚠️',
    bgClass: 'bg-yellow-500/10 border-yellow-500/30',
  },
  info: {
    label: 'Info',
    variant: 'outline',
    icon: 'ℹ️',
    bgClass: 'bg-blue-500/10 border-blue-500/30',
  },
};

export function AlertsList({ alerts, onAcknowledge, maxVisible = 5 }: AlertsListProps) {
  // Filter unacknowledged alerts and sort by severity
  const activeAlerts = alerts
    .filter((a) => !a.acknowledged)
    .sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2 };
      return order[a.severity] - order[b.severity];
    })
    .slice(0, maxVisible);

  const criticalCount = activeAlerts.filter((a) => a.severity === 'critical').length;

  if (activeAlerts.length === 0) {
    return null; // Don't show section if no alerts
  }

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 px-1 flex items-center gap-2">
        <span>アラート</span>
        {criticalCount > 0 && (
          <Badge variant="destructive" className="text-xs">
            {criticalCount} critical
          </Badge>
        )}
      </h2>

      <ul className="space-y-2">
        {activeAlerts.map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onAcknowledge={onAcknowledge ? () => onAcknowledge(alert.id) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

interface AlertCardProps {
  alert: Alert;
  onAcknowledge?: () => void;
}

function AlertCard({ alert, onAcknowledge }: AlertCardProps) {
  const config = severityConfig[alert.severity];

  return (
    <li
      className={`
        rounded-xl border p-3
        ${config.bgClass}
        flex items-start gap-3
      `}
    >
      <span className="text-lg flex-shrink-0" aria-hidden="true">
        {config.icon}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant={config.variant} className="text-xs">
            {config.label}
          </Badge>
          {alert.source && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {alert.source}
            </span>
          )}
        </div>
        <p className="font-medium text-zinc-900 dark:text-zinc-100 mt-1">
          {alert.title}
        </p>
        {alert.message && (
          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5 line-clamp-2">
            {alert.message}
          </p>
        )}
      </div>

      {onAcknowledge && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onAcknowledge}
          className="flex-shrink-0 text-xs h-7"
        >
          確認
        </Button>
      )}
    </li>
  );
}
