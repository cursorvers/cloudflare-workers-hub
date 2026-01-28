/**
 * Google Slides Markdown Formatters
 *
 * Formats various data structures (WeeklyDigest, ActionItemReport, etc.)
 * into slide-ready Markdown.
 */

import type { WeeklyDigest, ActionItemReport } from './digest-generator';

// ============================================================================
// Markdown Formatters (Digest → Slide Markdown)
// ============================================================================

/**
 * Format a WeeklyDigest into slide-ready Markdown.
 *
 * Format:
 * - `# Title` → Title slide
 * - `---` → New slide separator
 * - `## Heading` → Section header on slide
 * - Bullet lists → Slide body bullets
 */
export function formatDigestAsSlideMarkdown(
  digest: WeeklyDigest,
  title: string
): string {
  const sections: string[] = [];

  // Title slide
  sections.push(`# ${title}\n\n${digest.periodStart} ~ ${digest.periodEnd}`);

  // Overview slide
  const overviewLines: string[] = [
    '## Overview',
    '',
    `* Recordings: ${digest.totalRecordings}`,
    `* Total Duration: ${formatDurationCompact(digest.totalDurationSeconds)}`,
    `* Starred: ${digest.starredCount}`,
    `* Action Items: ${digest.allActionItems.length}`,
  ];
  const topClassifications = Object.entries(digest.classificationBreakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([cls, count]) => `${cls}: ${count}`);
  if (topClassifications.length > 0) {
    overviewLines.push(`* Types: ${topClassifications.join(', ')}`);
  }
  sections.push(overviewLines.join('\n'));

  // Top Topics slide
  if (digest.topTopics.length > 0) {
    const topicLines = ['## Top Topics', ''];
    for (const t of digest.topTopics.slice(0, 8)) {
      topicLines.push(`* **${t.topic}** (${t.count}x)`);
    }
    sections.push(topicLines.join('\n'));
  }

  // Key Insights slide
  if (digest.allInsights.length > 0) {
    const insightLines = ['## Key Insights', ''];
    for (const insight of digest.allInsights.slice(0, 6)) {
      insightLines.push(`* ${insight}`);
    }
    sections.push(insightLines.join('\n'));
  }

  // Action Items slide
  if (digest.allActionItems.length > 0) {
    const actionLines = ['## Action Items', ''];
    for (const item of digest.allActionItems.slice(0, 8)) {
      actionLines.push(`* ${item}`);
    }
    sections.push(actionLines.join('\n'));
  }

  // Highlights slide(s)
  if (digest.highlights.length > 0) {
    const highlightLines = ['## Highlights', ''];
    for (const h of digest.highlights.slice(0, 5)) {
      highlightLines.push(`* **${h.title}** (${h.classification})`);
      highlightLines.push(`  ${h.summary.substring(0, 80)}`);
    }
    sections.push(highlightLines.join('\n'));
  }

  // Sentiment slide
  const sentimentEntries = Object.entries(digest.sentimentDistribution)
    .filter(([, count]) => count > 0);
  if (sentimentEntries.length > 0) {
    const sentLines = ['## Sentiment Distribution', ''];
    for (const [sentiment, count] of sentimentEntries) {
      const pct = Math.round((count / digest.totalRecordings) * 100);
      sentLines.push(`* ${sentiment}: ${pct}% (${count})`);
    }
    sections.push(sentLines.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Format an ActionItemReport into slide-ready Markdown.
 */
export function formatActionItemsAsSlideMarkdown(
  report: ActionItemReport,
  title: string
): string {
  const sections: string[] = [];

  // Title slide
  sections.push(`# ${title}\n\n${report.periodStart} ~ ${report.periodEnd}`);

  // Summary slide
  sections.push(
    [
      '## Summary',
      '',
      `* Total Action Items: ${report.totalItems}`,
      `* Topic Categories: ${Object.keys(report.itemsByTopic).length}`,
    ].join('\n')
  );

  // Per-topic slides (max 5 topics)
  const sortedTopics = Object.entries(report.itemsByTopic)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 5);

  for (const [topic, items] of sortedTopics) {
    const topicLines = [`## ${topic}`, ''];
    for (const item of items.slice(0, 6)) {
      topicLines.push(`* ${item}`);
    }
    if (items.length > 6) {
      topicLines.push(`* ... and ${items.length - 6} more`);
    }
    sections.push(topicLines.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Format a free-form topic with content into slide-ready Markdown.
 */
export function formatTopicAsSlideMarkdown(
  topic: string,
  content: string
): string {
  const sections: string[] = [];

  // Title slide
  sections.push(`# ${topic}`);

  // Split content into sections by headings or paragraphs
  const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim().length > 0);

  // Group paragraphs into slides (max ~6 bullets per slide)
  let currentSlide: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();

    // If it looks like a heading, start a new slide
    if (trimmed.startsWith('#')) {
      if (currentSlide.length > 0) {
        sections.push(currentSlide.join('\n'));
        currentSlide = [];
      }
      currentSlide.push(trimmed.replace(/^#+\s*/, '## '));
      currentSlide.push('');
      continue;
    }

    // Convert to bullet point if not already
    const bullet = trimmed.startsWith('*') || trimmed.startsWith('-')
      ? trimmed.replace(/^-/, '*')
      : `* ${trimmed}`;

    currentSlide.push(bullet);

    // Start new slide if current one is getting long
    if (currentSlide.filter((l) => l.startsWith('*')).length >= 6) {
      sections.push(currentSlide.join('\n'));
      currentSlide = [];
    }
  }

  if (currentSlide.length > 0) {
    sections.push(currentSlide.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Format a raw Markdown file's content into slide-compatible format.
 * Ensures proper `---` slide separators between top-level headings.
 */
export function normalizeMarkdownForSlides(rawMarkdown: string): string {
  const lines = rawMarkdown.split('\n');
  const result: string[] = [];
  let lastWasHeading = false;

  for (const line of lines) {
    const isTopHeading = /^#{1,2}\s/.test(line);

    if (isTopHeading && result.length > 0 && !lastWasHeading) {
      // Insert slide separator before new heading
      result.push('');
      result.push('---');
      result.push('');
    }

    result.push(line);
    lastWasHeading = isTopHeading;
  }

  return result.join('\n');
}

// ============================================================================
// Internal Helpers
// ============================================================================

function formatDurationCompact(seconds: number): string {
  if (seconds <= 0) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}
