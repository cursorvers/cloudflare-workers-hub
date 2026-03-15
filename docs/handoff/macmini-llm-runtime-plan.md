# Mac mini LLM Runtime Plan

Updated: 2026-03-09

## Decision

- Do not force `copilot-cli` into the current Cloudflare Worker runtime.
- Keep production orchestration on API-capable providers for now, with `Workers AI` as the primary no-Anthropic path.
- Revisit `copilot-cli` and local `Claude Max20` integration only after the Mac mini is running 24/7 as a stable execution node.

## Why

- The current goal is to avoid unnecessary API fees when a subscription-backed local execution path exists.
- `copilot-cli` is not a direct Worker runtime provider.
- Cloudflare Workers cannot spawn local CLI processes, so `copilot-cli` must be wrapped by a separate always-on service if it is used in production flows.

## Agreed Direction

- Cloud side:
  - Keep `cloudflare-workers-hub` responsible for orchestration, auth, queueing, state, and safety controls.
  - Prefer `Workers AI` as the default production execution path when API keys are not configured.
- Mac mini side:
  - Run a 24/7 bridge/daemon that can execute subscription-backed local tools such as `copilot-cli` and local `Claude Max20`.
  - Expose a stable machine-facing API to the hub instead of exposing the CLI directly.

## Target Architecture After Mac mini Is Always On

1. `cloudflare-workers-hub` enqueues or dispatches execution jobs.
2. Mac mini bridge polls or receives jobs.
3. The bridge runs `copilot-cli` or local `Claude Max20`.
4. The bridge returns structured results, status, logs, and usage metadata.
5. The hub records state and only falls back to metered API providers when the Mac mini path is unavailable or policy requires it.

## Constraints To Respect

- Do not treat `copilot-cli` as a drop-in server provider.
- Do not assume `Claude Max20` is directly callable from Worker runtime.
- Add auth, timeout, retry, concurrency control, and audit logs to any Mac mini bridge before routing production jobs through it.
- Confirm product and subscription terms before using local subscription-backed tools for unattended automation.

## Deferred Until Mac mini 24/7

- Build `copilot-cli` bridge service.
- Build local `Claude Max20` bridge path.
- Decide whether the Mac mini acts as:
  - a self-hosted GitHub Actions runner,
  - a pull-based job worker,
  - or both.
- Add fallback policy:
  - primary: Mac mini bridge
  - secondary: `Workers AI`
  - tertiary: metered API only when explicitly allowed

## Trigger To Resume

Resume this track only when the Mac mini is confirmed stable for 24/7 operation and can host a supervised always-on daemon.
