import { skillBodyText } from '../src/guide.ts';

export const skillFileUrl = new URL('../skills/pxtree/SKILL.md', import.meta.url);

const skillFrontmatterText = `---
name: pxtree
description: Measures how a webpage actually renders and prints it as compact text - pixel sizes, positions, clipping, covered text, overflow, off center boxes, truncation, contrast. Use when building, editing, styling or debugging a webpage, a layout, CSS, or a component's rendering, and whenever you would otherwise take a screenshot or a DOM or accessibility snapshot to check how something looks.
license: MIT
---

`;

export function createSkillText(): string {
  return skillFrontmatterText + skillBodyText;
}
