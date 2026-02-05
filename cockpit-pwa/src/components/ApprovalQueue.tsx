'use client';

import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

interface PendingCommand {
  id: string;
  command: string;
  executor: string;
  requiresApproval: boolean;
  dangerReasons: string[];
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
}

interface ApprovalQueueProps {
  commands: PendingCommand[];
  onApprove: (id: string) => Promise<boolean>;
  onReject: (id: string) => Promise<boolean>;
}

/**
 * Approval Queue - Shows dangerous commands awaiting approval
 */
export function ApprovalQueue({ commands, onApprove, onReject }: ApprovalQueueProps) {
  const [processingId, setProcessingId] = useState<string | null>(null);

  const pendingCommands = commands.filter(c => c.requiresApproval && c.status === 'pending');

  const handleApprove = useCallback(async (id: string) => {
    setProcessingId(id);
    try {
      const success = await onApprove(id);
      if (success) {
        toast.success('承認しました', { description: 'コマンドを実行キューに追加しました' });
      } else {
        toast.error('承認に失敗しました');
      }
    } catch {
      toast.error('エラーが発生しました');
    } finally {
      setProcessingId(null);
    }
  }, [onApprove]);

  const handleReject = useCallback(async (id: string) => {
    setProcessingId(id);
    try {
      const success = await onReject(id);
      if (success) {
        toast.info('拒否しました');
      } else {
        toast.error('拒否に失敗しました');
      }
    } catch {
      toast.error('エラーが発生しました');
    } finally {
      setProcessingId(null);
    }
  }, [onReject]);

  if (pendingCommands.length === 0) {
    return null;
  }

  return (
    <section className="bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200 dark:border-amber-800 overflow-hidden animate-fade-in">
      <div className="px-4 py-2 border-b border-amber-200 dark:border-amber-800 bg-amber-100 dark:bg-amber-900/50">
        <div className="flex items-center gap-2">
          <span className="text-amber-600 dark:text-amber-400">⚠️</span>
          <h2 className="text-xs font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wide">
            承認待ち ({pendingCommands.length})
          </h2>
        </div>
      </div>
      <div className="divide-y divide-amber-200 dark:divide-amber-800">
        {pendingCommands.map((cmd) => (
          <ApprovalItem
            key={cmd.id}
            command={cmd}
            onApprove={() => handleApprove(cmd.id)}
            onReject={() => handleReject(cmd.id)}
            isProcessing={processingId === cmd.id}
          />
        ))}
      </div>
    </section>
  );
}

interface ApprovalItemProps {
  command: PendingCommand;
  onApprove: () => void;
  onReject: () => void;
  isProcessing: boolean;
}

function ApprovalItem({ command, onApprove, onReject, isProcessing }: ApprovalItemProps) {
  const [expanded, setExpanded] = useState(false);
  const timeAgo = formatTimeAgo(command.createdAt);

  return (
    <div className="p-4 space-y-3">
      {/* Command preview */}
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 bg-amber-200 dark:bg-amber-800 rounded-full flex items-center justify-center">
          <span className="text-sm">🚨</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
              {command.executor.toUpperCase()}
            </span>
            <span className="text-xs text-zinc-400">•</span>
            <span className="text-xs text-zinc-500">{timeAgo}</span>
          </div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-left w-full"
          >
            <code className="text-sm text-zinc-900 dark:text-zinc-100 font-mono break-all line-clamp-2">
              {command.command}
            </code>
          </button>
        </div>
      </div>

      {/* Danger reasons */}
      {command.dangerReasons.length > 0 && (
        <div className={`space-y-1 ${expanded ? '' : 'max-h-16 overflow-hidden'}`}>
          {command.dangerReasons.map((reason, i) => (
            <div
              key={i}
              className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400"
            >
              <span>⚠</span>
              <span>{reason}</span>
            </div>
          ))}
        </div>
      )}

      {/* Expanded view */}
      {expanded && (
        <div className="p-3 bg-zinc-900 dark:bg-black rounded-lg animate-fade-in">
          <pre className="text-xs text-green-400 font-mono whitespace-pre-wrap break-all">
            $ {command.command}
          </pre>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={onReject}
          disabled={isProcessing}
          className="flex-1"
        >
          {isProcessing ? (
            <Spinner className="w-4 h-4" />
          ) : (
            <>
              <span>✕</span>
              <span className="ml-1">拒否</span>
            </>
          )}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onApprove}
          disabled={isProcessing}
          className="flex-1 bg-green-600 hover:bg-green-700"
        >
          {isProcessing ? (
            <Spinner className="w-4 h-4" />
          ) : (
            <>
              <span>✓</span>
              <span className="ml-1">承認</span>
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return '今';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
  return `${Math.floor(seconds / 86400)}日前`;
}

export type { PendingCommand };
