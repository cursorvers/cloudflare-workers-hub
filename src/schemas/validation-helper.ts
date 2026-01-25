/**
 * Helper functions for Zod validation in API handlers
 */

import { ZodSchema, ZodError } from 'zod';
import { safeLog } from '../utils/log-sanitizer';

/**
 * Validate request body against a Zod schema
 * Returns parsed data on success, or error Response on failure
 */
export async function validateRequestBody<T>(
  request: Request,
  schema: ZodSchema<T>,
  endpoint: string
): Promise<{ success: true; data: T } | { success: false; response: Response }> {
  let body: unknown;

  try {
    body = await request.json();
  } catch (error) {
    safeLog.warn(`[Validation] Invalid JSON body`, { endpoint, error: String(error) });
    return {
      success: false,
      response: new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  const result = schema.safeParse(body);

  if (!result.success) {
    const errors = formatZodErrors(result.error);
    safeLog.warn(`[Validation] Request validation failed`, { endpoint, errors });

    return {
      success: false,
      response: new Response(
        JSON.stringify({
          error: 'Validation failed',
          details: errors
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  return { success: true, data: result.data };
}

/**
 * Format Zod validation errors into user-friendly messages
 */
function formatZodErrors(error: ZodError): string[] {
  return error.errors.map(err => {
    const path = err.path.join('.');
    return path ? `${path}: ${err.message}` : err.message;
  });
}
