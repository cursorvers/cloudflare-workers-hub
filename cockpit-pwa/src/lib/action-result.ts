/**
 * Result Pattern for Server Actions
 *
 * Unified error handling: Server Actions return Result<T> instead of throwing exceptions.
 * UI can handle success/failure cases explicitly.
 */

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: string };

export function success<T>(data: T): ActionResult<T> {
  return { success: true, data };
}

export function failure<T = never>(
  error: string,
  code?: string
): ActionResult<T> {
  return { success: false, error, code };
}

/**
 * Wrap async operation with try-catch and return Result
 */
export async function wrapAction<T>(
  fn: () => Promise<T>
): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return success(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    return failure(message);
  }
}
