/**
 * Password Authentication Utilities
 *
 * Implements secure password hashing and verification using Web Crypto API.
 * Uses PBKDF2 with SHA-256 for password hashing (chosen for Workers environment compatibility).
 *
 * ## Security Features
 * - PBKDF2-SHA256 with 100,000 iterations
 * - Random salt generation (16 bytes)
 * - Constant-time comparison for timing attack prevention
 * - Password strength validation (min 8 chars, complexity requirements)
 *
 * ## Storage Format
 * Hashed password format: `pbkdf2:iterations:salt:hash`
 * Example: `pbkdf2:100000:1a2b3c4d:5e6f7g8h`
 */

import { z } from 'zod';

// =============================================================================
// Configuration
// =============================================================================

const PBKDF2_ITERATIONS = 100000; // OWASP recommended minimum
const SALT_LENGTH = 16; // bytes
const HASH_LENGTH = 32; // bytes

// =============================================================================
// Password Validation
// =============================================================================

export const PasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(
    /[^A-Za-z0-9]/,
    'Password must contain at least one special character'
  );

// =============================================================================
// Hashing Functions
// =============================================================================

/**
 * Generate random salt
 */
function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Convert Uint8Array to hex string
 */
function toHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array
 */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Hash password using PBKDF2-SHA256
 */
export async function hashPassword(password: string): Promise<string> {
  // Validate password strength
  const validationResult = PasswordSchema.safeParse(password);
  if (!validationResult.success) {
    throw new Error(
      `Password validation failed: ${validationResult.error.errors
        .map((e) => e.message)
        .join(', ')}`
    );
  }

  // Generate salt
  const salt = generateSalt();

  // Import password as key
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  // Derive hash using PBKDF2
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    HASH_LENGTH * 8
  );

  // Format: pbkdf2:iterations:salt:hash
  return `pbkdf2:${PBKDF2_ITERATIONS}:${toHex(salt)}:${toHex(
    new Uint8Array(hashBuffer)
  )}`;
}

/**
 * Verify password against hash
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyPassword(
  password: string,
  hashedPassword: string
): Promise<boolean> {
  try {
    // Parse stored hash
    const [algorithm, iterationsStr, saltHex, hashHex] =
      hashedPassword.split(':');

    if (algorithm !== 'pbkdf2') {
      throw new Error('Unsupported hash algorithm');
    }

    const iterations = parseInt(iterationsStr, 10);
    const salt = fromHex(saltHex);
    const storedHash = fromHex(hashHex);

    // Import password as key
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );

    // Derive hash using same parameters
    const hashBuffer = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt,
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      HASH_LENGTH * 8
    );

    const computedHash = new Uint8Array(hashBuffer);

    // Constant-time comparison
    if (computedHash.length !== storedHash.length) {
      return false;
    }

    let mismatch = 0;
    for (let i = 0; i < computedHash.length; i++) {
      mismatch |= computedHash[i] ^ storedHash[i];
    }

    return mismatch === 0;
  } catch (error) {
    // Log error but don't expose details to prevent information leakage
    console.error('Password verification error:', error);
    return false;
  }
}

/**
 * Check if password needs rehashing (e.g., due to increased iteration count)
 */
export function needsRehash(hashedPassword: string): boolean {
  try {
    const [algorithm, iterationsStr] = hashedPassword.split(':');
    if (algorithm !== 'pbkdf2') {
      return true; // Unsupported algorithm, needs migration
    }
    const iterations = parseInt(iterationsStr, 10);
    return iterations < PBKDF2_ITERATIONS;
  } catch {
    return true;
  }
}
