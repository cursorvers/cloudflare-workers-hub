/**
 * Google Slides Request Builders
 *
 * Converts parsed Markdown sections into Google Slides API batch requests.
 * Handles layout-specific slide creation (text, stats, icons, images).
 */

import type { AuthHeaders } from './google-slides';
import { batchUpdate, fetchWithTimeout, SLIDES_API } from './google-slides';

// ============================================================================
// Types
// ============================================================================

type SlideLayout =
  | 'title'
  | 'text'
  | 'image_only'
  | 'text_with_image'
  | 'stats'
  | 'icon_grid';

interface StatItem {
  emoji: string;
  value: string;
  label: string;
}

interface IconItem {
  emoji: string;
  label: string;
}

export interface SlideSection {
  heading: string;
  body: string[];
  isTitle: boolean;
  subtitle?: string;
  /** Public image URL to embed (from ![](url) or mermaid code block) */
  imageUrl?: string;
  /** Additional image URLs (for multi-image slides) */
  extraImages?: string[];
  layout: SlideLayout;
  stats?: StatItem[];
  icons?: IconItem[];
}

export interface PlaceholderInfo {
  objectId: string;
  type: string;
}

// ============================================================================
// Constants
// ============================================================================

// Infographic color palette (RGB 0-1)
const CARD_COLORS = [
  { red: 0.102, green: 0.451, blue: 0.910 }, // #1a73e8 Blue
  { red: 0.204, green: 0.659, blue: 0.325 }, // #34a853 Green
  { red: 0.918, green: 0.263, blue: 0.208 }, // #ea4335 Red
  { red: 0.612, green: 0.153, blue: 0.690 }, // #9c27b0 Purple
  { red: 0.000, green: 0.737, blue: 0.831 }, // #00bcd4 Cyan
  { red: 0.984, green: 0.737, blue: 0.016 }, // #fbbc04 Yellow
];

/**
 * Emoji detection regex (covers most common emoji ranges).
 */
const EMOJI_RE = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s+/u;

/**
 * Stat line: emoji + number/value + pipe + label
 * e.g. "🤖 3 | AI Agents"  or  "⚡ 24/7 | Uptime"
 */
const STAT_LINE_RE = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s+(.+?)\s*\|\s*(.+)$/u;

/**
 * Icon line: emoji + text label
 * e.g. "🔒 Security First"
 */
const ICON_LINE_RE = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s+(.+)$/u;

// ============================================================================
// Markdown Parser
// ============================================================================

/**
 * Parse slide-ready Markdown into structured sections.
 * Sections are separated by `---`.
 * First section with `# Title` becomes the title slide.
 *
 * Supports:
 * - `![alt](url)` → image embed
 * - ````mermaid ... ``` → diagram via mermaid.ink
 */
