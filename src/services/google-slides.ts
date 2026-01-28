/**
 * Google Slides Generation Service (Route A)
 *
 * Converts Markdown to Google Slides via md2gslides CLI.
 * Also provides formatters that turn Supabase digest data and topic content
 * into slide-ready Markdown (# Title → --- separators → sections).
 *
 * No npm deps beyond child_process (Node built-in).
 */

import { z } from 'zod';
import type { WeeklyDigest, ActionItemReport } from './digest-generator';

// ============================================================================
// Schemas
// ============================================================================

const GenerateSlidesOptionsSchema = z.object({
  markdownPath: z.string().min(1),
  title: z.string().min(1),
  /** Append to existing presentation instead of creating a new one */
  appendTo: z.string().optional(),
  /** Use a specific Google account email */
  account: z.string().email().optional(),
});

export type GenerateSlidesOptions = z.infer<typeof GenerateSlidesOptionsSchema>;

const GenerateSlidesResultSchema = z.object({
  slidesUrl: z.string().url(),
  slidesId: z.string().min(1),
});

export type GenerateSlidesResult = z.infer<typeof GenerateSlidesResultSchema>;

// ============================================================================
// Constants
// ============================================================================

const MD2GSLIDES_BIN = 'md2gslides';
const SLIDES_URL_REGEX = /https:\/\/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/;

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate Google Slides from a Markdown file using md2gslides CLI.
 *
 * Prerequisite: `npm install -g md2gslides` + initial OAuth browser auth.
 *
 * @param options - Markdown path, title, optional appendTo ID
 * @returns URL and ID of the created/appended presentation
 */
export async function generateSlidesFromMarkdown(
  options: GenerateSlidesOptions
): Promise<GenerateSlidesResult> {
  const validated = GenerateSlidesOptionsSchema.parse(options);

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const args: string[] = [validated.markdownPath, '--title', validated.title];

  if (validated.appendTo) {
    args.push('--append', validated.appendTo);
  }
  if (validated.account) {
    args.push('--account', validated.account);
  }

  try {
    const { stdout, stderr } = await execFileAsync(MD2GSLIDES_BIN, args, {
      timeout: 60_000,
    });

    const output = stdout + '\n' + stderr;
    const match = output.match(SLIDES_URL_REGEX);

    if (!match) {
      throw new Error(
        `md2gslides did not return a Slides URL.\nstdout: ${stdout.substring(0, 300)}\nstderr: ${stderr.substring(0, 300)}`
      );
    }

    const slidesUrl = match[0];
    const slidesId = match[1];

    return GenerateSlidesResultSchema.parse({ slidesUrl, slidesId });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `md2gslides not found. Install with: npm install -g md2gslides`
      );
    }
    throw new Error(`md2gslides failed: ${String(error)}`);
  }
}

// ============================================================================
// Markdown Formatters (Digest → Slide Markdown)
// ============================================================================

/**
 * Format a WeeklyDigest into slide-ready Markdown.
 *
 * md2gslides format:
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
 * Format a raw Markdown file's content into md2gslides-compatible format.
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
