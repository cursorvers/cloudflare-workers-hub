/**
 * Plans.md Parser
 *
 * Plans.md から Goal[] を抽出するパーサー
 * Strategic Advisor のコンテキスト収集層の一部
 */

import type { Goal } from '../schemas/strategic-advisor';

// =============================================================================
// Types
// =============================================================================

interface ParsedSection {
  title: string;
  level: number;
  content: string;
  children: ParsedSection[];
}

interface TaskItem {
  text: string;
  completed: boolean;
  priority?: 'critical' | 'high' | 'medium' | 'low';
}

// =============================================================================
// Constants
// =============================================================================

const PRIORITY_KEYWORDS: Record<string, Goal['priority']> = {
  'critical': 'critical',
  'urgent': 'critical',
  '緊急': 'critical',
  'high': 'high',
  '高': 'high',
  'medium': 'medium',
  '中': 'medium',
  'low': 'low',
  '低': 'low',
};

const PHASE_PATTERN = /phase\s*(\d+)|フェーズ\s*(\d+)/i;
const TASK_PATTERN = /^[-*]\s*\[([ xX✓✗])\]\s*(.+)$/;
const HEADER_PATTERN = /^(#{1,6})\s+(.+)$/;

// =============================================================================
// Parser Functions
// =============================================================================

/**
 * Plans.md の内容をセクションに分割
 */
function parseSections(content: string): ParsedSection[] {
  const lines = content.split('\n');
  const sections: ParsedSection[] = [];
  const stack: ParsedSection[] = [];

  let currentContent: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(HEADER_PATTERN);

    if (headerMatch) {
      // 前のセクションのコンテンツを確定
      if (stack.length > 0) {
        stack[stack.length - 1].content = currentContent.join('\n').trim();
      }
      currentContent = [];

      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();

      const section: ParsedSection = {
        title,
        level,
        content: '',
        children: [],
      };

      // スタックから適切な親を見つける
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length > 0) {
        stack[stack.length - 1].children.push(section);
      } else {
        sections.push(section);
      }

      stack.push(section);
    } else {
      currentContent.push(line);
    }
  }

  // 最後のセクションのコンテンツを確定
  if (stack.length > 0) {
    stack[stack.length - 1].content = currentContent.join('\n').trim();
  }

  return sections;
}

/**
 * セクションからタスクを抽出
 */
function extractTasks(content: string): TaskItem[] {
  const tasks: TaskItem[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(TASK_PATTERN);
    if (match) {
      const completed = match[1].toLowerCase() === 'x' || match[1] === '✓';
      const text = match[2].trim();

      // 優先度を検出
      let priority: Goal['priority'] | undefined;
      for (const [keyword, p] of Object.entries(PRIORITY_KEYWORDS)) {
        if (text.toLowerCase().includes(keyword)) {
          priority = p;
          break;
        }
      }

      tasks.push({ text, completed, priority });
    }
  }

  return tasks;
}

/**
 * 現在のフェーズを検出
 */
function detectCurrentPhase(content: string): string {
  const lines = content.split('\n');

  for (const line of lines) {
    const match = line.match(PHASE_PATTERN);
    if (match && (line.includes('進行中') || line.includes('current') || line.includes('⏳'))) {
      return `Phase ${match[1] || match[2]}`;
    }
  }

  // フェーズテーブルから検出
  const phaseTableMatch = content.match(/\|\s*(\d+)\.\s*[^|]+\|\s*⏳[^|]*\|/);
  if (phaseTableMatch) {
    return `Phase ${phaseTableMatch[1]}`;
  }

  return 'Unknown';
}

/**
 * セクションから Goal を生成
 */
function sectionToGoal(section: ParsedSection, index: number): Goal {
  const tasks = extractTasks(section.content);
  const completedTasks = tasks.filter(t => t.completed);
  const totalTasks = tasks.length;

  // ステータス判定
  let status: Goal['status'] = 'active';
  if (totalTasks > 0 && completedTasks.length === totalTasks) {
    status = 'completed';
  } else if (section.title.includes('アーカイブ') || section.title.includes('Archive')) {
    status = 'paused';
  }

  // 優先度判定
  let priority: Goal['priority'] = 'medium';
  const titleLower = section.title.toLowerCase();
  if (titleLower.includes('critical') || titleLower.includes('緊急')) {
    priority = 'critical';
  } else if (titleLower.includes('high') || titleLower.includes('重要')) {
    priority = 'high';
  } else if (titleLower.includes('low') || titleLower.includes('オプション')) {
    priority = 'low';
  }

  // 成功基準を抽出（タスク一覧から）
  const successCriteria = tasks
    .filter(t => !t.completed)
    .slice(0, 5)
    .map(t => t.text);

  // Intent を推測（セクションの最初の段落から）
  const firstParagraph = section.content
    .split('\n\n')[0]
    ?.replace(/^[-*>\s]+/gm, '')
    .trim() || '';
  const intent = firstParagraph.length > 200
    ? firstParagraph.slice(0, 200) + '...'
    : firstParagraph || `${section.title} の実現`;

  return {
    id: `goal-${index + 1}`,
    title: section.title,
    intent,
    successCriteria,
    status,
    priority,
    linkedPlansSection: section.title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// =============================================================================
// Public API
// =============================================================================

export interface ParsePlansResult {
  goals: Goal[];
  currentPhase: string;
  rawSections: ParsedSection[];
  parseErrors: string[];
}

/**
 * Plans.md を解析して Goal[] を抽出
 */
export function parsePlans(content: string): ParsePlansResult {
  const parseErrors: string[] = [];

  try {
    const sections = parseSections(content);
    const currentPhase = detectCurrentPhase(content);

    // メインセクション（## レベル）から Goal を生成
    const mainSections = sections.flatMap(s => s.children);
    const relevantSections = mainSections.filter(s => {
      // 除外するセクション
      const excludePatterns = [
        /^概要$/,
        /^アーキテクチャ$/,
        /^デプロイ/,
        /^監視対象/,
        /^成功基準$/,
      ];
      return !excludePatterns.some(p => p.test(s.title));
    });

    const goals = relevantSections.map((section, index) => sectionToGoal(section, index));

    return {
      goals,
      currentPhase,
      rawSections: sections,
      parseErrors,
    };
  } catch (error) {
    parseErrors.push(error instanceof Error ? error.message : String(error));
    return {
      goals: [],
      currentPhase: 'Unknown',
      rawSections: [],
      parseErrors,
    };
  }
}

/**
 * Plans.md からアクティブな Goal のみを抽出
 */
export function getActiveGoals(content: string): Goal[] {
  const { goals } = parsePlans(content);
  return goals.filter(g => g.status === 'active');
}

/**
 * Plans.md から未完了タスク数を取得
 */
export function getPendingTaskCount(content: string): number {
  const tasks = extractTasks(content);
  return tasks.filter(t => !t.completed).length;
}

/**
 * Plans.md から完了率を計算
 */
export function getCompletionRate(content: string): number {
  const tasks = extractTasks(content);
  if (tasks.length === 0) return 0;
  const completed = tasks.filter(t => t.completed).length;
  return Math.round((completed / tasks.length) * 100);
}