export function parseMarkdownToSections(markdown: string): SlideSection[] {
  const rawSections = markdown.split(/\n---\n/).map((s) => s.trim()).filter(Boolean);
  const sections: SlideSection[] = [];

  for (let i = 0; i < rawSections.length; i++) {
    const raw = rawSections[i];

    // Detect layout hints: <!-- stats -->, <!-- icons -->
    const hasStatsHint = /<!--\s*stats\s*-->/.test(raw);
    const hasIconsHint = /<!--\s*icons\s*-->/.test(raw);

    // Detect mermaid code block → convert to mermaid.ink image URL
    let imageUrl: string | undefined;
    const mermaidMatch = raw.match(/```mermaid\n([\s\S]*?)```/);
    if (mermaidMatch) {
      imageUrl = mermaidToImageUrl(mermaidMatch[1].trim());
    }

    // Detect all image markdowns: ![alt](url)
    const allImages: string[] = [];
    const imgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let imgMatch: RegExpExecArray | null;
    while ((imgMatch = imgRegex.exec(raw)) !== null) {
      allImages.push(imgMatch[2]);
    }
    if (!imageUrl && allImages.length > 0) {
      imageUrl = allImages[0];
    }
    const extraImages = allImages.length > 1 ? allImages.slice(1) : undefined;

    // Filter out mermaid blocks, image lines, and HTML comments for body parsing
    const cleaned = raw
      .replace(/```mermaid\n[\s\S]*?```/g, '')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/<!--.*?-->/g, '');

    const lines = cleaned.split('\n');
    const headingLine = lines.find((l) => /^#{1,2}\s/.test(l));
    const heading = headingLine?.replace(/^#{1,2}\s*/, '').trim() || '';

    const bulletLines = lines
      .filter((l) => /^\*\s/.test(l.trim()))
      .map((l) => l.trim().replace(/^\*\s*/, ''));

    const textLines = lines
      .filter((l) => !l.startsWith('#') && !l.trim().startsWith('*') && l.trim())
      .map((l) => l.trim());

    // --- Layout detection ---

    // Title slide
    if (i === 0 && headingLine?.startsWith('# ')) {
      sections.push({
        heading,
        body: [],
        isTitle: true,
        subtitle: textLines.join(' ') || undefined,
        imageUrl,
        extraImages,
        layout: 'title',
      });
      continue;
    }

    // Stats slide: detect "emoji value | label" patterns
    const contentLines = bulletLines.length > 0 ? bulletLines : textLines;
    if (hasStatsHint || contentLines.every((l) => STAT_LINE_RE.test(l)) && contentLines.length >= 2) {
      const stats: StatItem[] = contentLines
        .map((l) => {
          const m = l.match(STAT_LINE_RE);
          return m ? { emoji: m[1], value: m[2], label: m[3] } : null;
        })
        .filter((s): s is StatItem => s !== null);

      if (stats.length >= 2) {
        sections.push({
          heading,
          body: contentLines,
          isTitle: false,
          imageUrl,
          extraImages,
          layout: 'stats',
          stats,
        });
        continue;
      }
    }

    // Icon grid slide: detect lines starting with emoji
    if (hasIconsHint || (contentLines.length >= 3 && contentLines.every((l) => ICON_LINE_RE.test(l)))) {
      const icons: IconItem[] = contentLines
        .map((l) => {
          const m = l.match(ICON_LINE_RE);
          return m ? { emoji: m[1], label: m[2] } : null;
        })
        .filter((ic): ic is IconItem => ic !== null);

      if (icons.length >= 3) {
        sections.push({
          heading,
          body: contentLines,
          isTitle: false,
          imageUrl,
          extraImages,
          layout: 'icon_grid',
          icons,
        });
        continue;
      }
    }

    // Image-only or text-with-image or plain text
    const hasBody = contentLines.length > 0;
    const hasImage = !!imageUrl;
    const layout: SlideLayout = hasImage && !hasBody
      ? 'image_only'
      : hasImage
        ? 'text_with_image'
        : 'text';

    sections.push({
      heading,
      body: contentLines,
      isTitle: false,
      imageUrl,
      extraImages,
      layout,
    });
  }

  return sections;
}

/**
 * Convert Mermaid diagram code to a public image URL via mermaid.ink.
 *
 * mermaid.ink renders Mermaid diagrams as PNG images.
 * The URL is deterministic and publicly accessible — ideal for Google Slides createImage.
 */
function mermaidToImageUrl(mermaidCode: string): string {
  // Use TextEncoder for UTF-8 encoding (Cloudflare Workers compatible)
  const encoder = new TextEncoder();
  const bytes = encoder.encode(mermaidCode);
  // Convert bytes to binary string, then to base64
  const binaryString = String.fromCharCode(...bytes);
  const encoded = btoa(binaryString);
  return `https://mermaid.ink/img/${encoded}`;
}

// ============================================================================
// Batch Request Builders
// ============================================================================

export function buildBatchRequests(
  sections: SlideSection[],
  firstSlidePlaceholders: { slideObjectId: string; placeholders: PlaceholderInfo[] }
): unknown[] {
  const requests: unknown[] = [];

  // 1. Populate the auto-created title slide (section 0)
  if (sections.length > 0 && sections[0].isTitle) {
    const titleSection = sections[0];
    const titlePlaceholder = firstSlidePlaceholders.placeholders.find(
      (p) => p.type === 'CENTERED_TITLE' || p.type === 'TITLE'
    );
    const subtitlePlaceholder = firstSlidePlaceholders.placeholders.find(
      (p) => p.type === 'SUBTITLE'
    );

    if (titlePlaceholder && titleSection.heading) {
      requests.push({
        insertText: {
          objectId: titlePlaceholder.objectId,
          text: titleSection.heading,
          insertionIndex: 0,
        },
      });
    }
    if (subtitlePlaceholder && titleSection.subtitle) {
      requests.push({
        insertText: {
          objectId: subtitlePlaceholder.objectId,
          text: titleSection.subtitle,
          insertionIndex: 0,
        },
      });
    }

    // Add character image to title slide if present
    if (titleSection.imageUrl) {
      requests.push(...createImageRequest(
        firstSlidePlaceholders.slideObjectId,
        'title_img',
        titleSection.imageUrl,
        { x: 6_800_000, y: 3_200_000, width: 2_000_000, height: 2_000_000 },
      ));
    }
  }

  // 2. Create additional slides
  const startIndex = sections[0]?.isTitle ? 1 : 0;

  for (let i = startIndex; i < sections.length; i++) {
    const section = sections[i];
    const slideId = `slide_${i}`;
    const titleId = `slide_${i}_title`;
    const bodyId = `slide_${i}_body`;

    switch (section.layout) {
      case 'stats':
        requests.push(...buildStatsSlide(slideId, titleId, i, section));
        break;
      case 'icon_grid':
        requests.push(...buildIconGridSlide(slideId, titleId, i, section));
        break;
      case 'image_only':
        requests.push(...buildImageOnlySlide(slideId, titleId, i, section));
        break;
      default:
        requests.push(...buildTextSlide(slideId, titleId, bodyId, i, section));
        break;
    }
  }

  return requests;
}

// --- Layout-specific builders ---

export function buildTextSlide(
  slideId: string,
  titleId: string,
  bodyId: string,
  index: number,
  section: SlideSection,
): unknown[] {
  const reqs: unknown[] = [];
  const hasImage = !!section.imageUrl;
  const hasBody = section.body.length > 0;

  reqs.push({
    createSlide: {
      objectId: slideId,
      insertionIndex: index,
      slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
      placeholderIdMappings: [
        { layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId },
        { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId },
      ],
    },
  });

  if (section.heading) {
    reqs.push({
      insertText: { objectId: titleId, text: section.heading, insertionIndex: 0 },
    });
  }

  if (hasBody) {
    const bodyText = section.body.map((b) => b.replace(/\*\*/g, '')).join('\n');
    reqs.push({
      insertText: { objectId: bodyId, text: bodyText, insertionIndex: 0 },
    });
    reqs.push({
      createParagraphBullets: {
        objectId: bodyId,
        textRange: { type: 'ALL' },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }

  if (hasImage) {
    reqs.push(...createImageRequest(slideId, `slide_${index}_img`, section.imageUrl!, {
      x: 4_800_000, y: 1_500_000, width: 4_000_000, height: 4_000_000,
    }));
  }

  return reqs;
}

export function buildImageOnlySlide(
  slideId: string,
  titleId: string,
  index: number,
  section: SlideSection,
): unknown[] {
  const reqs: unknown[] = [];

  reqs.push({
    createSlide: {
      objectId: slideId,
      insertionIndex: index,
      slideLayoutReference: { predefinedLayout: 'BLANK' },
    },
  });

  if (section.heading) {
    reqs.push(...createTitleTextBox(slideId, titleId, section.heading));
  }

  reqs.push(...createImageRequest(slideId, `slide_${index}_img`, section.imageUrl!, {
    x: 572_000, y: 1_300_000, width: 8_000_000, height: 5_000_000,
  }));

  return reqs;
}

/**
 * Build a stats infographic slide with colored cards.
 *
 * Layout (up to 4 cards):
 * ┌───────────────────────────────────────┐
 * │  Heading                              │
 * │  ┌────────┐ ┌────────┐ ┌────────┐    │
 * │  │ 🤖     │ │ 📊     │ │ ⚡     │    │
 * │  │  3     │ │  5     │ │ 24/7   │    │
 * │  │ Agents │ │ Sources│ │ Uptime │    │
 * │  └────────┘ └────────┘ └────────┘    │
 * └───────────────────────────────────────┘
 */
export function buildStatsSlide(
  slideId: string,
  titleId: string,
  index: number,
  section: SlideSection,
): unknown[] {
  const reqs: unknown[] = [];
  const stats = section.stats || [];
  const count = Math.min(stats.length, 4);

  reqs.push({
    createSlide: {
      objectId: slideId,
      insertionIndex: index,
      slideLayoutReference: { predefinedLayout: 'BLANK' },
    },
  });

  // Title
  if (section.heading) {
    reqs.push(...createTitleTextBox(slideId, titleId, section.heading));
  }

  // Calculate card positions
  const totalWidth = 8_000_000; // available width
  const gap = 250_000;
  const cardWidth = Math.floor((totalWidth - gap * (count - 1)) / count);
  const cardHeight = 3_600_000;
  const startX = 572_000;
  const startY = 1_600_000;

  for (let c = 0; c < count; c++) {
    const stat = stats[c];
    const color = CARD_COLORS[c % CARD_COLORS.length];
    const x = startX + c * (cardWidth + gap);
    const cardId = `slide_${index}_card_${c}`;

    // Colored rounded rectangle background
    reqs.push({
      createShape: {
        objectId: cardId,
        shapeType: 'ROUND_RECTANGLE',
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: cardWidth, unit: 'EMU' },
            height: { magnitude: cardHeight, unit: 'EMU' },
          },
          transform: {
            scaleX: 1, scaleY: 1,
            translateX: x, translateY: startY,
            unit: 'EMU',
          },
        },
      },
    });
    reqs.push({
      updateShapeProperties: {
        objectId: cardId,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: { color: { rgbColor: color }, alpha: 1 },
          },
          outline: { propertyState: 'NOT_RENDERED' },
        },
        fields: 'shapeBackgroundFill,outline',
      },
    });

    // Emoji (large, centered at top of card)
    const emojiId = `slide_${index}_emoji_${c}`;
    reqs.push(...createCenteredText(slideId, emojiId, stat.emoji, {
      x, y: startY + 200_000, width: cardWidth, height: 900_000,
    }, 44, false, { red: 1, green: 1, blue: 1 }));

    // Value (large bold number)
    const valueId = `slide_${index}_value_${c}`;
    reqs.push(...createCenteredText(slideId, valueId, stat.value, {
      x, y: startY + 1_100_000, width: cardWidth, height: 1_000_000,
    }, 40, true, { red: 1, green: 1, blue: 1 }));

    // Label (smaller text at bottom)
    const labelId = `slide_${index}_label_${c}`;
    reqs.push(...createCenteredText(slideId, labelId, stat.label, {
      x, y: startY + 2_400_000, width: cardWidth, height: 800_000,
    }, 16, false, { red: 1, green: 1, blue: 0.9 }));
  }

  // Extra image (e.g. character) on the slide if present
  if (section.imageUrl) {
    reqs.push(...createImageRequest(slideId, `slide_${index}_img`, section.imageUrl, {
      x: 7_200_000, y: 5_400_000, width: 1_600_000, height: 1_200_000,
    }));
  }

  return reqs;
}

