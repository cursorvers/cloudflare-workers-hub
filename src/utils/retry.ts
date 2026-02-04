/**
 * Generic retry utility with exponential backoff
 */

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableStatusCodes?: number[];
  retryableErrors?: string[];
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

/**
 * Retry an async operation with exponential backoff
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const finalConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | undefined;
  let delayMs = finalConfig.initialDelayMs;

  for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // 最後のリトライで失敗したら throw
      if (attempt === finalConfig.maxRetries) {
        break;
      }

      // リトライ可能なエラーか判定
      if (error instanceof Response) {
        const statusCode = error.status;
        if (
          finalConfig.retryableStatusCodes &&
          !finalConfig.retryableStatusCodes.includes(statusCode)
        ) {
          // リトライ不可能なステータスコード
          throw error;
        }
      } else if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        const isRetryableError =
          finalConfig.retryableErrors?.some((retryableError) =>
            errorMessage.includes(retryableError.toLowerCase())
          ) ?? true; // デフォルトはリトライ可能

        if (!isRetryableError) {
          throw error;
        }
      }

      // Exponential backoff with jitter
      const jitter = Math.random() * 0.3 * delayMs;
      const totalDelay = Math.min(delayMs + jitter, finalConfig.maxDelayMs);

      console.log(
        `[Retry] Attempt ${attempt + 1}/${finalConfig.maxRetries} failed. Retrying in ${Math.round(totalDelay)}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, totalDelay));
      delayMs = Math.min(
        delayMs * finalConfig.backoffMultiplier,
        finalConfig.maxDelayMs
      );
    }
  }

  throw lastError!;
}

/**
 * Retry with detailed result (does not throw)
 */
export async function withRetryResult<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<RetryResult<T>> {
  const finalConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | undefined;
  let delayMs = finalConfig.initialDelayMs;

  for (let attempt = 0; attempt <= finalConfig.maxRetries; attempt++) {
    try {
      const data = await operation();
      return {
        success: true,
        data,
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error as Error;

      if (attempt === finalConfig.maxRetries) {
        break;
      }

      // リトライ可能なエラーか判定（同上）
      if (error instanceof Response) {
        const statusCode = error.status;
        if (
          finalConfig.retryableStatusCodes &&
          !finalConfig.retryableStatusCodes.includes(statusCode)
        ) {
          break; // リトライ不可
        }
      }

      const jitter = Math.random() * 0.3 * delayMs;
      const totalDelay = Math.min(delayMs + jitter, finalConfig.maxDelayMs);

      await new Promise((resolve) => setTimeout(resolve, totalDelay));
      delayMs = Math.min(
        delayMs * finalConfig.backoffMultiplier,
        finalConfig.maxDelayMs
      );
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: finalConfig.maxRetries + 1,
  };
}
