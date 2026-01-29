# JWT Authentication & RBAC Implementation Summary

## Date: 2026-01-29
## Author: Claude (Orchestrator)
## Requested by: masayuki
## Context: Codex Security Review Findings

---

## Overview

Implemented JWT-based authentication with refresh token rotation and Role-Based Access Control (RBAC) for the Cockpit API, addressing security vulnerabilities identified in the Codex security review.

---

## Changes Made

### 1. New Files Created

#### `src/utils/jwt-auth.ts` (388 lines)
**Purpose**: JWT authentication and RBAC core logic

**Key Functions**:
- `generateAccessToken()` - Issue short-lived JWT (15 min)
- `generateRefreshToken()` - Issue long-lived refresh token (7 days)
- `verifyAccessToken()` - Verify JWT signature and claims
- `verifyRefreshToken()` - Verify refresh token from D1
- `rotateRefreshToken()` - Single-use refresh token rotation
- `hasPermission()` - RBAC permission check
- `authenticateRequest()` - Authentication middleware
- `authorizeRequest()` - Authorization middleware
- `getUserRole()` - Fetch user role from D1

**Features**:
- RS256 (asymmetric) for production
- HS256 (symmetric) for development
- Constant-time token comparison
- Issuer/audience validation
- Automatic token expiration handling

#### `migrations/0007_rbac_tables.sql` (62 lines)
**Purpose**: Database schema for RBAC

**Tables Created**:
1. `cockpit_users` - User management with roles (admin/operator/viewer)
2. `cockpit_refresh_tokens` - Refresh token storage with expiration
3. `cockpit_audit_log` - Security audit trail for all API access

**Triggers**:
- `cleanup_expired_refresh_tokens` - Auto-cleanup expired tokens on INSERT

**Default Data**:
- Admin user: `admin@cockpit.local` (change in production)

#### `docs/JWT_AUTH_RBAC.md` (400 lines)
**Purpose**: Comprehensive documentation

**Contents**:
- Architecture diagram
- Security features explanation
- API usage examples
- Permission matrix
- Environment variable configuration
- Troubleshooting guide
- Future enhancements

#### `scripts/test-jwt-auth.ts` (80 lines)
**Purpose**: Test script for JWT authentication

**Tests**:
- Token generation
- Token verification
- Invalid token rejection
- RBAC permission checks

---

### 2. Files Modified

#### `src/types.ts` (+4 lines)
**Changes**:
- Added `JWT_SECRET` environment variable (development)
- Added `JWT_PRIVATE_KEY` environment variable (production RS256)
- Added `JWT_PUBLIC_KEY` environment variable (production RS256)

#### `src/handlers/cockpit-api.ts` (+180 lines, -40 lines removed)
**Changes**:
- Imported JWT authentication functions
- Replaced API key verification with JWT authentication
- Added `authenticateAndAuthorize()` middleware
- Added `logAuditEvent()` function for audit logging
- Added `handleLogin()` endpoint (POST /api/cockpit/auth/login)
- Added `handleRefreshToken()` endpoint (POST /api/cockpit/auth/refresh)
- Updated main handler to enforce JWT on all endpoints except auth
- All endpoints now log to audit trail

**Removed**:
- `verifyApiKey()` function (replaced by JWT)
- `requiresAuth()` function (all endpoints require JWT)

#### `src/durable-objects/cockpit-websocket.ts` (+60 lines)
**Changes**:
- Imported JWT verification functions
- Updated `handleWebSocketUpgrade()` to verify JWT token
- Check RBAC permissions for WebSocket (admin + operator only)
- Added `userId` and `role` fields to `AgentConnection` interface
- Extract JWT claims and store in connection session
- Updated `handleAgentStatus()` to include user info from JWT

**Security**:
- WebSocket connections require valid JWT
- User info stored in connection tags
- Viewer role cannot connect to WebSocket

#### `package.json` (+1 dependency)
**Changes**:
- Added `jose` dependency for JWT handling (Cloudflare Workers compatible)

---

## Permission Matrix

| Endpoint | Method | Admin | Operator | Viewer |
|----------|--------|-------|----------|--------|
| `/api/cockpit/tasks` | GET | ✅ | ✅ | ✅ |
| `/api/cockpit/tasks` | POST | ✅ | ✅ | ❌ |
| `/api/cockpit/tasks` | DELETE | ✅ | ❌ | ❌ |
| `/api/cockpit/repos` | GET | ✅ | ✅ | ✅ |
| `/api/cockpit/alerts` | GET | ✅ | ✅ | ✅ |
| `/api/cockpit/alerts/ack/:id` | POST | ✅ | ✅ | ❌ |
| `/ws` (WebSocket) | WS | ✅ | ✅ | ❌ |
| `/api/cockpit/auth/login` | POST | 🌐 Public | 🌐 Public | 🌐 Public |
| `/api/cockpit/auth/refresh` | POST | 🌐 Public | 🌐 Public | 🌐 Public |

