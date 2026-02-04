/**
 * Retry Utility for Error Handling
 *
 * Implements exponential backoff for transient failures
 */

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  retryableErrors?: string[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelay: 100,
  maxDelay: 5000,
  backoffFactor: 2,
  retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'D1_ERROR'],
};

/**
 * Execute function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;
  let delay = opts.initialDelay;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      const isRetryable = opts.retryableErrors.some((pattern) =>
        lastError!.message.includes(pattern)
      );

      // Don't retry on last attempt or non-retryable errors
      if (attempt === opts.maxAttempts || !isRetryable) {
        throw lastError;
      }

      // Wait before retry with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * opts.backoffFactor, opts.maxDelay);
    }
  }

  throw lastError || new Error('Retry failed');
}

/**
 * Check if error is transient (retryable)
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const transientPatterns = [
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'D1_ERROR',
    'timeout',
    'ECONNRESET',
    'ETIMEDOUT',
  ];

  return transientPatterns.some((pattern) =>
    error.message.toLowerCase().includes(pattern.toLowerCase())
  );
}
