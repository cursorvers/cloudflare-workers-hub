# Monitoring Authentication Flow

## Request Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Incoming Request                        │
│              GET /health or /metrics                        │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
            ┌─────────────────────────┐
            │  verifyMonitoringKey()  │
            └─────────────┬───────────┘
                          │
                          ▼
         ┌────────────────────────────────┐
         │  Check MONITORING_API_KEY      │
         │  or ADMIN_API_KEY              │
         └────────┬───────────────────────┘
                  │
        ┌─────────┴──────────┐
        │                    │
        ▼                    ▼
   ┌─────────┐          ┌─────────┐
   │ No Key  │          │ Key Set │
   │ Set     │          │         │
   └────┬────┘          └────┬────┘
        │                    │
        │                    ▼
        │         ┌─────────────────────┐
        │         │ X-API-Key header?   │
        │         └────┬────────────────┘
        │              │
        │    ┌─────────┴─────────┐
        │    │                   │
        │    ▼                   ▼
        │ ┌──────┐          ┌────────┐
        │ │ Yes  │          │   No   │
        │ └──┬───┘          └───┬────┘
        │    │                  │
        │    │                  ▼
        │    │           ┌──────────────┐
        │    │           │ Return 401   │
        │    │           │ Unauthorized │
        │    │           └──────────────┘
        │    │
        │    ▼
        │ ┌──────────────────────┐
        │ │ Constant-time        │
        │ │ Comparison           │
        │ └────┬─────────────────┘
        │      │
        │  ┌───┴────┐
        │  │        │
        │  ▼        ▼
        │ Match   Mismatch
        │  │        │
        │  │        ▼
        │  │   ┌──────────────┐
        │  │   │ Return 401   │
        │  │   │ Unauthorized │
        │  │   └──────────────┘
        │  │
        ▼  ▼
   ┌───────────────┐
   │   Allow       │
   │   Access      │
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ Return 200    │
   │ with data     │
   └───────────────┘
```

## Priority Logic

```
┌─────────────────────────────────────┐
│      Environment Variables          │
├─────────────────────────────────────┤
│                                     │
│  1. MONITORING_API_KEY = "key1"    │ ← Highest Priority
│     ↓                               │
│     Used if set                     │
│                                     │
│  2. ADMIN_API_KEY = "key2"         │ ← Fallback
│     ↓                               │
│     Used if MONITORING_API_KEY      │
│     not set                         │
│                                     │
│  3. Neither set                    │ ← Public Access
│     ↓                               │
│     Allow public access             │
│     (backward compatibility)        │
│                                     │
└─────────────────────────────────────┘
```

## Constant-Time Comparison

Prevents timing attacks by ensuring comparison time is independent of where mismatch occurs:

```
┌─────────────────────────────────────┐
│   Constant-Time Comparison          │
├─────────────────────────────────────┤
│                                     │
│  Input: receivedKey, expectedKey    │
│                                     │
│  1. Check length                    │
│     if (len(received) != len(exp))  │
│        return false  ← Fast reject  │
│                                     │
│  2. Bitwise comparison              │
│     result = 0                      │
│     for i in 0..length:             │
│       result |= received[i] ^       │
│                 expected[i]         │
│                                     │
│  3. Final check                     │
│     return result == 0              │
│                                     │
│  ⏱️ Time: O(n) for all inputs      │
│     (same time for all positions)   │
│                                     │
└─────────────────────────────────────┘
```

## Example Scenarios

### Scenario 1: New Deployment (No Keys)

```
Request: GET /health
Header: (none)
         ↓
MONITORING_API_KEY: (not set)
ADMIN_API_KEY: (not set)
         ↓
Result: 200 OK ✅
Log: "[Monitoring] No MONITORING_API_KEY or ADMIN_API_KEY configured - allowing public access"
```

### Scenario 2: Using MONITORING_API_KEY

```
Request: GET /health
Header: X-API-Key: correct-monitoring-key
         ↓
MONITORING_API_KEY: correct-monitoring-key ✅
ADMIN_API_KEY: some-admin-key (ignored)
         ↓
Constant-time comparison: Match ✅
         ↓
Result: 200 OK ✅
```

### Scenario 3: Using ADMIN_API_KEY (Fallback)

```
Request: GET /health
Header: X-API-Key: correct-admin-key
         ↓
MONITORING_API_KEY: (not set)
ADMIN_API_KEY: correct-admin-key ✅
         ↓
Constant-time comparison: Match ✅
         ↓
Result: 200 OK ✅
```

### Scenario 4: Wrong Key

```
Request: GET /health
Header: X-API-Key: wrong-key
         ↓
MONITORING_API_KEY: correct-key
         ↓
Constant-time comparison: Mismatch ❌
         ↓
Result: 401 Unauthorized ❌
Log: "[Monitoring] Invalid API key"
```

### Scenario 5: Missing Key (When Required)

```
Request: GET /health
Header: (none)
         ↓
MONITORING_API_KEY: some-key (set)
         ↓
No X-API-Key header ❌
         ↓
Result: 401 Unauthorized ❌
Log: "[Monitoring] Missing API key"
```

### Scenario 6: Priority Test

```
Request: GET /health
Header: X-API-Key: admin-key
         ↓
MONITORING_API_KEY: monitoring-key (set)
ADMIN_API_KEY: admin-key (set)
         ↓
Check against MONITORING_API_KEY first:
  admin-key != monitoring-key ❌
         ↓
Result: 401 Unauthorized ❌
Log: "[Monitoring] Invalid API key"

Note: ADMIN_API_KEY is not checked because
      MONITORING_API_KEY takes priority!
```

## Security Features Highlighted

```
┌────────────────────────────────────────────┐
│         Security Features                  │
├────────────────────────────────────────────┤
│                                            │
│  ✅ Constant-Time Comparison               │
│     Prevents timing attacks                │
│                                            │
│  ✅ Scoped API Keys                        │
│     Separate monitoring from admin         │
│                                            │
│  ✅ Safe Logging                           │
│     No sensitive data in logs              │
│                                            │
│  ✅ Length Check First                     │
│     Fast rejection of wrong-length keys    │
│                                            │
│  ✅ Backward Compatible                    │
│     Existing deployments continue working  │
│                                            │
│  ✅ Generic Error Messages                 │
│     Prevents enumeration attacks           │
│                                            │
└────────────────────────────────────────────┘
```

## Integration Points

```
┌──────────────────────────────────────────┐
│         External Systems                 │
└────────────────┬─────────────────────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
    ▼            ▼            ▼
┌─────────┐  ┌─────────┐  ┌──────────┐
│Datadog  │  │Prometheus│ │GitHub    │
│         │  │          │ │Actions   │
└────┬────┘  └────┬─────┘ └────┬─────┘
     │            │            │
     │            │            │
     └────────────┼────────────┘
                  │
         All send X-API-Key header
                  │
                  ▼
         ┌─────────────────┐
         │  /health        │
         │  /metrics       │
         └─────────────────┘
```

## Response Codes Reference

```
┌──────┬──────────────┬───────────────────────────┐
│ Code │ Status       │ When                      │
├──────┼──────────────┼───────────────────────────┤
│ 200  │ OK           │ Valid key or public       │
│ 401  │ Unauthorized │ Invalid/missing key       │
└──────┴──────────────┴───────────────────────────┘
```
