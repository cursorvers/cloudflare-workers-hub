export {
  type HealthGateConfig,
  type HealthGateInput,
  type HealthGateCheck,
  type HealthGateResult,
  DEFAULT_HEALTH_GATE_CONFIG,
  checkCurrentMode,
  checkHeartbeatFreshness,
  checkCircuitBreaker,
  checkBudgetStatus,
  checkManualApproval,
  evaluateHealthGate,
} from './health-gate';