/**
 * Build an icon grid infographic slide.
 *
 * Layout (2-column grid):
 * ┌───────────────────────────────────────┐
 * │  Heading                              │
 * │                                       │
 * │  🔒 Security First   📈 Analytics    │
 * │  🌐 Edge Computing   💡 AI-Powered   │
 * │  🔄 Auto Delegation  📱 Multi-ch     │
 * └───────────────────────────────────────┘
 */
export function buildIconGridSlide(
  slideId: string,
  titleId: string,
  index: number,
  section: SlideSection,
): unknown[] {
  const reqs: unknown[] = [];
  const icons = section.icons || [];

  reqs.push({
    createSlide: {
      objectId: slideId,
      insertionIndex: index,
      slideLayoutReference: { predefinedLayout: 'BLANK' },
    },
  });

  if (section.heading) {
    reqs.push(...createTitleTextBox(slideId, titleId, section.heading));
  }

  // Grid layout: 2 columns
  const cols = 2;
  const rows = Math.ceil(icons.length / cols);
  const cellWidth = 3_800_000;
  const cellHeight = 1_200_000;
  const gridStartX = 572_000;
  const gridStartY = 1_500_000;
  const colGap = 400_000;
  const rowGap = 200_000;

  for (let idx = 0; idx < icons.length && idx < 6; idx++) {
    const icon = icons[idx];
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const color = CARD_COLORS[idx % CARD_COLORS.length];

    const x = gridStartX + col * (cellWidth + colGap);
    const y = gridStartY + row * (cellHeight + rowGap);

    // Icon circle background
    const circleId = `slide_${index}_circle_${idx}`;
    const circleSize = 700_000;
    reqs.push({
      createShape: {
        objectId: circleId,
        shapeType: 'ELLIPSE',
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: circleSize, unit: 'EMU' },
            height: { magnitude: circleSize, unit: 'EMU' },
          },
          transform: {
            scaleX: 1, scaleY: 1,
            translateX: x, translateY: y + 100_000,
            unit: 'EMU',
          },
        },
      },
    });
    reqs.push({
      updateShapeProperties: {
        objectId: circleId,
        shapeProperties: {
          shapeBackgroundFill: {
            solidFill: { color: { rgbColor: color }, alpha: 0.15 },
          },
          outline: { outlineFill: { solidFill: { color: { rgbColor: color } } }, weight: { magnitude: 2, unit: 'PT' } },
        },
        fields: 'shapeBackgroundFill,outline',
      },
    });

    // Emoji inside circle
    const emojiId = `slide_${index}_gicon_${idx}`;
    reqs.push(...createCenteredText(slideId, emojiId, icon.emoji, {
      x: x + 50_000, y: y + 150_000, width: circleSize - 100_000, height: circleSize - 100_000,
    }, 28, false));

    // Label text next to circle
    const labelId = `slide_${index}_glabel_${idx}`;
    reqs.push({
      createShape: {
        objectId: labelId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: slideId,
          size: {
            width: { magnitude: cellWidth - circleSize - 200_000, unit: 'EMU' },
            height: { magnitude: circleSize, unit: 'EMU' },
          },
          transform: {
            scaleX: 1, scaleY: 1,
            translateX: x + circleSize + 200_000,
            translateY: y + 100_000,
            unit: 'EMU',
          },
        },
      },
    });
    reqs.push({
      insertText: { objectId: labelId, text: icon.label, insertionIndex: 0 },
    });
    reqs.push({
      updateTextStyle: {
        objectId: labelId,
        style: { fontSize: { magnitude: 18, unit: 'PT' }, bold: true },
        textRange: { type: 'ALL' },
        fields: 'fontSize,bold',
      },
    });
    reqs.push({
      updateParagraphStyle: {
        objectId: labelId,
        style: { alignment: 'START', spaceAbove: { magnitude: 8, unit: 'PT' } },
        textRange: { type: 'ALL' },
        fields: 'alignment,spaceAbove',
      },
    });
  }

  // Extra image (character) if present
  if (section.imageUrl) {
    reqs.push(...createImageRequest(slideId, `slide_${index}_img`, section.imageUrl, {
      x: 7_200_000, y: 5_200_000, width: 1_600_000, height: 1_400_000,
    }));
  }

  return reqs;
}

