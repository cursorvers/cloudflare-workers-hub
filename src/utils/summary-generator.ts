/**
 * Summary Generator for Context Optimization
 *
 * Codex/GLM/Gemini の結果を 500 tokens 以下に要約し、
 * コンテキストウィンドウの効率的な使用を実現する。
 */

export interface SummaryOptions {
  maxTokens: number;
  preserveStructure: boolean;
  includeMetadata: boolean;
}

export interface SummaryResult {
  summary: string;
  originalTokens: number;
  summaryTokens: number;
  compressionRatio: number;
  preserved: string[];
  truncated: string[];
}

const DEFAULT_OPTIONS: SummaryOptions = {
  maxTokens: 500,
  preserveStructure: true,
  includeMetadata: true,
};

// Rough token estimation (1 token ≈ 4 chars for English, ≈ 1.5 chars for Japanese)
function estimateTokens(text: string): number {
  const englishChars = text.replace(/[^\x00-\x7F]/g, '').length;
  const japaneseChars = text.length - englishChars;
  return Math.ceil(englishChars / 4 + japaneseChars / 1.5);
}

// Priority sections to preserve
const PRIORITY_SECTIONS = [
  'verdict', 'score', 'result', 'conclusion',
  'recommendation', 'action', 'critical', 'error',
  '結論', '推奨', '結果', 'スコア', '判定',
];

// Sections that can be truncated
const TRUNCATABLE_SECTIONS = [
  'details', 'explanation', 'context', 'background',
  'rationale', 'example', 'note',
  '詳細', '説明', '背景', '例',
];

export class SummaryGenerator {
  private options: SummaryOptions;

  constructor(options: Partial<SummaryOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Summarize Codex/Agent response
   */
  summarize(content: string, source: 'codex' | 'glm' | 'gemini' = 'codex'): SummaryResult {
    const originalTokens = estimateTokens(content);

    // If already within budget, return as-is
    if (originalTokens <= this.options.maxTokens) {
      return {
        summary: content,
        originalTokens,
        summaryTokens: originalTokens,
        compressionRatio: 1,
        preserved: ['all'],
        truncated: [],
      };
    }

    const lines = content.split('\n');
    const preserved: string[] = [];
    const truncated: string[] = [];
    const priorityLines: string[] = [];
    const otherLines: string[] = [];

    // Categorize lines
    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      const isPriority = PRIORITY_SECTIONS.some(s => lowerLine.includes(s));
      const isTruncatable = TRUNCATABLE_SECTIONS.some(s => lowerLine.includes(s));

      if (isPriority) {
        priorityLines.push(line);
        preserved.push(this.extractSectionName(line));
      } else if (isTruncatable) {
        truncated.push(this.extractSectionName(line));
      } else {
        otherLines.push(line);
      }
    }

    // Build summary prioritizing important content
    let summary = '';
    let currentTokens = 0;

    // Add metadata header
    if (this.options.includeMetadata) {
      const header = `[${source.toUpperCase()} Summary - ${new Date().toISOString().split('T')[0]}]\n`;
      summary += header;
      currentTokens += estimateTokens(header);
    }

    // Add priority lines first
    for (const line of priorityLines) {
      const lineTokens = estimateTokens(line);
      if (currentTokens + lineTokens <= this.options.maxTokens) {
        summary += line + '\n';
        currentTokens += lineTokens;
      }
    }

    // Add other lines if budget remains
    for (const line of otherLines) {
      const lineTokens = estimateTokens(line);
      if (currentTokens + lineTokens <= this.options.maxTokens) {
        summary += line + '\n';
        currentTokens += lineTokens;
      }
    }

    // Add truncation notice
    if (truncated.length > 0) {
      const notice = `\n[Truncated: ${truncated.join(', ')}]`;
      summary += notice;
      currentTokens += estimateTokens(notice);
    }

    return {
      summary: summary.trim(),
      originalTokens,
      summaryTokens: currentTokens,
      compressionRatio: currentTokens / originalTokens,
      preserved,
      truncated,
    };
  }

  /**
   * Extract section name from a line
   */
  private extractSectionName(line: string): string {
    const match = line.match(/^#+\s*(.+)$/) || line.match(/^\*\*(.+)\*\*/);
    return match ? match[1].trim() : line.substring(0, 20);
  }

  /**
   * Summarize multiple agent results into a unified summary
   */
  summarizeMultiple(
    results: Array<{ source: string; content: string }>
  ): SummaryResult {
    const summaries = results.map(r =>
      this.summarize(r.content, r.source as 'codex' | 'glm' | 'gemini')
    );

    const combined = summaries
      .map((s, i) => `## ${results[i].source}\n${s.summary}`)
      .join('\n\n');

    const totalOriginal = summaries.reduce((sum, s) => sum + s.originalTokens, 0);
    const totalSummary = estimateTokens(combined);

    return {
      summary: combined,
      originalTokens: totalOriginal,
      summaryTokens: totalSummary,
      compressionRatio: totalSummary / totalOriginal,
      preserved: summaries.flatMap(s => s.preserved),
      truncated: summaries.flatMap(s => s.truncated),
    };
  }
}

export default SummaryGenerator;
