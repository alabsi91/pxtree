import type { Analysis, NodeIdentity, PageMeasurement, Snapshot, SnapshotNode } from '../types.ts';
import { roundPixels } from '../findings/layout.ts';
import { createPageTree, getFindingsText, getNodeTags } from './format.ts';

const maximumDiffLineCount = 20;

interface DiffEntry {
  path: string;
  marker: '~' | '+' | '-';
  description: string;
  moveKey: string | null;
}

function getPathName(identity: NodeIdentity): string {
  const idText = identity.id === null ? '' : `#${identity.id}`;
  const classText = identity.classNames
    .slice(0, 2)
    .map((className) => `.${className}`)
    .join('');

  return `${identity.tag}${idText}${classText}`;
}

/**
 * Node paths by node index. A path joins path names from the root with `>`. A path name is the tag, the id and the first two
 * classes in source order. It gets `[n]` when its parent has several children with that path name.
 */
export function getNodePaths(page: PageMeasurement): string[] {
  const pathNames = page.nodes.map((node) => getPathName(node.identity));
  const pathNameCountsByParent = new Map<number, Map<string, number>>();
  const pathNameSeenCountsByParent = new Map<number, Map<string, number>>();
  const nodePaths: string[] = [];

  for (const node of page.nodes) {
    const pathNameCounts = pathNameCountsByParent.get(node.parentIndex) ?? new Map<string, number>();
    const pathName = pathNames[node.index];

    pathNameCounts.set(pathName, (pathNameCounts.get(pathName) ?? 0) + 1);
    pathNameCountsByParent.set(node.parentIndex, pathNameCounts);
  }

  for (const node of page.nodes) {
    const pathName = pathNames[node.index];
    const pathNameCount = pathNameCountsByParent.get(node.parentIndex)!.get(pathName)!;
    const seenCounts = pathNameSeenCountsByParent.get(node.parentIndex) ?? new Map<string, number>();
    const position = seenCounts.get(pathName) ?? 0;
    const segment = pathNameCount > 1 ? `${pathName}[${position}]` : pathName;

    seenCounts.set(pathName, position + 1);
    pathNameSeenCountsByParent.set(node.parentIndex, seenCounts);
    nodePaths.push(node.parentIndex === -1 ? segment : `${nodePaths[node.parentIndex]}>${segment}`);
  }

  return nodePaths;
}

/** Printed values of every node by path, for the since-last-run diff. */
export function createSnapshot(page: PageMeasurement, analysis: Analysis): Snapshot {
  const tree = createPageTree(page, analysis);
  const nodePaths = getNodePaths(page);
  const snapshotNodes: Record<string, SnapshotNode> = {};

  for (const node of page.nodes) {
    const layout = analysis.layouts[node.index];

    snapshotNodes[nodePaths[node.index]] = {
      width: roundPixels(node.rect.width),
      height: roundPixels(node.rect.height),
      x: roundPixels(layout.x),
      y: roundPixels(layout.y),
      tags: getNodeTags(tree, node.index, false)
        .map((tag) => `[${tag}]`)
        .join(' '),
      findings: tree.findingsByNode[node.index].map((finding) => finding.text),
      text: node.text,
    };
  }

  return { version: 3, nodes: snapshotNodes };
}

function getTagList(tags: string): string[] {
  return tags === '' ? [] : tags.split(/(?<=\]) (?=\[)/);
}

function getChangeText(currentText: string, previousText: string): string {
  return `${currentText || 'none'} was ${previousText || 'none'}`;
}

function getChangeDescription(previous: SnapshotNode, current: SnapshotNode): string | null {
  const changeTexts: string[] = [];
  const isResized = previous.width !== current.width || previous.height !== current.height;
  const isMoved = previous.x !== current.x || previous.y !== current.y;

  if (isResized) {
    changeTexts.push(getChangeText(`${current.width}x${current.height}`, `${previous.width}x${previous.height}`));
  }

  if (isMoved) {
    changeTexts.push(getChangeText(`@${current.x},${current.y}`, `@${previous.x},${previous.y}`));
  }

  if (previous.tags !== current.tags) {
    const previousTags = getTagList(previous.tags);
    const currentTags = getTagList(current.tags);
    const addedTags = currentTags.filter((tag) => !previousTags.includes(tag));
    const removedTags = previousTags.filter((tag) => !currentTags.includes(tag));

    changeTexts.push(getChangeText(addedTags.join(' '), removedTags.join(' ')));
  }

  const addedFindings = current.findings.filter((finding) => !previous.findings.includes(finding));
  const removedFindings = previous.findings.filter((finding) => !current.findings.includes(finding));

  if (addedFindings.length === 0 && removedFindings.length > 0) {
    changeTexts.push(`findings gone: ${removedFindings.join('; ')}`);
  } else if (addedFindings.length > 0) {
    changeTexts.push(getChangeText(getFindingsText(addedFindings), getFindingsText(removedFindings)));
  }

  if (previous.text !== current.text) {
    changeTexts.push('text changed');
  }

  return changeTexts.length === 0 ? null : changeTexts.join(', ');
}

/** The position change of a node that changed nothing but its position, as a key like '0,44'. null for any other change. */
function getPureMoveKey(previous: SnapshotNode, current: SnapshotNode): string | null {
  const isSameSize = previous.width === current.width && previous.height === current.height;
  const isSameFindings = previous.findings.join('; ') === current.findings.join('; ');
  const isMoved = previous.x !== current.x || previous.y !== current.y;
  const isPureMove = isSameSize && previous.tags === current.tags && isSameFindings && previous.text === current.text && isMoved;

  return isPureMove ? `${current.x - previous.x},${current.y - previous.y}` : null;
}