/**
 * Create a centered text box (used for stat values, emoji, labels).
 */
export function createCenteredText(
  pageId: string,
  objectId: string,
  text: string,
  pos: { x: number; y: number; width: number; height: number },
  fontSize: number,
  bold: boolean,
  color?: { red: number; green: number; blue: number },
): unknown[] {
  const style: Record<string, unknown> = {
    fontSize: { magnitude: fontSize, unit: 'PT' },
    bold,
  };
  let fields = 'fontSize,bold';
  if (color) {
    style.foregroundColor = { opaqueColor: { rgbColor: color } };
    fields += ',foregroundColor';
  }

  return [
    {
      createShape: {
        objectId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            width: { magnitude: pos.width, unit: 'EMU' },
            height: { magnitude: pos.height, unit: 'EMU' },
          },
          transform: {
            scaleX: 1, scaleY: 1,
            translateX: pos.x, translateY: pos.y,
            unit: 'EMU',
          },
        },
      },
    },
    { insertText: { objectId, text, insertionIndex: 0 } },
    {
      updateTextStyle: {
        objectId,
        style,
        textRange: { type: 'ALL' },
        fields,
      },
    },
    {
      updateParagraphStyle: {
        objectId,
        style: { alignment: 'CENTER' },
        textRange: { type: 'ALL' },
        fields: 'alignment',
      },
    },
  ];
}

