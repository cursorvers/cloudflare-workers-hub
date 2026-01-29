# JWT Authentication & RBAC Implementation

## Overview

This document describes the JWT-based authentication and Role-Based Access Control (RBAC) system implemented for the Cockpit API.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Authentication Flow                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. POST /api/cockpit/auth/login                            │
│     └─> Verify credentials (email lookup in D1)            │
│     └─> Generate JWT access token (15 min expiry)          │
│     └─> Generate refresh token (7 days expiry, stored in D1)│
│                                                              │
│  2. API Request with JWT                                     │
│     └─> Extract JWT from Authorization: Bearer header      │
│     └─> Verify signature (RS256 prod / HS256 dev)          │
│     └─> Check expiration, issuer, audience                  │
│     └─> Extract user ID and role                            │
│                                                              │
│  3. RBAC Authorization                                       │
│     └─> Check role permissions for endpoint                 │
│     └─> Log audit event (success or denied)                 │
│                                                              │
│  4. Refresh Token Rotation                                   │
│     └─> POST /api/cockpit/auth/refresh                      │
│     └─> Verify old refresh token                            │
│     └─> Revoke old token                                     │
│     └─> Issue new refresh token                             │
│     └─> Issue new access token                              │
└─────────────────────────────────────────────────────────────┘
```

## Security Features

### JWT Verification
- **Signature Verification**: Uses `jose` library (Cloudflare Workers compatible)
- **Expiration Check**: Access tokens expire after 15 minutes
- **Issuer/Audience Validation**: Prevents token misuse
- **Algorithm**: RS256 (asymmetric) for production, HS256 (symmetric) for development

### Refresh Token Rotation
- Refresh tokens are single-use
- Automatically revoked after use
- New refresh token issued on rotation
- Stored in D1 database with expiration timestamp
- Expired tokens automatically cleaned up via trigger

### RBAC (Role-Based Access Control)
- Three roles: `admin`, `operator`, `viewer`
- Permission matrix defines allowed endpoints per role
- Audit logging for all access attempts

## Database Schema

### cockpit_users
```sql
CREATE TABLE cockpit_users (
  user_id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'viewer')) DEFAULT 'viewer',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  is_active INTEGER DEFAULT 1
);
```

### cockpit_refresh_tokens
```sql
CREATE TABLE cockpit_refresh_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (user_id) REFERENCES cockpit_users(user_id) ON DELETE CASCADE
);
```

### cockpit_audit_log
```sql
CREATE TABLE cockpit_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT NOT NULL CHECK(status IN ('success', 'denied', 'error')),
  error_message TEXT,
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (user_id) REFERENCES cockpit_users(user_id) ON DELETE SET NULL
);
```

## Permission Matrix

| Endpoint | admin | operator | viewer |
|----------|-------|----------|--------|
| `GET /api/cockpit/tasks` | ✅ | ✅ | ✅ |
| `POST /api/cockpit/tasks` | ✅ | ✅ | ❌ |
| `DELETE /api/cockpit/tasks` | ✅ | ❌ | ❌ |
| `GET /api/cockpit/repos` | ✅ | ✅ | ✅ |
| `GET /api/cockpit/alerts` | ✅ | ✅ | ✅ |
| `POST /api/cockpit/alerts/ack/:id` | ✅ | ✅ | ❌ |
| `WS /ws` (WebSocket) | ✅ | ✅ | ❌ |

## API Usage

### 1. Login (Get JWT)

```bash
curl -X POST https://your-worker.workers.dev/api/cockpit/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@cockpit.local"
  }'
```

Response:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "550e8400-e29b-41d4-a716-446655440000",
  "expiresIn": 900,
  "user": {
    "id": "admin-default",
    "role": "admin"
  }
}
```

### 2. Make Authenticated Request

```bash
curl https://your-worker.workers.dev/api/cockpit/tasks \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### 3. Refresh Token

```bash
curl -X POST https://your-worker.workers.dev/api/cockpit/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refreshToken": "550e8400-e29b-41d4-a716-446655440000"
  }'
```

Response:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "660f9511-f3ac-52e5-b827-557766551111",
  "expiresIn": 900
}
```

### 4. WebSocket Connection

