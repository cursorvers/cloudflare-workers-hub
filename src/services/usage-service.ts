import { Env } from '../types';

export interface ClaudeUsageSummary {
  used: number;
  limit: number;
  percentage: number;
}

export interface WeeklyCallsSummary {
  calls_this_week: number;
}

export interface UsageSummaryResponse {
  claude: ClaudeUsageSummary;
  codex: WeeklyCallsSummary;
  glm: WeeklyCallsSummary;
  gemini: WeeklyCallsSummary;
}

const DEFAULT_CLAUDE_PERCENTAGE = 89;
const DEFAULT_CLAUDE_LIMIT = 100;
const DEFAULT_WEEKLY_CALLS = 0;

function clampPercentage(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function buildClaudeUsageSummary(
  percentage = DEFAULT_CLAUDE_PERCENTAGE,
  limit = DEFAULT_CLAUDE_LIMIT
): ClaudeUsageSummary {
  const safeLimit = limit > 0 ? limit : DEFAULT_CLAUDE_LIMIT;
  const safePercentage = clampPercentage(percentage);
  const used = Math.round((safePercentage / 100) * safeLimit);
  const normalizedPercentage = safeLimit > 0 ? Math.round((used / safeLimit) * 100) : 0;

  return {
    used,
    limit: safeLimit,
    percentage: normalizedPercentage,
  };
}

export async function fetchUsageSummary(_env: Env): Promise<UsageSummaryResponse> {
  return {
    claude: buildClaudeUsageSummary(),
    codex: { calls_this_week: DEFAULT_WEEKLY_CALLS },
    glm: { calls_this_week: DEFAULT_WEEKLY_CALLS },
    gemini: { calls_this_week: DEFAULT_WEEKLY_CALLS },
  };
}
