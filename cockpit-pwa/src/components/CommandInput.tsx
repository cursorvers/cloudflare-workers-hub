'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';

interface CommandInputProps {
  onSend: (command: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Command input for sending messages to the orchestrator
 * Mobile-optimized with bottom fixed position
 */
export function CommandInput({
  onSend,
  disabled = false,
  placeholder = 'コマンドを入力...',
}: CommandInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [input]);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (trimmed && !disabled) {
      onSend(trimmed);
      setInput('');
    }
  }, [input, onSend, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Submit on Enter (without Shift)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div className="bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 p-3 pb-safe glass">
      <div className="flex items-end gap-2">
        {/* Input field */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={`
              w-full
              bg-zinc-100 dark:bg-zinc-800
              border border-zinc-200 dark:border-zinc-700
              rounded-xl
              px-4 py-2.5
              text-sm
              resize-none
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
              placeholder:text-zinc-500 dark:placeholder:text-zinc-400
              disabled:opacity-50
              transition-all duration-200
            `}
          />
        </div>

        {/* Send button with glow effect when enabled */}
        <Button
          onClick={handleSubmit}
          disabled={disabled || !input.trim()}
          className={`h-10 px-4 rounded-xl flex-shrink-0 transition-all duration-200 ${!disabled && input.trim() ? 'glow' : ''}`}
        >
          <span className="sr-only">送信</span>
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
        </Button>
      </div>

      {/* Quick actions */}
      <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
        <QuickAction
          label="/status"
          onClick={() => onSend('/status')}
          disabled={disabled}
        />
        <QuickAction
          label="/tasks"
          onClick={() => onSend('/tasks')}
          disabled={disabled}
        />
        <QuickAction
          label="/git"
          onClick={() => onSend('/git')}
          disabled={disabled}
        />
        <QuickAction
          label="/help"
          onClick={() => onSend('/help')}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

interface QuickActionProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function QuickAction({ label, onClick, disabled }: QuickActionProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        px-4 py-2.5
        min-h-[44px] min-w-[44px]
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
      `}
    >
      {label}
    </button>
  );
}