```javascript
const ws = new WebSocket('wss://your-worker.workers.dev/ws?token=YOUR_JWT_TOKEN');

ws.onopen = () => {
  // Send agent status
  ws.send(JSON.stringify({
    type: 'agent-status',
    agentId: 'local-agent-1',
    status: 'online',
    capabilities: ['git-monitor', 'task-executor']
  }));
};
```

## Environment Variables

Add to `wrangler.toml` or Cloudflare dashboard:

### Development (HS256)
```toml
[vars]
JWT_SECRET = "your-secret-key-change-in-production"
```

### Production (RS256)
Generate RSA key pair:
```bash
# Generate private key
openssl genpkey -algorithm RSA -out private_key.pem -pkeyopt rsa_keygen_bits:2048

# Extract public key
openssl rsa -pubout -in private_key.pem -out public_key.pem
```

Add as secrets (NOT in wrangler.toml):
```bash
wrangler secret put JWT_PRIVATE_KEY < private_key.pem
wrangler secret put JWT_PUBLIC_KEY < public_key.pem
```

## Migration

Apply the RBAC migration:

```bash
# Local
wrangler d1 migrations apply knowledge-base --local

# Production
wrangler d1 migrations apply knowledge-base --remote
```

## Default Admin User

The migration creates a default admin user:
- Email: `admin@cockpit.local`
- User ID: `admin-default`
- Role: `admin`

**⚠️ IMPORTANT**: In production, implement proper password authentication in `handleLogin()` and create a real admin user.

## Audit Trail

All API access is logged to `cockpit_audit_log`:

```sql
SELECT user_id, action, endpoint, status, timestamp
FROM cockpit_audit_log
WHERE status = 'denied'
ORDER BY timestamp DESC
LIMIT 100;
```

## WebSocket Authentication

WebSocket connections require JWT token:

1. Pass token as query parameter: `?token=YOUR_JWT_TOKEN`
2. Or in `Authorization: Bearer` header during upgrade
3. Token is verified before WebSocket upgrade
4. User ID and role are stored in connection session

## Testing

Run the test script:

```bash
npx tsx scripts/test-jwt-auth.ts
```

Output:
```
🔐 Testing JWT Authentication...

Test 1: Generate Access Token
✅ Access token generated: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

Test 2: Verify Access Token
✅ Token verified successfully
   User ID: test-user-123
   Role: admin
   Issuer: cloudflare-workers-hub
   Audience: cockpit-api
   Expires: 2026-01-29T12:15:00.000Z

Test 3: Verify Invalid Token
✅ Invalid token correctly rejected

Test 4: RBAC Permission Checks
   ✅ GET /api/cockpit/tasks [viewer]: ALLOWED
   ✅ POST /api/cockpit/tasks [viewer]: DENIED
   ✅ POST /api/cockpit/tasks [operator]: ALLOWED
   ✅ DELETE /api/cockpit/tasks [operator]: DENIED
   ✅ DELETE /api/cockpit/tasks [admin]: ALLOWED

🎉 All tests completed!
```

## Security Best Practices

1. **Use RS256 in Production**: Asymmetric signatures prevent token forgery
2. **Short-lived Access Tokens**: 15 minutes reduces exposure window
3. **Refresh Token Rotation**: Single-use refresh tokens prevent replay attacks
4. **Audit Logging**: Track all access attempts for security monitoring
5. **HTTPS Only**: Always use HTTPS for JWT transmission
6. **Secure Token Storage**: Store tokens in httpOnly cookies (client-side)
7. **Regular Key Rotation**: Rotate JWT keys periodically

## Troubleshooting

### "Invalid or expired token"
- Token may have expired (15 minutes)
- Use refresh token to get new access token
- Check issuer/audience claims match

### "Insufficient permissions"
- Check user role in database
- Verify permission matrix allows the endpoint
- Review audit log for denied access

### "Database not available"
- Ensure D1 binding is configured
- Run migrations
- Check D1 database exists

## Future Enhancements

1. **Password Authentication**: Add password hashing (bcrypt) to login
2. **Multi-Factor Authentication (MFA)**: Add 2FA support
3. **OAuth Integration**: Allow GitHub/Google login
4. **API Key Management**: Allow users to generate API keys
5. **Rate Limiting**: Add per-user rate limits
6. **Session Management**: Track active sessions