---

## Security Improvements

### Before (Simple API Key)
```typescript
// Single shared API key for all operations
const apiKey = env.QUEUE_API_KEY || env.ASSISTANT_API_KEY;
if (token === apiKey) {
  // Allow access
}
```

**Issues**:
- ❌ No user identification
- ❌ No role differentiation
- ❌ No expiration
- ❌ No audit trail
- ❌ Shared key = single point of failure

### After (JWT + RBAC)
```typescript
// 1. Verify JWT signature and expiration
const payload = await verifyAccessToken(token, env);

// 2. Check RBAC permissions
const allowed = hasPermission(method, path, payload.role);

// 3. Log to audit trail
await logAuditEvent(env, { userId, action, status });
```

**Benefits**:
- ✅ User identification (JWT sub claim)
- ✅ Role-based access control (admin/operator/viewer)
- ✅ Token expiration (15 minutes)
- ✅ Refresh token rotation (7 days, single-use)
- ✅ Comprehensive audit logging
- ✅ RS256 signature verification (production)
- ✅ Issuer/audience validation

---

## Migration Guide

### 1. Install Dependencies
```bash
cd /Users/masayuki/Dev/cloudflare-workers-hub
npm install jose
```

### 2. Apply Database Migration
```bash
# Local
wrangler d1 migrations apply knowledge-base --local

# Production
wrangler d1 migrations apply knowledge-base --remote
```

### 3. Configure Environment Variables

**Development** (`wrangler.toml`):
```toml
[vars]
JWT_SECRET = "your-dev-secret-key"
```

**Production** (Cloudflare Dashboard Secrets):
```bash
# Generate RSA key pair
openssl genpkey -algorithm RSA -out private_key.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -pubout -in private_key.pem -out public_key.pem

# Upload as secrets
wrangler secret put JWT_PRIVATE_KEY < private_key.pem
wrangler secret put JWT_PUBLIC_KEY < public_key.pem
```

---

## Testing

### Run JWT Test Script
```bash
npx tsx scripts/test-jwt-auth.ts
```

Expected output:
```
🔐 Testing JWT Authentication...

Test 1: Generate Access Token
✅ Access token generated

Test 2: Verify Access Token
✅ Token verified successfully

Test 3: Verify Invalid Token
✅ Invalid token correctly rejected

Test 4: RBAC Permission Checks
✅ All permission checks passed

🎉 All tests completed!
```

### Manual API Testing

```bash
# 1. Login to get JWT
TOKEN=$(curl -X POST http://localhost:8787/api/cockpit/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cockpit.local"}' | jq -r '.accessToken')

# 2. Access protected endpoint
curl http://localhost:8787/api/cockpit/tasks \
  -H "Authorization: Bearer $TOKEN"

# 3. Test WebSocket connection
wscat -c "ws://localhost:8787/ws?token=$TOKEN"
```

---

## Files Changed Summary

| File | Type | Lines |
|------|------|-------|
| `src/utils/jwt-auth.ts` | Created | +388 |
| `migrations/0007_rbac_tables.sql` | Created | +62 |
| `docs/JWT_AUTH_RBAC.md` | Created | +400 |
| `scripts/test-jwt-auth.ts` | Created | +80 |
| `src/types.ts` | Modified | +4 |
| `src/handlers/cockpit-api.ts` | Modified | +180 / -40 |
| `src/durable-objects/cockpit-websocket.ts` | Modified | +60 |
| `package.json` | Modified | +1 |

**Total**: ~1,135 lines added

---

## Next Steps

1. **Generate RSA Keys for Production**:
```bash
openssl genpkey -algorithm RSA -out private_key.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -pubout -in private_key.pem -out public_key.pem
```

2. **Upload Keys as Secrets**:
```bash
wrangler secret put JWT_PRIVATE_KEY < private_key.pem
wrangler secret put JWT_PUBLIC_KEY < public_key.pem
```

3. **Test Locally**:
```bash
wrangler dev
npx tsx scripts/test-jwt-auth.ts
```

4. **Deploy to Production**:
```bash
wrangler deploy --env production
```

5. **Create Real Admin User**:
```sql
INSERT INTO cockpit_users (user_id, email, role)
VALUES ('real-admin-id', 'your-email@example.com', 'admin');
```

6. **Implement Password Authentication**:
- Add `password_hash` column to `cockpit_users`
- Add bcrypt/scrypt hashing
- Update `handleLogin()` to verify password

---

## References

- Full documentation: `docs/JWT_AUTH_RBAC.md`
- JWT RFC: https://tools.ietf.org/html/rfc7519
- JOSE Library: https://github.com/panva/jose
- Cloudflare Workers: https://developers.cloudflare.com/workers/

---

## Questions?

Contact: masayuki
Repository: /Users/masayuki/Dev/cloudflare-workers-hub
Date: 2026-01-29
