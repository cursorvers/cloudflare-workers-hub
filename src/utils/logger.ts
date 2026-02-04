/**
 * Simple logger utility for Cloudflare Workers
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Safe JSON stringification with circular reference handling
 */
function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch (error) {
    // Handle circular references
    const seen = new WeakSet();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    });
  }
}

export function logWithTimestamp(
  level: LogLevel,
  message: string,
  metadata?: Record<string, any>
): void {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...metadata,
  };

  const logString = safeStringify(logEntry);

  switch (level) {
    case 'error':
      console.error(logString);
      break;
    case 'warn':
      console.warn(logString);
      break;
    case 'info':
      console.log(logString);
      break;
    case 'debug':
      console.debug(logString);
      break;
  }
}