function getMoveText(moveKey: string): string {
  const [horizontalMove, verticalMove] = moveKey.split(',').map(Number);
  const moveTexts: string[] = [];

  if (verticalMove !== 0) {
    moveTexts.push(verticalMove > 0 ? `${verticalMove} down` : `${-verticalMove} up`);
  }

  if (horizontalMove !== 0) {
    moveTexts.push(horizontalMove > 0 ? `${horizontalMove} end` : `${-horizontalMove} start`);
  }

  return moveTexts.join(' ');
}

/** Paths of both snapshots in document order. A gone path follows the path that came before it in the previous snapshot. */
function getPathsInDocumentOrder(previous: Snapshot, current: Snapshot): string[] {
  const gonePathsByAnchor = new Map<string | null, string[]>();
  let anchorPath: string | null = null;

  for (const path of Object.keys(previous.nodes)) {
    if (path in current.nodes) {
      anchorPath = path;
      continue;
    }

    const gonePaths = gonePathsByAnchor.get(anchorPath) ?? [];
    gonePaths.push(path);
    gonePathsByAnchor.set(anchorPath, gonePaths);
  }

  const orderedPaths = [...(gonePathsByAnchor.get(null) ?? [])];

  for (const path of Object.keys(current.nodes)) {
    orderedPaths.push(path, ...(gonePathsByAnchor.get(path) ?? []));
  }

  return orderedPaths;
}

function getNodeSummary(snapshotNode: SnapshotNode): string {
  const findingsText = getFindingsText(snapshotNode.findings);
  const sizeText = `${snapshotNode.width}x${snapshotNode.height}`;

  return findingsText === '' ? sizeText : `${sizeText} ${findingsText}`;
}

function hasAddedOrRemovedAncestor(path: string, addedOrRemovedPaths: Set<string>): boolean {
  for (let separatorPosition = path.indexOf('>'); separatorPosition !== -1; separatorPosition = path.indexOf('>', separatorPosition + 1)) {
    if (addedOrRemovedPaths.has(path.slice(0, separatorPosition))) {
      return true;
    }
  }

  return false;
}

function getCountsText(diffEntries: DiffEntry[]): string {
  const changedCount = diffEntries.filter((entry) => entry.marker === '~').length;
  const newCount = diffEntries.filter((entry) => entry.marker === '+').length;
  const goneCount = diffEntries.filter((entry) => entry.marker === '-').length;
  const countTexts: string[] = [];

  if (changedCount > 0) {
    countTexts.push(`${changedCount} changed`);
  }

  if (newCount > 0) {
    countTexts.push(`${newCount} new`);
  }

  if (goneCount > 0) {
    countTexts.push(`${goneCount} gone`);
  }

  return countTexts.join(', ');
}

/** The since-last-run lines. Empty when the cache is off. */
export function formatDiff(previous: Snapshot | null, current: Snapshot, isCacheEnabled: boolean): string[] {
  if (!isCacheEnabled) {
    return [];
  }

  if (previous === null) {
    return ['since last run: first run'];
  }

  const allPaths = getPathsInDocumentOrder(previous, current);
  const addedOrRemovedPaths = new Set(allPaths.filter((path) => !(path in previous.nodes) || !(path in current.nodes)));
  const diffEntries: DiffEntry[] = [];
  const pathsByMoveKey = new Map<string, string[]>();

  for (const path of allPaths) {
    if (hasAddedOrRemovedAncestor(path, addedOrRemovedPaths)) continue;

    const previousNode = previous.nodes[path];
    const currentNode = current.nodes[path];

    if (previousNode === undefined) {
      diffEntries.push({ path, marker: '+', description: getNodeSummary(currentNode), moveKey: null });
    } else if (currentNode === undefined) {
      diffEntries.push({ path, marker: '-', description: getNodeSummary(previousNode), moveKey: null });
    } else {
      const changeDescription = getChangeDescription(previousNode, currentNode);
      const moveKey = getPureMoveKey(previousNode, currentNode);
      if (moveKey !== null) {
        pathsByMoveKey.set(moveKey, [...(pathsByMoveKey.get(moveKey) ?? []), path]);
      }

      if (changeDescription !== null) {
        diffEntries.push({ path, marker: '~', description: changeDescription, moveKey });
      }
    }
  }

  if (diffEntries.length === 0) {
    return ['since last run: no changes'];
  }

  const entryLines: string[] = [];

  for (const entry of diffEntries) {
    const sameMovePaths = entry.moveKey === null ? [] : pathsByMoveKey.get(entry.moveKey)!;

    if (sameMovePaths.length < 2) {
      entryLines.push(`  ${entry.marker} ${entry.path} ${entry.description}`);
    } else if (sameMovePaths[0] === entry.path) {
      entryLines.push(`  ~ ${sameMovePaths.length} boxes from ${entry.path} down moved ${getMoveText(entry.moveKey!)}`);
    }
  }

  const printedLines = entryLines.slice(0, maximumDiffLineCount);

  if (entryLines.length > maximumDiffLineCount) {
    printedLines.push(`  … ${entryLines.length - maximumDiffLineCount} more`);
  }

  return [`since last run: ${getCountsText(diffEntries)}`, ...printedLines];
}
