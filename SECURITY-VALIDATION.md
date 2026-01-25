# URL Path Parameter Validation - Security Implementation

## Overview

This implementation adds comprehensive validation for URL path parameters extracted via regex patterns to prevent injection attacks and ensure data integrity.

## What Was Added

### 1. Path Parameter Schemas (`src/schemas/path-params.ts`)

Four Zod schemas for validating different types of path parameters:

- **UserIdPathSchema**: Alphanumeric + hyphens + underscores, 1-64 chars
- **TaskIdPathSchema**: Alphanumeric + hyphens, 1-64 chars  
- **ChannelPathSchema**: Lowercase alphanumeric + hyphens, 1-32 chars
- **GenericIdPathSchema**: Alphanumeric + hyphens + underscores, 1-64 chars

### 2. Validation Helper Function (`src/schemas/validation-helper.ts`)

`validatePathParameter()` function that:
- Validates path parameters against Zod schemas
- Returns typed success/error results
- Logs validation failures with sanitized values (first 16 chars only)
- Provides user-friendly error responses

### 3. Handler Updates

Applied validation to all path parameters in:

#### `src/handlers/cron-api.ts`
- `userId` in `/api/cron/tasks/:userId` (6 occurrences)
- `taskId` in `/api/cron/task/:id/*` (5 occurrences)

#### `src/handlers/queue.ts`
- `taskId` in `/api/queue/:taskId/*` (6 occurrences)
- `taskId` in `/api/result/:taskId` (2 occurrences)

#### `src/handlers/memory-api.ts`
- `userId` in `/api/memory/context/:userId` and `/api/memory/history/:userId` (3 occurrences)
- `channel` query parameter validation (2 occurrences)

### 4. Comprehensive Tests

#### `src/schemas/path-params.test.ts` (12 test suites)
- Valid/invalid input tests for each schema
- Security tests for:
  - Path traversal prevention (`../`, `../../etc/passwd`)
  - Command injection prevention (`;`, `|`, `` ` ``, `$()`)
  - SQL injection prevention (`' OR '1'='1`, `DROP TABLE`)
  - XSS prevention (`<script>`, `<img onerror>`)

#### `src/schemas/validation.test.ts` (5 new tests)
- `validatePathParameter()` function behavior
- Error response format
- Value sanitization in logs
- Special character handling

## Security Benefits

### Before
```typescript
const userId = userTasksMatch[1]; // No validation
// Accepts: "../etc/passwd", "user;rm -rf", "<script>alert(1)</script>"
```

### After
```typescript
const userId = userTasksMatch[1];
const validation = validatePathParameter(userId, UserIdPathSchema, 'userId', '/api/cron/tasks/:userId');
if (!validation.success) {
  return validation.response; // 400 Bad Request with details
}
// Only accepts: "user-123", "U01ABC123", etc.
```

## Attack Vectors Prevented

| Attack Type | Example | Blocked By |
|-------------|---------|------------|
| Path Traversal | `../etc/passwd` | Regex validation (no `/` or `.` allowed) |
| Command Injection | `; rm -rf /` | Regex validation (no `;`, `|`, etc.) |
| SQL Injection | `' OR '1'='1` | Regex validation (no `'` or spaces) |
| XSS | `<script>alert(1)</script>` | Regex validation (no `<`, `>`, etc.) |
| Length-based DoS | 10,000 char string | Max length limits (32-64 chars) |
| Unicode bypass | `％２ｅ％２ｅ／` | Only ASCII alphanumeric allowed |

## Performance Impact

- **Minimal overhead**: Regex validation is O(n) where n = input length (max 64)
- **Early rejection**: Invalid inputs fail fast before DB/KV lookups
- **No external dependencies**: Uses native Zod validation

## Test Coverage

```
✓ src/schemas/path-params.test.ts (12 tests)
✓ src/schemas/validation.test.ts (19 tests, 5 new)
✓ All 119 tests passing
```

## Migration Notes

- **No breaking changes**: All existing valid IDs remain valid
- **Stricter validation**: May reject previously accepted invalid IDs
- **Error responses**: Now returns 400 instead of processing invalid IDs

## Example Usage

```typescript
import { validatePathParameter } from '../schemas/validation-helper';
import { UserIdPathSchema } from '../schemas/path-params';

const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
if (userMatch) {
  const userId = userMatch[1];
  
  // SECURITY: Validate userId format
  const validation = validatePathParameter(userId, UserIdPathSchema, 'userId', '/api/users/:userId');
  if (!validation.success) {
    return validation.response; // 400 with error details
  }
  
  // Proceed with validated userId
  const user = await getUser(validation.data);
}
```

## Related Files

- `src/schemas/path-params.ts` - Schema definitions
- `src/schemas/validation-helper.ts` - Validation function
- `src/handlers/cron-api.ts` - Cron API with validation
- `src/handlers/queue.ts` - Queue API with validation
- `src/handlers/memory-api.ts` - Memory API with validation
- `src/schemas/path-params.test.ts` - Schema tests
- `src/schemas/validation.test.ts` - Helper function tests

## References

- OWASP: [Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- CWE-20: Improper Input Validation
- CWE-22: Improper Limitation of a Pathname to a Restricted Directory
- CWE-89: SQL Injection
- CWE-79: Cross-site Scripting (XSS)
