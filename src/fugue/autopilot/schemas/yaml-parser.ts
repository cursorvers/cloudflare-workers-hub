import { isAlias, parseDocument, visit } from 'yaml';

import type { ParseResult } from './autopilot-yml';

const CORE_TAG_PREFIX = 'tag:yaml.org,2002:';

function detectForbiddenYamlFeatures(input: string): string | null {
  const doc = parseDocument(input, {
    strict: true,
    prettyErrors: true,
    uniqueKeys: true,
    schema: 'core',
    customTags: [],
    merge: false,
  });

  let violation: string | null = null;
  visit(doc, {
    Node: (_key, node) => {
      if (isAlias(node)) {
        violation = 'YAML aliases are not allowed';
        return visit.BREAK;
      }
      if ('anchor' in node && typeof node.anchor === 'string' && node.anchor) {
        violation = 'YAML anchors are not allowed';
        return visit.BREAK;
      }
      if (typeof node.tag === 'string' && !node.tag.startsWith(CORE_TAG_PREFIX)) {
        violation = 'Custom YAML tags are not allowed';
        return visit.BREAK;
      }
      return undefined;
    },
  });

  return violation;
}

export function parseYamlSafe(input: string): ParseResult<unknown> {
  try {
    const doc = parseDocument(input, {
      strict: true,
      prettyErrors: true,
      uniqueKeys: true,
      schema: 'core',
      customTags: [],
      merge: false,
    });

    const issues = [...doc.errors, ...doc.warnings].map((e) => e.message);
    if (issues.length > 0) {
      return { success: false, error: issues.join('; ') };
    }

    const violation = detectForbiddenYamlFeatures(input);
    if (violation) {
      return { success: false, error: violation };
    }

    return { success: true, data: doc.toJS({ maxAliasCount: 0 }) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to parse YAML',
    };
  }
}
