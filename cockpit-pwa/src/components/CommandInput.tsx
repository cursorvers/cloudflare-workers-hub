'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

type SendState = 'idle' | 'sending' | 'success' | 'error';

interface CommandInputProps {
  onSend: (command: string) => boolean;
  disabled?: boolean;
  placeholder?: string;
  isConnected?: boolean;
}

const MAX_HISTORY = 10;
const SEND_TIMEOUT = 5000;

// Available commands
const COMMANDS = [
  { cmd: '/status', desc: 'システム状態を確認', icon: '📊' },
  { cmd: '/tasks', desc: 'タスク一覧を更新', icon: '📋' },
  { cmd: '/git', desc: 'Git状態を確認', icon: '🔀' },
  { cmd: '/help', desc: 'ヘルプを表示', icon: '❓' },
] as const;

/**
 * Enhanced command input with feedback, history, and command guide
 */
export function CommandInput({
  onSend,
  disabled = false,
  placeholder = 'メッセージを入力... または /コマンド',
  isConnected = true,
}: CommandInputProps) {
  const [input, setInput] = useState('');
  const [sendState, setSendState] = useState<SendState>('idle');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showGuide, setShowGuide] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingInputRef = useRef<string>('');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [input]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Determine if input is a command or chat
  const isCommand = input.trim().startsWith('/');
  const isChat = input.trim().length > 0 && !isCommand;

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || disabled || sendState === 'sending') return;

    // Save to history
    setHistory((prev) => {
      const newHistory = [trimmed, ...prev.filter((h) => h !== trimmed)];
      return newHistory.slice(0, MAX_HISTORY);
    });
    setHistoryIndex(-1);

    // Store input for potential restore on error
    pendingInputRef.current = trimmed;

    // Start sending
    setSendState('sending');
    setInput('');

    // Show loading toast
    const toastId = toast.loading('送信中...', {
      description: trimmed.length > 30 ? trimmed.slice(0, 30) + '...' : trimmed,
    });

    // Set timeout for send
    timeoutRef.current = setTimeout(() => {
      setSendState('error');
      toast.error('タイムアウト', {
        id: toastId,
        description: '応答がありませんでした',
      });
      setInput(pendingInputRef.current);
    }, SEND_TIMEOUT);

    // Attempt to send
    const success = onSend(trimmed);

    if (success) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      setSendState('success');
      toast.success('送信完了', {
        id: toastId,
        description: getCommandDescription(trimmed),
      });

      setTimeout(() => setSendState('idle'), 1000);
    } else {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      setSendState('error');
      toast.error('送信失敗', {
        id: toastId,
        description: '接続を確認してください',
      });
      setInput(pendingInputRef.current);

      setTimeout(() => setSendState('idle'), 2000);
    }
  }, [input, onSend, disabled, sendState]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
        return;
      }

      if (e.key === 'ArrowUp' && history.length > 0) {
        e.preventDefault();
        const newIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(newIndex);
        setInput(history[newIndex]);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex <= 0) {
          setHistoryIndex(-1);
          setInput('');
        } else {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setInput(history[newIndex]);
        }
        return;
      }

      // Auto-complete with Tab
      if (e.key === 'Tab' && input.startsWith('/')) {
        e.preventDefault();
        const partial = input.toLowerCase();
        const match = COMMANDS.find((c) => c.cmd.startsWith(partial));
        if (match) {
          setInput(match.cmd);
        }
      }
    },
    [handleSubmit, history, historyIndex, input]
  );

  const handleQuickAction = useCallback((command: string) => {
    if (disabled || sendState === 'sending') return;

    pendingInputRef.current = command;
    setSendState('sending');

    const toastId = toast.loading('送信中...', {
      description: command,
    });

    timeoutRef.current = setTimeout(() => {
      setSendState('error');
      toast.error('タイムアウト', { id: toastId });
    }, SEND_TIMEOUT);

    const success = onSend(command);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (success) {
      setSendState('success');
      toast.success('送信完了', {
        id: toastId,
        description: getCommandDescription(command),
      });
      setTimeout(() => setSendState('idle'), 1000);
    } else {
      setSendState('error');
      toast.error('送信失敗', { id: toastId });
      setTimeout(() => setSendState('idle'), 2000);
    }
  }, [onSend, disabled, sendState]);

  const isSending = sendState === 'sending';
  const isDisabled = disabled || isSending;

  return (
    <div className="bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 p-3 pb-safe glass">
      {/* Offline banner */}
      {!isConnected && (
        <div className="mb-3 p-2 bg-red-500/10 border border-red-500/30 rounded-lg text-center text-sm text-red-400 animate-fade-in">
          <span className="inline-flex items-center gap-2">
            <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            オフラインです。接続を待機中...
          </span>
        </div>
      )}

      {/* Command guide (expandable) */}
      {showGuide && (
        <div className="mb-3 p-3 bg-zinc-100 dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 animate-fade-in">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              📖 コマンド一覧
            </h3>
            <button
              onClick={() => setShowGuide(false)}
              className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
          <div className="space-y-1">
            {COMMANDS.map(({ cmd, desc, icon }) => (
              <button
                key={cmd}
                onClick={() => {
                  setInput(cmd);
                  setShowGuide(false);
                  textareaRef.current?.focus();
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 text-left tap-scale"
              >
                <span>{icon}</span>
                <span className="font-mono text-sm text-blue-500">{cmd}</span>
                <span className="text-xs text-zinc-500">{desc}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-400">
            💡 Tabキーで補完、↑↓キーで履歴
          </p>
        </div>
      )}

      {/* Chat mode indicator */}
      {isChat && (
        <div className="mb-2 px-3 py-1.5 bg-blue-500/10 border border-blue-500/30 rounded-lg text-xs text-blue-600 dark:text-blue-400 animate-fade-in">
          💬 チャットメッセージとして送信されます
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Help button */}
        <button
          onClick={() => setShowGuide(!showGuide)}
          className={`
            h-10 w-10 flex-shrink-0 rounded-xl
            flex items-center justify-center
            bg-zinc-100 dark:bg-zinc-800
            border border-zinc-200 dark:border-zinc-700
            text-zinc-500 dark:text-zinc-400
            hover:bg-zinc-200 dark:hover:bg-zinc-700
            tap-scale transition-all
            ${showGuide ? 'ring-2 ring-blue-500' : ''}
          `}
          title="コマンド一覧を表示"
        >
          <span className="text-lg">?</span>
        </button>

        {/* Input field */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => input === '' && setShowGuide(true)}
            placeholder={isConnected ? placeholder : '接続中...'}
            disabled={isDisabled}
            rows={1}
            className={`
              w-full
              bg-zinc-100 dark:bg-zinc-800
              border border-zinc-200 dark:border-zinc-700
              rounded-xl
              px-4 py-2.5
              text-sm font-mono
              resize-none
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
              placeholder:text-zinc-500 dark:placeholder:text-zinc-400
              placeholder:font-sans
              disabled:opacity-50
              transition-all duration-200
              ${isSending ? 'animate-pulse' : ''}
              ${isChat ? 'border-blue-500/50' : ''}
            `}
          />
          {/* History indicator */}
          {historyIndex >= 0 && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-400">
              {historyIndex + 1}/{history.length}
            </div>
          )}
        </div>

        {/* Send button */}
        <Button
          onClick={handleSubmit}
          disabled={isDisabled || !input.trim()}
          className={`
            h-10 px-4 rounded-xl flex-shrink-0 transition-all duration-200
            ${!isDisabled && input.trim() ? 'glow' : ''}
            ${isSending ? 'animate-pulse' : ''}
            ${isChat ? 'bg-blue-600 hover:bg-blue-700' : ''}
          `}
        >
          <span className="sr-only">送信</span>
          {isSending ? (
            <Spinner className="w-5 h-5" />
          ) : sendState === 'success' ? (
            <CheckIcon className="w-5 h-5 text-green-500" />
          ) : sendState === 'error' ? (
            <XIcon className="w-5 h-5 text-red-500" />
          ) : (
            <SendIcon className="w-5 h-5" />
          )}
        </Button>
      </div>

      {/* Quick actions */}
      <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
        {COMMANDS.map(({ cmd, desc, icon }) => (
          <QuickAction
            key={cmd}
            label={cmd}
            icon={icon}
            onClick={() => handleQuickAction(cmd)}
            disabled={isDisabled}
            description={desc}
          />
        ))}
      </div>
    </div>
  );
}

interface QuickActionProps {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  description?: string;
}

function QuickAction({ label, icon, onClick, disabled, description }: QuickActionProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={description}
      className={`
        px-3 py-2
        min-h-[44px]
        bg-zinc-100 dark:bg-zinc-800
        border border-zinc-200 dark:border-zinc-700
        rounded-full
        text-xs font-medium
        text-zinc-600 dark:text-zinc-400
        hover:bg-zinc-200 dark:hover:bg-zinc-700
        hover:border-zinc-300 dark:hover:border-zinc-600
        tap-scale
        transition-all duration-150
        disabled:opacity-50
        flex-shrink-0
        flex items-center gap-1.5
      `}
    >
      <span>{icon}</span>
      <span className="font-mono">{label}</span>
    </button>
  );
}

// Icon components
function SendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
    </svg>
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

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function getCommandDescription(input: string): string {
  if (input.startsWith('/')) {
    const cmd = input.slice(1).split(' ')[0];
    const found = COMMANDS.find((c) => c.cmd === `/${cmd}`);
    return found?.desc || `コマンド: ${cmd}`;
  }
  // Chat message
  const preview = input.length > 30 ? input.slice(0, 30) + '...' : input;
  return `チャット: ${preview}`;
}
