import type { Analysis, Finding, PageMeasurement } from '../types.ts';
import { findingKindOrder } from '../findings/findings.ts';
import { getNameClassNames } from '../findings/layout.ts';

const maximumListedNameCount = 3;
const utilityClassMinimumCount = 10;

/** The amount as printed in `text`. It is found by matching the text around `{n}` in `summaryText`. */
function getAmountText(finding: Finding): string | null {
  const placeholderPosition = finding.summaryText.indexOf('{n}');
  if (placeholderPosition === -1) {
    return null;
  }

  const prefix = finding.summaryText.slice(0, placeholderPosition);
  const suffix = finding.summaryText.slice(placeholderPosition + 3);
  const hasMatchingFrame = finding.text.startsWith(prefix) && finding.text.endsWith(suffix);

  return hasMatchingFrame ? finding.text.slice(prefix.length, finding.text.length - suffix.length) : null;
}

function getAmountRangeText(groupFindings: Finding[]): string {
  const findingsByAmount = groupFindings
    .filter((finding) => finding.amount !== null)
    .sort((first, second) => first.amount! - second.amount!);

  if (findingsByAmount.length === 0) {
    return getAmountText(groupFindings[0]) ?? '';
  }

  const smallestText = getAmountText(findingsByAmount[0]) ?? '';
  const largestText = getAmountText(findingsByAmount[findingsByAmount.length - 1]) ?? '';

  return smallestText === largestText ? smallestText : `${smallestText}..${largestText}`;
}

export interface NameCounts {
  countByName: Map<string, number>;
  countByClassName: Map<string, number>;
}

export function createNameCounts(page: PageMeasurement): NameCounts {
  const countByName = new Map<string, number>();
  const countByClassName = new Map<string, number>();

  for (const node of page.nodes) {
    countByName.set(node.name, (countByName.get(node.name) ?? 0) + 1);

    for (const className of getNameClassNames(node.name)) {
      countByClassName.set(className, (countByClassName.get(className) ?? 0) + 1);
    }
  }

  return { countByName, countByClassName };
}

function hasId(name: string): boolean {
  return name.split('.')[0].includes('#');
}

/** A bare tag, or a tag whose every class is a utility class. A utility class is one that 10 or more names on the page carry. */
function isContextFreeName(name: string, nameCounts: NameCounts): boolean {
  const classNames = getNameClassNames(name);
  const isUtilityClass = (className: string) => (nameCounts.countByClassName.get(className) ?? 0) >= utilityClassMinimumCount;

  return !hasId(name) && classNames.every(isUtilityClass);
}

/** The node's name. When the name alone says little, the nearest ancestor with an id or class and a unique name goes in front. */
export function getShortName(page: PageMeasurement, nodeIndex: number, nameCounts: NameCounts): string {
  const name = page.nodes[nodeIndex].name;
  if (!isContextFreeName(name, nameCounts)) {
    return name;
  }

  for (let ancestorIndex = page.nodes[nodeIndex].parentIndex; ancestorIndex !== -1; ancestorIndex = page.nodes[ancestorIndex].parentIndex) {
    const ancestorName = page.nodes[ancestorIndex].name;
    const hasIdOrClass = hasId(ancestorName) || getNameClassNames(ancestorName).length > 0;
    if (hasIdOrClass && nameCounts.countByName.get(ancestorName) === 1) {
      return `${ancestorName} ${name}`;
    }
  }

  return name;
}

function createSummaryLine(page: PageMeasurement, groupFindings: Finding[], nameCounts: NameCounts): string {
  const firstFinding = groupFindings[0];
  const findingText = firstFinding.summaryText.replace('{n}', getAmountRangeText(groupFindings));
  const colorText = firstFinding.textColor === null ? '' : `, text ${firstFinding.textColor}`;
  const nodeNames = [...new Set(groupFindings.map((finding) => getShortName(page, finding.nodeIndex, nameCounts)))];
  const listedNames = nodeNames.slice(0, maximumListedNameCount).join(', ');
  const moreText = nodeNames.length > maximumListedNameCount ? ` +${nodeNames.length - maximumListedNameCount}` : '';
  const countText = groupFindings.length > 1 ? ` ×${groupFindings.length}` : '';

  return `  ${findingText}${countText}${colorText}: ${listedNames}${moreText}`;
}

export function getFindingCountText(count: number): string {
  return count === 1 ? '1 finding' : `${count} findings`;
}

/** The summary block. It has one line per finding kind and text, with the amount range, the count and up to three element names. */
export function formatSummary(page: PageMeasurement, analysis: Analysis): string[] {
  if (analysis.findings.length === 0) {
    return ['summary: no findings'];
  }

  const sortedFindings = [...analysis.findings].sort((first, second) => {
    const kindDifference = findingKindOrder.indexOf(first.kind) - findingKindOrder.indexOf(second.kind);

    return kindDifference !== 0 ? kindDifference : first.nodeIndex - second.nodeIndex;
  });
  const findingsByGroup = new Map<string, Finding[]>();

  for (const finding of sortedFindings) {
    const groupKey = `${finding.summaryText} ${finding.textColor ?? ''}`;
    const groupFindings = findingsByGroup.get(groupKey);

    if (groupFindings === undefined) {
      findingsByGroup.set(groupKey, [finding]);
    } else {
      groupFindings.push(finding);
    }
  }

  const nameCounts = createNameCounts(page);
  const summaryLines = [...findingsByGroup.values()].map((groupFindings) => createSummaryLine(page, groupFindings, nameCounts));

  return [`summary: ${getFindingCountText(analysis.findings.length)}`, ...summaryLines];
}
