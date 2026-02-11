export {
  type HealthGateConfig,
  type HealthGateInput,
  type HealthGateCheck,
  type HealthGateResult,
  DEFAULT_HEALTH_GATE_CONFIG,
  checkCurrentMode,
  checkCurrentModeExtended,
  checkHeartbeatFreshness,
  checkCircuitBreaker,
  checkBudgetStatus,
  checkManualApproval,
  evaluateHealthGate,
} from './health-gate';
