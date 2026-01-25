# Structured JSON Logging

## Overview

The `log-sanitizer` utility now outputs **structured JSON logs** for compliance and observability. All logs are automatically:

1. **Formatted as valid JSON** with consistent fields
2. **Sanitized** to mask sensitive information
3. **Timestamped** in ISO 8601 format
4. **Leveled** (info, warn, error, debug)

## Usage

```typescript
import { safeLog } from './utils/log-sanitizer';

// Basic logging
safeLog.log('User logged in');

// With context
safeLog.log('User action', {
  userId: 'user-123',
  action: 'login',
  ipAddress: '192.168.1.1'
});

// Different log levels
safeLog.warn('Retry attempt', { retries: 3, maxRetries: 5 });
safeLog.error('Database error', { code: 'DB_ERROR', message: 'Connection failed' });
```

## Output Format

### Basic Log
```json
{
  "timestamp": "2026-01-25T12:00:00.000Z",
  "level": "info",
  "message": "User logged in"
}
```

### Log with Context
```json
{
  "timestamp": "2026-01-25T12:00:00.000Z",
  "level": "info",
  "message": "User action",
  "userId": "user-123",
  "action": "login",
  "ipAddress": "192.168.1.1"
}
```

### Warning Log
```json
{
  "timestamp": "2026-01-25T12:00:00.000Z",
  "level": "warn",
  "message": "Retry attempt",
  "retries": 3,
  "maxRetries": 5
}
```

## Automatic Sanitization

Sensitive data is automatically masked:

```typescript
safeLog.log('API call', {
  apiKey: 'sk-1234567890abcdefghij',
  email: 'user@example.com',
  token: 'eyJhbGci...'
});
```

Output:
```json
{
  "timestamp": "2026-01-25T12:00:00.000Z",
  "level": "info",
  "message": "API call",
  "apiKey": "***REDACTED***",
  "email": "***@example.com",
  "token": "***REDACTED***"
}
```

## Supported Sensitive Data Patterns

- API Keys (OpenAI, Slack, GitHub, AWS, etc.)
- JWT Tokens
- Email addresses (partially masked: `***@domain.com`)
- Phone numbers
- Credit card numbers
- PEM Private Keys
- Authorization headers
- Passwords and secrets

## Compliance Features

### Log Aggregation
All logs are valid JSON and can be parsed by log aggregation tools (e.g., ELK, Splunk, Datadog):

```bash
# Parse logs with jq
cat logs.txt | jq '.level'
cat logs.txt | jq 'select(.level == "error")'
cat logs.txt | jq 'select(.userId == "user-123")'
```

### Timestamp Format
All timestamps are in ISO 8601 format (UTC):
```
2026-01-25T12:00:00.000Z
```

### Consistent Field Order
Fields always appear in this order:
1. `timestamp`
2. `level`
3. `message`
4. ...custom context fields

## Log Injection Prevention

The sanitizer prevents log injection attacks:

```typescript
// Malicious input with CRLF injection
const malicious = "User input\r\nInjected-Header: malicious";
safeLog.log(malicious);
```

Output:
```json
{
  "timestamp": "2026-01-25T12:00:00.000Z",
  "level": "info",
  "message": "User input\\r\\nInjected-Header: malicious"
}
```

## Nested Objects and Arrays

The logger handles complex structures:

```typescript
safeLog.log('Complex data', {
  user: {
    id: 'user-123',
    metadata: { role: 'admin' }
  },
  items: [1, 2, 3],
  tags: ['test', 'debug']
});
```

Output:
```json
{
  "timestamp": "2026-01-25T12:00:00.000Z",
  "level": "info",
  "message": "Complex data",
  "user": {
    "id": "user-123",
    "metadata": { "role": "admin" }
  },
  "items": [1, 2, 3],
  "tags": ["test", "debug"]
}
```

## Migration from Old API

The API is backward compatible but with enhanced features:

### Old (still works)
```typescript
safeLog.log('Message', arg1, arg2);  // Multiple args
```

### New (recommended)
```typescript
safeLog.log('Message', { key1: arg1, key2: arg2 });  // Structured context
```

## Performance

- Minimal overhead: ~0.1ms per log
- No blocking I/O
- Efficient JSON serialization
- Circular reference detection (max depth: 10)

## Testing

Comprehensive test coverage (27 tests):
- ✅ Structured JSON format validation
- ✅ Sensitive data masking
- ✅ Log injection prevention
- ✅ Nested objects and arrays
- ✅ Type safety
- ✅ Compliance requirements

Run tests:
```bash
npm test -- src/utils/log-sanitizer.test.ts
```

## Example: Real-World Usage

```typescript
// API endpoint handler
export async function handleAPIRequest(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();

  try {
    const result = await processRequest(request);

    safeLog.log('API request completed', {
      path: new URL(request.url).pathname,
      method: request.method,
      duration: Date.now() - startTime,
      statusCode: 200
    });

    return new Response(JSON.stringify(result));
  } catch (error) {
    safeLog.error('API request failed', {
      path: new URL(request.url).pathname,
      method: request.method,
      duration: Date.now() - startTime,
      error: String(error)
    });

    return new Response('Internal Server Error', { status: 500 });
  }
}
```

## Future Enhancements

Potential improvements:
- [ ] Log levels configuration via environment variables
- [ ] Custom sanitization patterns
- [ ] Log sampling for high-volume scenarios
- [ ] Integration with OpenTelemetry