/**
 * Build createImage request for embedding an image on a slide.
 */
export function createImageRequest(
  pageId: string,
  imageId: string,
  url: string,
  pos: { x: number; y: number; width: number; height: number }
): unknown[] {
  return [{
    createImage: {
      objectId: imageId,
      url,
      elementProperties: {
        pageObjectId: pageId,
        size: {
          width: { magnitude: pos.width, unit: 'EMU' },
          height: { magnitude: pos.height, unit: 'EMU' },
        },
        transform: {
          scaleX: 1,
          scaleY: 1,
          translateX: pos.x,
          translateY: pos.y,
          unit: 'EMU',
        },
      },
    },
  }];
}

/**
 * Build requests for a title text box on a BLANK slide.
 */
export function createTitleTextBox(
  pageId: string,
  textBoxId: string,
  text: string
): unknown[] {
  return [
    {
      createShape: {
        objectId: textBoxId,
        shapeType: 'TEXT_BOX',
        elementProperties: {
          pageObjectId: pageId,
          size: {
            width: { magnitude: 8_000_000, unit: 'EMU' },
            height: { magnitude: 800_000, unit: 'EMU' },
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: 572_000,
            translateY: 200_000,
            unit: 'EMU',
          },
        },
      },
    },
    {
      insertText: { objectId: textBoxId, text, insertionIndex: 0 },
    },
    {
      updateTextStyle: {
        objectId: textBoxId,
        style: { fontSize: { magnitude: 28, unit: 'PT' }, bold: true },
        textRange: { type: 'ALL' },
        fields: 'fontSize,bold',
      },
    },
  ];
}

