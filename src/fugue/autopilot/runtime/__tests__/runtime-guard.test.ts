import { describe, expect, it } from "vitest";

import { createCircuitBreakerState } from "../circuit-breaker";
import { createHeartbeatState, recordHeartbeat } from "../heartbeat";
import { evaluateRecovery, runGuardCheck } from "../runtime-guard";

describe("runtime/runtime-guard", () => {
  it("全ガードOKでCONTINUE", () => {
    const heartbeatState = recordHeartbeat(createHeartbeatState(1000), 2000);
    const result = runGuardCheck(
      {
        budget: { spent: 50, limit: 100 },
        errorRate: { errors: 1, total: 100 },
        circuitBreaker: { state: createCircuitBreakerState() },
        heartbeat: { state: heartbeatState },
        query: { query: "SELECT * FROM users WHERE id = ?", params: [1] },
      },
      3000,
    );

    expect(result.verdict).toBe("CONTINUE");
    expect(result.shouldTransitionToStopped).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.timestamp).toBe(3000);
  });

  it("budget CRITICAL -> STOP", () => {
    const result = runGuardCheck({ budget: { spent: 99, limit: 100 } });
    expect(result.verdict).toBe("STOP");
    expect(result.shouldTransitionToStopped).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("budget"))).toBe(true);
  });

  it("errorRate CRITICAL -> STOP", () => {
    const result = runGuardCheck({ errorRate: { errors: 20, total: 100 } });
    expect(result.verdict).toBe("STOP");
    expect(result.shouldTransitionToStopped).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("error-rate"))).toBe(true);
  });

  it("circuitBreaker OPEN -> STOP", () => {
    const result = runGuardCheck({
      circuitBreaker: {
        state: Object.freeze({
          ...createCircuitBreakerState(),
          state: "OPEN" as const,
        }),
      },
    });

    expect(result.verdict).toBe("STOP");
    expect(result.shouldTransitionToStopped).toBe(true);
    expect(result.reasons).toContain("circuit-breaker: state OPEN");
  });

  it("heartbeat DEAD -> STOP", () => {
    const heartbeatState = recordHeartbeat(createHeartbeatState(1000), 2000);
    const result = runGuardCheck(
      { heartbeat: { state: heartbeatState } },
      40000,
    );

    expect(result.verdict).toBe("STOP");
    expect(result.shouldTransitionToStopped).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("heartbeat"))).toBe(true);
  });

  it("複数ガード同時CRITICAL -> STOP（全理由含む）", () => {
    const result = runGuardCheck({
      budget: { spent: 99, limit: 100 },
      errorRate: { errors: 20, total: 100 },
    });

    expect(result.verdict).toBe("STOP");
    expect(result.reasons.some((reason) => reason.includes("budget"))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes("error-rate"))).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("WARNING のみ -> CONTINUE（warnings含む）", () => {
    const heartbeatState = recordHeartbeat(createHeartbeatState(1000), 2000);
    const result = runGuardCheck(
      {
        budget: { spent: 95, limit: 100 },
        heartbeat: { state: heartbeatState },
      },
      12001,
    );

    expect(result.verdict).toBe("CONTINUE");
    expect(result.shouldTransitionToStopped).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("手動承認ありで復旧許可", () => {
    const result = evaluateRecovery({
      manualApproval: true,
      approvedBy: "ops-admin",
      reason: "incident resolved",
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("ops-admin");
  });

  it("手動承認なしで復旧拒否（fail-closed）", () => {
    const result = evaluateRecovery({
      manualApproval: false,
      approvedBy: "ops-admin",
      reason: "incident resolved",
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("fail-closed");
  });

  it("全結果がObject.freeze", () => {
    const heartbeatState = recordHeartbeat(createHeartbeatState(1000), 2000);
    const check = runGuardCheck(
      {
        budget: { spent: 50, limit: 100 },
        errorRate: { errors: 1, total: 100 },
        circuitBreaker: { state: createCircuitBreakerState() },
        heartbeat: { state: heartbeatState },
        query: { query: "SELECT * FROM users WHERE id = ?", params: [1] },
      },
      3000,
    );
    const recovery = evaluateRecovery({
      manualApproval: true,
      approvedBy: "ops-admin",
      reason: "incident resolved",
    });

    expect(Object.isFrozen(check)).toBe(true);
    expect(Object.isFrozen(check.reasons)).toBe(true);
    expect(Object.isFrozen(check.warnings)).toBe(true);
    expect(Object.isFrozen(check.guardResults)).toBe(true);
    expect(Object.isFrozen(recovery)).toBe(true);
  });
});
