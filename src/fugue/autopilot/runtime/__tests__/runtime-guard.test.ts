import { describe, expect, it } from "vitest";

import { createCircuitBreakerState } from "../circuit-breaker";
import { createHeartbeatState, recordHeartbeat } from "../heartbeat";
import { evaluateRecovery, runGuardCheck } from "../runtime-guard";
import type { BudgetSample } from "../budget-predictor";

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

  it("WARNING のみ -> DEGRADE（warnings含む）", () => {
    const heartbeatState = recordHeartbeat(createHeartbeatState(1000), 2000);
    const result = runGuardCheck(
      {
        budget: { spent: 95, limit: 100 },
        heartbeat: { state: heartbeatState },
      },
      12001,
    );

    expect(result.verdict).toBe("DEGRADE");
    expect(result.shouldTransitionToStopped).toBe(false);
    expect(result.shouldTransitionToDegraded).toBe(true);
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

  // =========================================================================
  // Budget prediction + throttle integration
  // =========================================================================

  it("prediction/throttle absent when no budgetSamples", () => {
    const result = runGuardCheck(
      { budget: { spent: 50, limit: 100 } },
      3000,
    );
    expect(result.prediction).toBeUndefined();
    expect(result.throttle).toBeUndefined();
  });

  it("prediction/throttle computed when budgetSamples provided", () => {
    const samples: BudgetSample[] = [
      { timestamp: 0, spent: 0 },
      { timestamp: 1000, spent: 10 },
      { timestamp: 2000, spent: 20 },
      { timestamp: 3000, spent: 30 },
    ];
    const result = runGuardCheck(
      {
        budget: { spent: 30, limit: 100 },
        budgetSamples: samples,
      },
      4000,
    );
    expect(result.prediction).toBeDefined();
    expect(result.prediction!.method).not.toBe('insufficient_data');
    // 4 original samples + 1 injected current budget point = 5
    expect(result.prediction!.sampleCount).toBe(5);
    expect(result.throttle).toBeDefined();
    expect(result.throttle!.level).toBeDefined();
    expect(result.throttle!.rate).toBeDefined();
  });

  it("throttle reflects high spend ratio", () => {
    const samples: BudgetSample[] = [
      { timestamp: 0, spent: 80 },
      { timestamp: 1000, spent: 90 },
      { timestamp: 2000, spent: 96 },
    ];
    const result = runGuardCheck(
      {
        budget: { spent: 96, limit: 100 },
        budgetSamples: samples,
      },
      3000,
    );
    expect(result.throttle).toBeDefined();
    // ratio 0.96 → at least HEAVY
    expect(result.throttle!.rate).toBeLessThanOrEqual(0.4);
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
