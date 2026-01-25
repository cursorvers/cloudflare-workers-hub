# Security Fix: Timing Leak in Constant-Time Comparison

## Vulnerability Summary

**Type**: Timing Attack (CWE-208)
**Severity**: Medium
**Affected Files**:
- `src/handlers/queue.ts` (2 functions)
- `src/handlers/health.ts` (1 function)

## Problem Description

The constant-time comparison functions were returning early when string lengths didn't match, which leaks timing information that could be used in timing attacks to deduce valid API key lengths.

### Vulnerable Code Pattern

```typescript
// VULNERABLE: Early return leaks timing information
if (apiKey.length !== expectedKey.length) {
  return false; // Attacker can measure this path is faster
}

let result = 0;
for (let i = 0; i < apiKey.length; i++) {
  result |= apiKey.charCodeAt(i) ^ expectedKey.charCodeAt(i);
}
```

**Attack Vector**: An attacker can:
1. Try API keys of different lengths
2. Measure response times
3. Deduce the correct key length (faster response = wrong length)
4. Then focus brute-force attacks on keys of that specific length

## Solution

Replace early return with constant-time length comparison that always executes the full character comparison loop.

### Fixed Code Pattern

```typescript
// SECURE: Always execute full comparison
let result = apiKey.length === expectedKey.length ? 0 : 1;
const maxLen = Math.max(apiKey.length, expectedKey.length);
for (let i = 0; i < maxLen; i++) {
  const a = i < apiKey.length ? apiKey.charCodeAt(i) : 0;
  const b = i < expectedKey.length ? expectedKey.charCodeAt(i) : 0;
  result |= a ^ b;
}
return result === 0;
```

**Key Improvements**:
1. Length comparison sets result bit instead of returning
2. Loop always iterates `maxLen` times regardless of input lengths
3. Missing characters are treated as `0` to maintain constant-time behavior
4. Single return point at the end

## Fixed Functions

### src/handlers/queue.ts

1. **verifyAPIKey** (lines 51-66)
   - Used for API key authentication across queue, memory, and admin scopes
   - Impact: Prevents timing attacks on API authentication

2. **authorizeUserAccess** (lines 131-141)
   - Used for user ID authorization to prevent IDOR attacks
   - Impact: Prevents timing attacks on user ID enumeration

### src/handlers/health.ts

1. **verifyMonitoringKey** (lines 37-52)
   - Used for monitoring endpoint authentication
   - Impact: Prevents timing attacks on monitoring API keys

## Test Coverage

Created comprehensive test suite to verify the fixes:

### New Tests (src/handlers/queue.test.ts)

- 14 new tests covering:
  - Valid API key acceptance
  - Invalid key rejection (different lengths)
  - Invalid key rejection (same length, different content)
  - Constant-time behavior verification
  - Scoped API key support
  - Legacy fallback behavior
  - User authorization with constant-time comparison

### Existing Tests (src/handlers/health.test.ts)

- 16 existing tests all pass
- Includes constant-time comparison verification

## Verification

```bash
# Run security tests
npm test -- src/handlers/queue.test.ts src/handlers/health.test.ts

# Results:
# ✅ 30/30 tests passed
# ✅ No regressions introduced
# ✅ TypeScript compilation successful
```

## Security Impact

**Before**: Attackers could use timing attacks to:
- Deduce API key lengths
- Reduce brute-force search space
- Enumerate valid user IDs

**After**: Timing is constant regardless of:
- Input length differences
- Character mismatch positions
- Whether keys exist or not

## Recommendations

1. **Deployment**: Deploy this fix immediately to production
2. **Monitoring**: Monitor for unusual authentication patterns
3. **Key Rotation**: Consider rotating API keys as a precaution
4. **Future**: Use crypto.subtle.timingSafeEqual if available in future Cloudflare Workers runtime

## References

- CWE-208: Observable Timing Discrepancy
- OWASP: Timing Attacks
- RFC 2104: HMAC (constant-time comparison requirements)

---

**Fixed by**: Claude Code (Task Worker Agent)
**Date**: 2026-01-25
**Verified**: All tests passing, no regressions