export async function appendSlides(
  presentationId: string,
  auth: AuthHeaders,
  sections: SlideSection[]
): Promise<void> {
  // Get current slide count for insertion index
  const response = await fetchWithTimeout(`${SLIDES_API}/${presentationId}`, {
    method: 'GET',
    headers: auth,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get presentation (${response.status}): ${errorText.substring(0, 300)}`);
  }

  const data = await response.json() as { slides: unknown[] };
  const baseIndex = data.slides.length;
  const ts = Date.now();

  const requests: unknown[] = [];

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const slideId = `append_${ts}_${i}`;
    const titleId = `append_${ts}_${i}_title`;
    const bodyId = `append_${ts}_${i}_body`;
    const insertionIndex = baseIndex + i;

    if (section.isTitle) {
      // Title slide — use predefined TITLE layout with placeholder mappings
      requests.push({
        createSlide: {
          objectId: slideId,
          insertionIndex,
          slideLayoutReference: { predefinedLayout: 'TITLE' },
          placeholderIdMappings: [
            { layoutPlaceholder: { type: 'CENTERED_TITLE', index: 0 }, objectId: titleId },
          ],
        },
      });
      if (section.heading) {
        requests.push({
          insertText: { objectId: titleId, text: section.heading, insertionIndex: 0 },
        });
      }
      if (section.imageUrl) {
        requests.push(...createImageRequest(
          slideId,
          `append_${ts}_${i}_img`,
          section.imageUrl,
          { x: 6_800_000, y: 3_200_000, width: 2_000_000, height: 2_000_000 },
        ));
      }
    } else {
      // Reuse layout-specific builders (same logic as buildBatchRequests)
      switch (section.layout) {
        case 'stats':
          requests.push(...buildStatsSlide(slideId, titleId, insertionIndex, section));
          break;
        case 'icon_grid':
          requests.push(...buildIconGridSlide(slideId, titleId, insertionIndex, section));
          break;
        case 'image_only':
          requests.push(...buildImageOnlySlide(slideId, titleId, insertionIndex, section));
          break;
        default:
          requests.push(...buildTextSlide(slideId, titleId, bodyId, insertionIndex, section));
          break;
      }
    }
  }

  if (requests.length > 0) {
    await batchUpdate(presentationId, requests, auth);
  }
}
