import type { AutopilotYml } from './autopilot-yml';
import { parseAutopilotYml } from './autopilot-yml';
import { parseYamlSafe } from './yaml-parser';

export type NormalizationResult =
  | { success: true; data: AutopilotYml; traceId: string }
  | { success: false; error: string; traceId: string };

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }

  return Object.freeze(value);
}

export function normalizeAutopilotInput(
  yamlString: string,
  traceId: string,
): NormalizationResult {
  const yamlParsed = parseYamlSafe(yamlString);
  if (!yamlParsed.success) {
    return Object.freeze({
      success: false,
      error: yamlParsed.error,
      traceId,
    });
  }

  const ymlParsed = parseAutopilotYml(yamlParsed.data);
  if (!ymlParsed.success) {
    return Object.freeze({
      success: false,
      error: ymlParsed.error,
      traceId,
    });
  }

  return Object.freeze({
    success: true,
    data: deepFreeze(ymlParsed.data),
    traceId,
  });
}
