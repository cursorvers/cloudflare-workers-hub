# ADR-001: Server-Authoritative Risk Classification

## Status

Accepted (2026-02-12)

## Context

The FUGUE Autopilot executor receives `ToolRequest` payloads from clients that include
self-declared `riskTier` (0-4) and `effects` (e.g. WRITE, EXEC, EXFIL). These values
directly feed into the PolicyEngine to determine whether execution is allowed.

A Codex security-analyst review (2026-02-12) identified a CRITICAL vulnerability:
an authenticated caller could under-declare risk (e.g. `riskTier: 0, effects: []`)
for a dangerous tool payload and receive a permissive PolicyDecision.

The root cause is that the server trusted client-provided classification values
instead of computing them from canonical inputs.

## Decision

**Client-provided `riskTier` and `effects` are NEVER trusted for policy evaluation.**

The server always recomputes risk classification using `classifyRisk()` from
`risk/classifier.ts`, which derives `RiskTier` deterministically from:

- `category` (ToolCategory enum, validated by Zod)
- `effects` (filtered to known EFFECT_TYPES values)
- `origin` (always ORIGINS.INTERNAL for autopilot)

### Implementation

1. **Effects validation**: Zod schema rejects unknown effect values at the API boundary.
2. **Server-side re-classification**: `classifyRisk()` computes the authoritative `riskTier`.
3. **Client value ignored**: The computed `riskTier` replaces the client value in `PolicyContext`.
4. **Mismatch logging**: Discrepancies between client and computed values are logged as warnings
   for monitoring and anomaly detection.
5. **Unknown effects handling**: Controlled by `AUTOPILOT_STRICT_EFFECTS` feature flag.

### Phase Migration

| Phase | Unknown Effects | riskTier Source | Flag |
|-------|----------------|-----------------|------|
| Phase 1 (current) | Quarantine at tier 4 | Server `classifyRisk()` | `AUTOPILOT_STRICT_EFFECTS=false` |
| Phase 2 (future)  | Reject with 400      | Server `classifyRisk()` | `AUTOPILOT_STRICT_EFFECTS=true`  |

**Phase 2 activation criteria** (all must be met):
- Mismatch rate < 1% over 7-day observation window
- Unknown effect rate < 0.1% over 7-day observation window
- All known clients updated to send correct effect values

## Consequences

### Positive

- Eliminates risk under-declaration attacks (CRITICAL vulnerability closed)
- Single source of truth for risk classification (`classifyRisk()`)
- Audit trail via mismatch warning logs
- Defense in depth: Zod enum + server re-classification

### Negative

- Clients sending unknown effects in Phase 1 are silently escalated to tier 4
  (may cause unexpected denials for legitimate but unlisted effects)
- Adding new effect types requires updating both `EFFECT_TYPES` enum and
  `EFFECT_TIER_MAP` in classifier (enforced by release-gate consistency tests)
- Slight latency increase from server-side classification (~0.1ms, negligible)

## Related

- `src/fugue/autopilot/risk/classifier.ts` - classifyRisk(), EFFECT_TIER_MAP, CATEGORY_ESCALATION
- `src/fugue/autopilot/durable-objects/autopilot-coordinator.ts` - handleExecute()
- `src/fugue/autopilot/executor/validation.ts` - Zod effects enum validation
- `src/fugue/autopilot/risk/__tests__/classifier.test.ts` - Release-gate consistency tests
