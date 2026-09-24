import type {
  Analysis,
  ColorScheme,
  Finding,
  FormatOptions,
  Gaps,
  MeasureResult,
  MeasuredNode,
  PageMeasurement,
  Rect,
  ReportDetail,
  RunResult,
  ScrollInfo,
  TextInfo,
} from '../types.ts';
import { getBottom, getIntersection, getPaddingBox, getRight, getSiblingGroupNames, hasBoxInk, roundPixels } from '../findings/layout.ts';
import { createSnapshot, formatDiff, getNodePaths } from './diff.ts';
import { createNameCounts, formatSummary, getFindingCountText, getShortName } from './summary.ts';

const nodeCapCount = 20000;
const overSizeTagThresholdPx = 100000;
const maximumChainNameCount = 3;
const minimumSimilarRunLength = 3;
const maximumListedGapCount = 6;
const maximumAcrossLineCount = 20;

/** A page with the lookups that the tree, the tags and the snapshot need. */
export interface PageTree {
  page: PageMeasurement;
  analysis: Analysis;
  rootIndexes: number[];
  childIndexesByParent: number[][];
  findingsByNode: Finding[][];
  findingCountBefore: number[];
  hasShownDescendant: boolean[];
  siblingGroupNames: string[];
}

interface TreeView {
  tree: PageTree;
  shouldShowColors: boolean;
  /** Lines without findings print only their names. */
  isFindingsView: boolean;
  printedIndexes: Set<number> | null;
  matchedIndexes: Set<number>;
  collapsedBehindModalIndex: number | null;
  tagsByNode: Map<number, string[]>;
  signatureByNode: Map<number, string>;
}

/**
 * Makes text that a page controls safe to print on a report line. Control characters and line separators go away.
 * Quotes, brackets and `›` turn into look-alikes, so the text cannot forge a tag, a finding or a tree line.
 */
export function getPrintableText(pageText: string): string {
  return pageText
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '')
    .replaceAll('"', "'")
    .replaceAll('[', '(')
    .replaceAll(']', ')')
    .replaceAll('›', '>');
}

/** Formats a measure result as the text report that the CLI prints. By default it prints the full tree without colors. */
export function format(result: MeasureResult, options: FormatOptions = {}): string {
  const shouldShowColors = options.shouldShowColors ?? false;
  const reportDetail = options.report ?? 'tree';
  const pageTrees = result.runs.map((run) => (run.page === null || run.analysis === null ? null : createPageTree(run.page, run.analysis)));
  const runBlocks = result.runs.map((run, runPosition) => {
    const reportLines = formatRunReport(result.runs, pageTrees, runPosition, reportDetail, shouldShowColors);

    return [...reportLines, ...formatAriaSection(result.runs, runPosition)].join('\n');
  });
  const measuredPageTrees = pageTrees.filter((pageTree) => pageTree !== null);
  const isEveryRunMeasured = measuredPageTrees.length === pageTrees.length;
  const isAcrossReport = reportDetail === 'tree' || reportDetail === 'findings' || reportDetail === 'summary';
  const shouldPrintAcrossRuns = result.runs.length > 1 && isEveryRunMeasured && isAcrossReport;
  const acrossLines = shouldPrintAcrossRuns ? formatAcrossRuns(result.runs, measuredPageTrees) : [];
  if (acrossLines.length > 0) {
    runBlocks.push(acrossLines.join('\n'));
  }

  return runBlocks.join('\n\n');
}

function formatRunReport(
  runs: RunResult[],
  pageTrees: Array<PageTree | null>,
  runPosition: number,
  reportDetail: ReportDetail,
  shouldShowColors: boolean,
): string[] {
  const run = runs[runPosition];
  const pageTree = pageTrees[runPosition];
  const factsLine = getFactsLine(run, pageTree);

  if (pageTree === null || reportDetail === 'none') {
    return [factsLine];
  }

  const changesLines = formatDiff(run.previousSnapshot, createSnapshot(pageTree.page, pageTree.analysis), run.isCacheEnabled);

  if (reportDetail === 'changes') {
    return [factsLine, ...changesLines];
  }

  const summaryLines = formatSummary(pageTree.page, pageTree.analysis);

  if (reportDetail === 'summary') {
    return [factsLine, ...changesLines, ...summaryLines];
  }

  const sameTreeRun = getSameTreeRun(runs, pageTrees, runPosition);
  const treeLines =
    sameTreeRun === null
      ? formatTree(pageTree, run.shouldIncludeChildren, shouldShowColors, reportDetail === 'findings')
      : formatTreeDifferences(pageTree, sameTreeRun.pageTree, sameTreeRun.colorScheme, shouldShowColors);

  return [factsLine, ...changesLines, ...summaryLines, ...treeLines];
}

// ---------- runs that differ only in scheme ----------

function hasSameViewport(firstRun: RunResult, secondRun: RunResult): boolean {
  return firstRun.viewport.width === secondRun.viewport.width && firstRun.viewport.height === secondRun.viewport.height;
}

/** An earlier run at the same viewport and scroll whose tree matches this one once findings and colors are left out. */
function getSameTreeRun(
  runs: RunResult[],
  pageTrees: Array<PageTree | null>,
  runPosition: number,
): { pageTree: PageTree; colorScheme: ColorScheme } | null {
  const run = runs[runPosition];
  const pageTree = pageTrees[runPosition];
  const earlierPosition = runs.findIndex((earlierRun, earlierRunPosition) => {
    const earlierPage = pageTrees[earlierRunPosition]?.page;
    const hasSameScroll = earlierPage?.scroll.x === pageTree?.page.scroll.x && earlierPage?.scroll.y === pageTree?.page.scroll.y;

    return hasSameViewport(earlierRun, run) && hasSameScroll;
  });
  const earlierRun = runs[earlierPosition];
  const earlierTree = pageTrees[earlierPosition];

  if (earlierPosition === runPosition || earlierRun.colorScheme === run.colorScheme) {
    return null;
  }

  if (pageTree === null || earlierTree === null || !hasSameTreeWithoutFindings(earlierTree, pageTree)) {
    return null;
  }

  return { pageTree: earlierTree, colorScheme: earlierRun.colorScheme };
}

// ---------- aria ----------

/** Each snapshot under its heading. Nothing when every snapshot is empty. `aria: same as light` when an earlier scheme run had the same snapshots. */
function formatAriaSection(runs: RunResult[], runPosition: number): string[] {
  const run = runs[runPosition];
  const ariaSnapshots = run.ariaSnapshots ?? [];
  const hasAriaText = ariaSnapshots.some((ariaSnapshot) => ariaSnapshot !== '');

  if (!hasAriaText) {
    return [];
  }

  const sameAriaRun = runs
    .slice(0, runPosition)
    .find(
      (earlierRun) =>
        hasSameViewport(earlierRun, run) &&
        earlierRun.colorScheme !== run.colorScheme &&
        JSON.stringify(earlierRun.ariaSnapshots) === JSON.stringify(ariaSnapshots),
    );

  if (sameAriaRun !== undefined) {
    return [`aria: same as ${sameAriaRun.colorScheme}`];
  }

  if (ariaSnapshots.length === 1) {
    return ['aria:', ariaSnapshots[0]];
  }

  const elementSelector = run.page?.element?.selector;

  return ariaSnapshots.flatMap((ariaSnapshot, matchPosition) =>
    ariaSnapshot === '' ? [] : [`aria ${elementSelector} match ${matchPosition + 1}:`, ariaSnapshot],
  );
}

function getComparableNodeLine(tree: PageTree, index: number): string {
  const node = tree.page.nodes[index];
  const layout = tree.analysis.layouts[index];
  const tagsText = getNodeTags(tree, index, false).join('|');

  return `${node.parentIndex} ${node.name} ${node.text} ${getSizeText(node)} ${roundPixels(layout.x)},${roundPixels(layout.y)} ${tagsText}`;
}

function hasSameTreeWithoutFindings(firstTree: PageTree, secondTree: PageTree): boolean {
  const firstNodes = firstTree.page.nodes;
  if (firstNodes.length !== secondTree.page.nodes.length || firstTree.page.modalIndex !== secondTree.page.modalIndex) {
    return false;
  }

  return firstNodes.every((node) => getComparableNodeLine(firstTree, node.index) === getComparableNodeLine(secondTree, node.index));
}

function formatTreeDifferences(tree: PageTree, sameTree: PageTree, sameColorScheme: string, shouldShowColors: boolean): string[] {
  const view = createTreeView(tree, shouldShowColors);
  const differentIndexes = tree.page.nodes
    .map((node) => node.index)
    .filter((index) => {
      const findingTexts = tree.findingsByNode[index].map((finding) => finding.text).join('; ');
      const sameFindingTexts = sameTree.findingsByNode[index].map((finding) => finding.text).join('; ');

      return findingTexts !== sameFindingTexts;
    });

  if (differentIndexes.length === 0) {
    return [`tree: same as ${sameColorScheme}`];
  }

  return [`tree: same as ${sameColorScheme}, differences:`, ...differentIndexes.map((index) => createNodeLine(view, [index], 1, 1))];
}

export function createPageTree(page: PageMeasurement, analysis: Analysis): PageTree {
  const nodeCount = page.nodes.length;
  const rootIndexes: number[] = [];
  const childIndexesByParent: number[][] = page.nodes.map(() => []);
  const findingsByNode: Finding[][] = page.nodes.map(() => []);
  const hasShownDescendant: boolean[] = new Array(nodeCount).fill(false);

  for (const node of page.nodes) {
    if (node.parentIndex === -1) {
      rootIndexes.push(node.index);
    } else {
      childIndexesByParent[node.parentIndex].push(node.index);
    }
  }

  for (const finding of analysis.findings) {
    findingsByNode[finding.nodeIndex].push(finding);
  }

  const findingCountBefore: number[] = [0];

  for (let index = 0; index < nodeCount; index++) {
    findingCountBefore.push(findingCountBefore[index] + findingsByNode[index].length);
  }

  for (let index = nodeCount - 1; index >= 0; index--) {
    const node = page.nodes[index];
    const isShownOrAboveShown = node.visibility === 'shown' || hasShownDescendant[index];
    if (node.parentIndex !== -1 && isShownOrAboveShown) {
      hasShownDescendant[node.parentIndex] = true;
    }
  }

  const siblingGroupNames = getSiblingGroupNames(page, childIndexesByParent);

  return { page, analysis, rootIndexes, childIndexesByParent, findingsByNode, findingCountBefore, hasShownDescendant, siblingGroupNames };
}

function hasFindingInSubtree(tree: PageTree, index: number): boolean {
  const subtreeEnd = tree.page.nodes[index].subtreeEnd;

  return tree.findingCountBefore[subtreeEnd + 1] - tree.findingCountBefore[index] > 0;
}

function isHiddenWithoutShownDescendant(tree: PageTree, index: number): boolean {
  return tree.page.nodes[index].visibility === 'unpainted-visibility' && !tree.hasShownDescendant[index];
}

// ---------- facts ----------

function getFactsLine(run: RunResult, pageTree: PageTree | null): string {
  const runText = `${run.viewport.width}x${run.viewport.height} ${run.colorScheme} dpr ${run.devicePixelRatio}`;
  const factTexts = [pageTree === null ? `${runText} not measured` : `${runText} ${getPageShapeText(pageTree.page)}`];

  if (run.status !== null && (run.status < 200 || run.status >= 300)) {
    factTexts.push(`status ${run.status}`);
  }

  if (run.redirectedUrl !== null) {
    factTexts.push(`redirected to ${getPrintableText(run.redirectedUrl)}`);
  }

  if (pageTree !== null) {
    factTexts.push(...getLayoutFactTexts(pageTree));
  }

  if (run.settle.stillMovingName !== null) {
    factTexts.push(`still moving ${run.settle.stillMovingName}`);
  }

  factTexts.push(...getFontFactTexts(run));

  if (pageTree !== null) {
    factTexts.push(...getMeasurementLimitFactTexts(pageTree.page));
  }

  if (run.screenshotPath !== null) {
    factTexts.push(getScreenshotFactText(run, run.screenshotPath, pageTree?.page ?? null));
  }

  return factTexts.join(' ');
}

function getPageShapeText(page: PageMeasurement): string {
  const direction = page.direction === 'rtl' ? 'rtl (start is right)' : 'ltr';
  const scrollText = `scroll ${roundPixels(page.scroll.y)}/${roundPixels(page.scroll.maxY)}`;
  const sizeText = `page ${roundPixels(page.page.width)}x${roundPixels(page.page.height)} painted to ${roundPixels(page.page.paintedTo)}`;

  return `${direction} ${scrollText} ${sizeText}`;
}

function getLayoutFactTexts(pageTree: PageTree): string[] {
  const page = pageTree.page;
  const sidewaysPx = roundPixels(page.scroll.maxX);
  const factTexts: string[] = [];

  if (sidewaysPx >= 1) {
    const widestPastViewportIndex = getWidestPastViewportIndex(pageTree.analysis);
    const culpritText = widestPastViewportIndex === null ? '' : ` by ${getShortName(page, widestPastViewportIndex, createNameCounts(page))}`;

    factTexts.push(`sideways ${sidewaysPx}${culpritText}`);
  }

  if (page.isScrollLocked) {
    factTexts.push('scroll locked');
  }

  const innerScrollFactText = getInnerScrollFactText(pageTree);
  if (innerScrollFactText !== null) {
    factTexts.push(innerScrollFactText);
  }

  if (page.modalIndex !== null) {
    factTexts.push(`modal ${page.nodes[page.modalIndex].name}`);
  }

  return factTexts;
}

/** `window does not scroll, main scrolls y 2400 in 800`, for the biggest box that scrolls vertically when the window cannot. */
function getInnerScrollFactText(pageTree: PageTree): string | null {
  const page = pageTree.page;
  if (roundPixels(page.scroll.maxY) >= 1) {
    return null;
  }

  let biggestScrollerIndex: number | null = null;
  let biggestScrollerArea = 0;

  for (const node of page.nodes) {
    const isScrollingY = node.visibility === 'shown' && node.scroll?.axes.some((scrollAxis) => scrollAxis.axis === 'y') === true;
    const area = node.rect.width * node.rect.height;

    if (isScrollingY && area > biggestScrollerArea) {
      biggestScrollerIndex = node.index;
      biggestScrollerArea = area;
    }
  }

  if (biggestScrollerIndex === null) {
    return null;
  }

  const scrollAxis = page.nodes[biggestScrollerIndex].scroll!.axes.find((axis) => axis.axis === 'y')!;
  const scrollerName = getShortName(page, biggestScrollerIndex, createNameCounts(page));

  return `window does not scroll, ${scrollerName} scrolls y ${roundPixels(scrollAxis.contentSize)} in ${roundPixels(scrollAxis.visibleSize)}`;
}

/** `font "Inter" not used, drew Arial` per font stack, then the failed web fonts that no such item names. */
function getFontFactTexts(run: RunResult): string[] {
  const factTexts = run.fontFallbacks.map((fontFallback) => `font "${fontFallback.requestedFamily}" not used, drew ${fontFallback.drawnFamily}`);
  const reportedFamilies = new Set(run.fontFallbacks.map((fontFallback) => fontFallback.requestedFamily.toLowerCase()));
  const failedFamilies = (run.page?.failedFontFamilies ?? []).filter((family) => !reportedFamilies.has(family.toLowerCase()));

  if (failedFamilies.length > 0) {
    factTexts.push(`font failed ${failedFamilies.join(', ')}`);
  }

  return factTexts;
}

function getMeasurementLimitFactTexts(page: PageMeasurement): string[] {
  const factTexts: string[] = [];

  if (page.sampling.isCapped) {
    factTexts.push('coverage sampled partly');
  }

  if (page.isNodeCapReached) {
    factTexts.push(`stopped at ${nodeCapCount} elements`);
  }

  return factTexts;
}

/** Without a measurement the screenshot is the whole viewport. */
function getScreenshotFactText(run: RunResult, screenshotPath: string, page: PageMeasurement | null): string {
  const clip = (page === null ? null : getScreenshotClip(page)) ?? { x: 0, y: 0, ...(page?.viewport ?? run.viewport) };
  const pngWidth = Math.round(clip.width * run.devicePixelRatio);
  const pngHeight = Math.round(clip.height * run.devicePixelRatio);
  const renderedMatchCount = page?.element?.matchedIndexes.length ?? 1;
  const unclippedText = renderedMatchCount === 1 ? '' : ` (viewport, selector matched ${renderedMatchCount})`;

  return `screenshot ${screenshotPath} ${pngWidth}x${pngHeight}${unclippedText}`;
}

function getWidestPastViewportIndex(analysis: Analysis): number | null {
  let widestFinding: Finding | null = null;

  for (const finding of analysis.findings) {
    const isWider = widestFinding === null || (finding.amount ?? 0) > (widestFinding.amount ?? 0);
    if (finding.kind === 'past-viewport' && isWider) {
      widestFinding = finding;
    }
  }

  return widestFinding?.nodeIndex ?? null;
}

/** The part of the viewport that a screenshot captures, in viewport coordinates. null for the whole viewport. */
export function getScreenshotClip(page: PageMeasurement): Rect | null {
  const matchedIndexes = page.element?.matchedIndexes ?? [];
  if (matchedIndexes.length !== 1) {
    return null;
  }

  const elementRect = page.nodes[matchedIndexes[0]].rect;
  const elementViewportRect = { ...elementRect, x: elementRect.x - page.scroll.x, y: elementRect.y - page.scroll.y };

  return getIntersection(elementViewportRect, { x: 0, y: 0, ...page.viewport });
}

// ---------- tags ----------

/** The bracket contents of a node line, in section 5.1 tag order, without findings. */
export function getNodeTags(tree: PageTree, index: number, shouldShowColors: boolean): string[] {
  const page = tree.page;
  const node = page.nodes[index];
  const layout = tree.analysis.layouts[index];
  const parentDirection = node.parentIndex === -1 ? page.direction : page.nodes[node.parentIndex].direction;
  const nodeTags: string[] = [];

  if (node.isViewportFrame && node.position === 'fixed' && node.topLayer === null) {
    nodeTags.push('fixed');
  }

  if (node.isStuck) {
    nodeTags.push('stuck');
  }

  if (node.topLayer !== null) {
    nodeTags.push(`top layer ${node.topLayer}`);
  }

  if (node.direction !== parentDirection) {
    nodeTags.push(node.direction);
  }

  const transformTag = getTransformTag(node);
  if (transformTag !== null) {
    nodeTags.push(transformTag);
  }

  if (node.translate !== null) {
    nodeTags.push(getTranslateTag(node.translate));
  }

  if (node.isAnimating) {
    nodeTags.push('animating');
  }

  if (node.motionRole !== null) {
    nodeTags.push(`role ${node.motionRole}`);
  }

  const visibilityTag = getVisibilityTag(page, node);
  const isClippedOutFinding = tree.findingsByNode[index].some((finding) => finding.kind === 'clipped' && node.visibility === 'clipped-out');
  if (visibilityTag !== null && !isClippedOutFinding) {
    nodeTags.push(visibilityTag);
  }

  if (node.scroll !== null) {
    nodeTags.push(getScrollTag(node.scroll));
  }

  const clipsTag = getClipsTag(tree, node);
  if (clipsTag !== null) {
    nodeTags.push(clipsTag);
  }

  const paddingTag = getPaddingTag(node);
  if (paddingTag !== null) {
    nodeTags.push(paddingTag);
  }

  const gapsTag = layout.gaps === null ? null : getGapsTag(layout.gaps);
  if (gapsTag !== null) {
    nodeTags.push(gapsTag);
  }

  if (node.textInfo !== null) {
    nodeTags.push(getTextTag(node.textInfo, shouldShowColors));
  }

  const rendersTag = getRendersTag(node, shouldShowColors);
  if (rendersTag !== null) {
    nodeTags.push(rendersTag);
  }

  if (node.shadow === 'open') {
    nodeTags.push('shadow root');
  }

  if (node.shadow === 'closed') {
    nodeTags.push('shadow root closed');
  }

  if (node.isSlotted) {
    nodeTags.push('slotted');
  }

  if (node.rect.width > overSizeTagThresholdPx || node.rect.height > overSizeTagThresholdPx) {
    nodeTags.push(`over ${overSizeTagThresholdPx} px`);
  }

  if (node.isFrame) {
    nodeTags.push('frame not walked');
  }

  const skippedCount = isHiddenWithoutShownDescendant(tree, index)
    ? node.skippedChildCount + node.subtreeEnd - index
    : node.skippedChildCount;
  if (skippedCount > 0) {
    nodeTags.push(`children skipped ${skippedCount}`);
  }

  return nodeTags;
}

function getTransformTag(node: MeasuredNode): string | null {
  const transformParts: string[] = [];

  if (Math.abs(node.rotateDegrees) >= 0.5) {
    transformParts.push(`rotated ${roundPixels(node.rotateDegrees)}°`);
  }

  if (Math.abs(node.scale - 1) >= 0.01) {
    transformParts.push(`scaled ${node.scale.toFixed(2)}`);
  }

  const layoutSizeText = `${roundPixels(node.layoutWidth)}x${roundPixels(node.layoutHeight)}`;

  return transformParts.length === 0 ? null : `${transformParts.join(', ')} from ${layoutSizeText}`;
}

function getTranslateTag(translate: { x: number; y: number }): string {
  const x = roundPixels(translate.x);
  const y = roundPixels(translate.y);
  const axisTexts: string[] = [];

  if (x !== 0) {
    axisTexts.push(`x ${x}`);
  }

  if (y !== 0) {
    axisTexts.push(`y ${y}`);
  }

  return `translated ${axisTexts.join(' ')}`;
}

/** `clips 5 of 8 children`. It counts the direct children that this node's non-scrolling clip cuts fully or partly. */
function getClipsTag(tree: PageTree, node: MeasuredNode): string | null {
  const isClippingX = node.clipsChildren.x === 'clip';
  const isClippingY = node.clipsChildren.y === 'clip';
  if (!isClippingX && !isClippingY) {
    return null;
  }

  const paddingBox = getPaddingBox(node);
  const childIndexes = tree.childIndexesByParent[node.index];

  const cutChildCount = childIndexes.filter((childIndex) => {
    const child = tree.page.nodes[childIndex];
    if (child.visibility === 'clipped-out') {
      return child.clippedOutByIndex === node.index;
    }

    const childClipRect = child.clip?.rect;
    if (child.visibility !== 'shown' || childClipRect === undefined) {
      return false;
    }

    const isInsideClipX = childClipRect.x >= paddingBox.x - 0.5 && getRight(childClipRect) <= getRight(paddingBox) + 0.5;
    const isInsideClipY = childClipRect.y >= paddingBox.y - 0.5 && getBottom(childClipRect) <= getBottom(paddingBox) + 0.5;
    const isCutX = isClippingX && isInsideClipX && (paddingBox.x - child.rect.x >= 1 || getRight(child.rect) - getRight(paddingBox) >= 1);
    const isCutY = isClippingY && isInsideClipY && (paddingBox.y - child.rect.y >= 1 || getBottom(child.rect) - getBottom(paddingBox) >= 1);

    return isCutX || isCutY;
  }).length;

  return cutChildCount === 0 ? null : `clips ${cutChildCount} of ${childIndexes.length} children`;
}

function getVisibilityTag(page: PageMeasurement, node: MeasuredNode): string | null {
  switch (node.visibility) {
    case 'shown':
      return null;
    case 'unpainted-opacity':
      return 'not painted: opacity 0';
    case 'unpainted-visibility':
      return 'not painted: visibility hidden';
    case 'content-skipped':
      return 'content skipped';
    case 'sr-only':
      return 'sr-only';
    case 'offscreen':
      return 'offscreen';
    case 'clipped-out': {
      const clipperName = node.clippedOutByIndex === null ? null : page.nodes[node.clippedOutByIndex].name;

      return clipperName === null ? 'clipped out' : `clipped out by ${clipperName}`;
    }
  }
}

function getScrollTag(scroll: ScrollInfo): string {
  const axisTexts = scroll.axes.map((scrollAxis) => {
    const offset = roundPixels(scrollAxis.offset);
    const offsetText = offset > 0 ? ` at ${offset}` : '';

    return `${scrollAxis.axis} ${roundPixels(scrollAxis.contentSize)} in ${roundPixels(scrollAxis.visibleSize)}${offsetText}`;
  });

  return `scroll ${axisTexts.join(', ')}, ${scroll.childrenOutCount} of ${scroll.childCount} out`;
}

function getPaddingTag(node: MeasuredNode): string | null {
  const [top, right, bottom, left] = node.padding.map(roundPixels);
  if (top === 0 && right === 0 && bottom === 0 && left === 0) {
    return null;
  }

  if (top === bottom && right === left) {
    return top === right ? `pad ${top}` : `pad ${top} ${right}`;
  }

  if (right === left) {
    return `pad ${top} ${right} ${bottom}`;
  }

  return `pad ${top} ${right} ${bottom} ${left}`;
}

function getGapListText(gaps: number[]): string {
  const roundedGaps = gaps.map(roundPixels);
  const isEven = roundedGaps.every((gap) => gap === roundedGaps[0]);
  if (isEven) {
    return String(roundedGaps[0]);
  }

  const listedGaps = roundedGaps.slice(0, maximumListedGapCount).join(' ');

  return roundedGaps.length > maximumListedGapCount ? `${listedGaps} …` : listedGaps;
}

function getGapsTag(gaps: Gaps): string | null {
  const gapsTagWords = ['gaps'];

  if (gaps.arrangement === 'across') {
    gapsTagWords.push('across');
  }

  if (gaps.gaps.length > 0) {
    gapsTagWords.push(getGapListText(gaps.gaps));
  }

  if (gaps.arrangement === 'grid' && gaps.columnGaps.length > 0) {
    gapsTagWords.push('across', getGapListText(gaps.columnGaps));
  }

  const freeStart = roundPixels(gaps.freeStart);
  const freeEnd = roundPixels(gaps.freeEnd);
  const freeTexts: string[] = [];

  if (freeStart >= 1) {
    freeTexts.push(`${freeStart} at start`);
  }

  if (freeEnd >= 1) {
    freeTexts.push(`${freeEnd} at end`);
  }

  const hasGapValues = gaps.gaps.length > 0 || gaps.columnGaps.length > 0;
  if (!hasGapValues && freeTexts.length === 0) {
    return null;
  }

  const freeText = freeTexts.length > 0 ? `, free ${freeTexts.join(', ')}` : '';

  return gapsTagWords.join(' ') + freeText;
}

function getTextTag(textInfo: TextInfo, shouldShowColors: boolean): string {
  const textTagParts = [`text ${roundPixels(textInfo.fontSize)}/${roundPixels(textInfo.lineHeight)}`];

  if (textInfo.lineCount > 1) {
    textTagParts.push(`${textInfo.lineCount} lines`);
  }

  if (shouldShowColors) {
    textTagParts.push(`${textInfo.color ?? 'transparent'} on ${textInfo.background ?? 'image'}`);

    return textTagParts.join(', ');
  }

  if (textInfo.color === null) {
    textTagParts.push('fill transparent');
  }

  if (textInfo.background === null) {
    textTagParts.push('on image');
  }

  return textTagParts.join(', ');
}

function getRendersTag(node: MeasuredNode, shouldShowColors: boolean): string | null {
  const ink = node.ink;
  const inkNames: string[] = [];

  if (ink.background !== null) {
    inkNames.push(shouldShowColors ? `background ${ink.background}` : 'background');
  }

  if (ink.hasBackgroundImage) {
    inkNames.push('background-image');
  }

  if (ink.borderSides.length > 0) {
    const borderColorText = shouldShowColors && ink.borderColor !== null ? ` ${ink.borderColor}` : '';
    const borderNames = ink.borderSides.length === 4 ? ['border'] : ink.borderSides.map((side) => `border-${side}`);

    inkNames.push(borderNames.join(', ') + borderColorText);
  }

  if (ink.hasShadow) {
    inkNames.push('shadow');
  }

  if (ink.hasOutline) {
    inkNames.push('outline');
  }

  if (ink.replaced !== null) {
    inkNames.push('image');
  }

  // A styled control shows as its box ink. Only a control with no box ink paints its native look.
  if (node.isControl && inkNames.length === 0) {
    inkNames.push('control');
  }

  if (ink.pseudoInk === 'before' || ink.pseudoInk === 'both') {
    inkNames.push('::before');
  }

  if (ink.pseudoInk === 'after' || ink.pseudoInk === 'both') {
    inkNames.push('::after');
  }

  return inkNames.length === 0 ? null : `renders ${inkNames.join(', ')}`;
}

// ---------- node lines ----------

/** Printed size, `WxH`. */
function getSizeText(node: MeasuredNode): string {
  return `${roundPixels(node.rect.width)}x${roundPixels(node.rect.height)}`;
}

/** Printed findings, `[!! a; b]`, or '' when there are none. */
export function getFindingsText(findingTexts: string[]): string {
  return findingTexts.length === 0 ? '' : `[!! ${findingTexts.join('; ')}]`;
}

function getTags(view: TreeView, index: number): string[] {
  let nodeTags = view.tagsByNode.get(index);

  if (nodeTags === undefined) {
    nodeTags = getNodeTags(view.tree, index, view.shouldShowColors);
    view.tagsByNode.set(index, nodeTags);
  }

  return nodeTags;
}

function getChainNamesText(chainIndexes: number[], nodes: MeasuredNode[]): string {
  const chainNames = chainIndexes.map((index) => nodes[index].name);
  if (chainNames.length > maximumChainNameCount) {
    return `${chainNames[0]} › … › ${chainNames[chainNames.length - 1]}`;
  }

  return chainNames.join(' › ');
}

function createNodeLine(view: TreeView, chainIndexes: number[], depth: number, identicalCount: number): string {
  const nodes = view.tree.page.nodes;
  const outerIndex = chainIndexes[0];
  const index = chainIndexes[chainIndexes.length - 1];
  const node = nodes[index];
  const layout = view.tree.analysis.layouts[outerIndex];
  const x = roundPixels(layout.x);
  const y = roundPixels(layout.y);
  const lineParts = ['  '.repeat(depth) + getChainNamesText(chainIndexes, nodes)];
  const behindModalText = `[behind modal, ${node.subtreeEnd - index} elements not printed]`;

  if (view.isFindingsView && view.tree.findingsByNode[index].length === 0) {
    if (index === view.collapsedBehindModalIndex) {
      lineParts.push(behindModalText);
    }

    return lineParts.join(' ');
  }

  if (node.text !== '') {
    lineParts.push(JSON.stringify(node.text));
  }

  lineParts.push(getSizeText(node));

  if (x !== 0 || y !== 0) {
    lineParts.push(`@${x},${y}`);
  }

  const bracketTexts = getTags(view, index).map((tag) => `[${tag}]`);
  if (index === view.collapsedBehindModalIndex) {
    bracketTexts.push(behindModalText);
  }

  bracketTexts.push(getFindingsText(view.tree.findingsByNode[index].map((finding) => finding.text)));

  const joinedBracketText = bracketTexts.join('');
  if (joinedBracketText !== '') {
    lineParts.push(joinedBracketText);
  }

  if (identicalCount > 1) {
    lineParts.push(`×${identicalCount}`);
  }

  return lineParts.join(' ');
}

function getPrintedChildIndexes(view: TreeView, index: number): number[] {
  if (index === view.collapsedBehindModalIndex || isHiddenWithoutShownDescendant(view.tree, index)) {
    return [];
  }

  const childIndexes = view.tree.childIndexesByParent[index];
  const printedIndexes = view.printedIndexes;

  return printedIndexes === null ? childIndexes : childIndexes.filter((childIndex) => printedIndexes.has(childIndex));
}

function isWrapper(view: TreeView, index: number, childIndexes: number[]): boolean {
  if (childIndexes.length !== 1) {
    return false;
  }

  const node = view.tree.page.nodes[index];
  const childRect = view.tree.page.nodes[childIndexes[0]].rect;
  const isSameRect =
    Math.abs(node.rect.x - childRect.x) <= 0.5 &&
    Math.abs(node.rect.y - childRect.y) <= 0.5 &&
    Math.abs(node.rect.width - childRect.width) <= 0.5 &&
    Math.abs(node.rect.height - childRect.height) <= 0.5;
  const hasInk = hasBoxInk(node) || node.ink.replaced !== null || node.ink.pseudoInk !== null || node.ink.hasText;

  return (
    isSameRect &&
    !hasInk &&
    !node.isControl &&
    node.text === '' &&
    getTags(view, index).length === 0 &&
    view.tree.findingsByNode[index].length === 0
  );
}

function printNode(view: TreeView, index: number, depth: number, identicalCount: number, treeLines: string[]): void {
  const chainIndexes = [index];
  let childIndexes = getPrintedChildIndexes(view, index);

  while (isWrapper(view, chainIndexes[chainIndexes.length - 1], childIndexes)) {
    chainIndexes.push(childIndexes[0]);
    childIndexes = getPrintedChildIndexes(view, childIndexes[0]);
  }

  treeLines.push(createNodeLine(view, chainIndexes, depth, identicalCount));
  printSiblings(view, childIndexes, depth + 1, treeLines);
}

function getSignature(view: TreeView, index: number): string {
  let signature = view.signatureByNode.get(index);

  if (signature === undefined) {
    const node = view.tree.page.nodes[index];
    const childSignatures = getPrintedChildIndexes(view, index).map((childIndex) => getSignature(view, childIndex));

    signature = `${node.name} ${getSizeText(node)} ${getTags(view, index).join('|')}(${childSignatures.join(',')})`;
    view.signatureByNode.set(index, signature);
  }

  return signature;
}

function mustPrintInFull(view: TreeView, index: number): boolean {
  return hasFindingInSubtree(view.tree, index) || view.matchedIndexes.has(index);
}

function createSimilarLine(view: TreeView, foldedIndexes: number[], depth: number): string {
  const foldedNodes = foldedIndexes.map((index) => view.tree.page.nodes[index]);
  const foldedWidths = foldedNodes.map((node) => roundPixels(node.rect.width));
  const foldedHeights = foldedNodes.map((node) => roundPixels(node.rect.height));
  const smallestSize = `${Math.min(...foldedWidths)}x${Math.min(...foldedHeights)}`;
  const largestSize = `${Math.max(...foldedWidths)}x${Math.max(...foldedHeights)}`;
  const sizeRange = smallestSize === largestSize ? smallestSize : `${smallestSize}..${largestSize}`;

  return `${'  '.repeat(depth)}…×${foldedIndexes.length} similar ${foldedNodes[0].name} ${sizeRange}`;
}

/** The finding texts of a node's subtree with every number taken out. '' when the subtree has no finding. */
function getNumberlessFindingsText(tree: PageTree, index: number): string {
  const subtreeEnd = tree.page.nodes[index].subtreeEnd;
  const findingTexts: string[] = [];
  if (!hasFindingInSubtree(tree, index)) {
    return '';
  }

  for (let subtreeIndex = index; subtreeIndex <= subtreeEnd; subtreeIndex++) {
    for (const finding of tree.findingsByNode[subtreeIndex]) {
      findingTexts.push(finding.text.replace(/(?<![\w-])\d+(?:\.\d+)?(?:x\d+)?/g, ''));
    }
  }

  return findingTexts.join('; ');
}

/** How many siblings from `startPosition` on share their sibling group and their findings once numbers are taken out. */
function getSameFindingsRunLength(view: TreeView, siblingIndexes: number[], startPosition: number): number {
  const tree = view.tree;
  const firstIndex = siblingIndexes[startPosition];
  const findingsText = getNumberlessFindingsText(tree, firstIndex);
  if (findingsText === '') {
    return 0;
  }

  let runEnd = startPosition + 1;

  while (runEnd < siblingIndexes.length) {
    const index = siblingIndexes[runEnd];
    const isSameGroup = tree.siblingGroupNames[index] === tree.siblingGroupNames[firstIndex];
    if (!isSameGroup || view.matchedIndexes.has(index) || getNumberlessFindingsText(tree, index) !== findingsText) break;

    runEnd++;
  }

  return runEnd - startPosition;
}

/** A run of 3 or more siblings with the same findings prints its first sibling and one line for the rest. */
function printSiblings(view: TreeView, siblingIndexes: number[], depth: number, treeLines: string[]): void {
  let pendingIndexes: number[] = [];
  let position = 0;

  while (position < siblingIndexes.length) {
    const sameFindingsRunLength = getSameFindingsRunLength(view, siblingIndexes, position);

    if (sameFindingsRunLength < minimumSimilarRunLength) {
      pendingIndexes.push(siblingIndexes[position]);
      position++;
      continue;
    }

    printNameRuns(view, pendingIndexes, depth, treeLines);
    pendingIndexes = [];

    printNode(view, siblingIndexes[position], depth, 1, treeLines);
    treeLines.push(`${'  '.repeat(depth)}…×${sameFindingsRunLength - 1} similar with the same findings`);
    position += sameFindingsRunLength;
  }

  printNameRuns(view, pendingIndexes, depth, treeLines);
}

function printNameRuns(view: TreeView, siblingIndexes: number[], depth: number, treeLines: string[]): void {
  const nodes = view.tree.page.nodes;
  let runStart = 0;

  while (runStart < siblingIndexes.length) {
    const runName = nodes[siblingIndexes[runStart]].name;
    let runEnd = runStart + 1;

    while (runEnd < siblingIndexes.length && nodes[siblingIndexes[runEnd]].name === runName) {
      runEnd++;
    }

    printRun(view, siblingIndexes.slice(runStart, runEnd), depth, treeLines);
    runStart = runEnd;
  }
}

function printRun(view: TreeView, runIndexes: number[], depth: number, treeLines: string[]): void {
  const firstSignature = getSignature(view, runIndexes[0]);
  const isIdenticalRun =
    runIndexes.length > 1 &&
    runIndexes.every((index) => !mustPrintInFull(view, index) && getSignature(view, index) === firstSignature);

  if (isIdenticalRun) {
    printNode(view, runIndexes[0], depth, runIndexes.length, treeLines);
    return;
  }

  const foldedIndexes =
    runIndexes.length < minimumSimilarRunLength
      ? []
      : runIndexes.slice(1).filter((index) => !mustPrintInFull(view, index));

  if (foldedIndexes.length < 2) {
    for (const index of runIndexes) {
      printNode(view, index, depth, 1, treeLines);
    }

    return;
  }

  const foldedIndexSet = new Set(foldedIndexes);

  for (const index of runIndexes) {
    if (!foldedIndexSet.has(index)) {
      printNode(view, index, depth, 1, treeLines);
    }
  }

  treeLines.push(createSimilarLine(view, foldedIndexes, depth));
}

function getElementPrintedIndexes(page: PageMeasurement, matchedIndexes: number[], shouldIncludeChildren: boolean): Set<number> {
  const printedIndexes = new Set<number>();

  for (const matchedIndex of matchedIndexes) {
    let ancestorIndex = page.nodes[matchedIndex].parentIndex;

    while (ancestorIndex !== -1 && !printedIndexes.has(ancestorIndex)) {
      printedIndexes.add(ancestorIndex);
      ancestorIndex = page.nodes[ancestorIndex].parentIndex;
    }

    const lastPrintedIndex = shouldIncludeChildren ? page.nodes[matchedIndex].subtreeEnd : matchedIndex;

    for (let index = matchedIndex; index <= lastPrintedIndex; index++) {
      printedIndexes.add(index);
    }
  }

  return printedIndexes;
}

/** Nodes that carry a finding, among `candidateIndexes` when given, plus all their ancestors. */
function getFindingsPrintedIndexes(tree: PageTree, candidateIndexes: Set<number> | null): Set<number> {
  const printedIndexes = new Set<number>();

  for (const finding of tree.analysis.findings) {
    if (candidateIndexes !== null && !candidateIndexes.has(finding.nodeIndex)) continue;

    for (let index = finding.nodeIndex; index !== -1 && !printedIndexes.has(index); index = tree.page.nodes[index].parentIndex) {
      printedIndexes.add(index);
    }
  }

  return printedIndexes;
}

function createTreeView(tree: PageTree, shouldShowColors: boolean): TreeView {
  return {
    tree,
    shouldShowColors,
    isFindingsView: false,
    printedIndexes: null,
    matchedIndexes: new Set(),
    collapsedBehindModalIndex: tree.page.modalIndex === null ? null : 0,
    tagsByNode: new Map(),
    signatureByNode: new Map(),
  };
}

function formatTree(tree: PageTree, shouldIncludeChildren: boolean, shouldShowColors: boolean, isFindingsView: boolean): string[] {
  const page = tree.page;
  const element = page.element;
  const treeLines: string[] = [];
  const view = createTreeView(tree, shouldShowColors);

  if (element !== null) {
    if (element.matchedCount === 0) {
      return [`no element matches ${element.selector}`];
    }

    const unrenderedCount = element.matchedCount - element.matchedIndexes.length;
    if (unrenderedCount > 0) {
      treeLines.push(`${element.selector}: ${element.matchedCount} matched, ${unrenderedCount} not rendered`);
    }

    view.printedIndexes = getElementPrintedIndexes(page, element.matchedIndexes, shouldIncludeChildren);
    view.matchedIndexes = new Set(element.matchedIndexes);
    view.collapsedBehindModalIndex = null;
  }

  if (isFindingsView) {
    view.isFindingsView = true;
    view.printedIndexes = getFindingsPrintedIndexes(tree, view.printedIndexes);
  }

  for (const rootIndex of tree.rootIndexes) {
    if (view.printedIndexes === null || view.printedIndexes.has(rootIndex)) {
      printNode(view, rootIndex, 0, 1, treeLines);
    }
  }

  return treeLines;
}

// ---------- across runs ----------

interface AcrossFinding {
  shortName: string;
  text: string;
  runPositions: Set<number>;
}

/** Findings that only some runs have, or no lines when every run has the same findings. */
function formatAcrossRuns(runs: RunResult[], pageTrees: PageTree[]): string[] {
  const isSchemeMixed = runs.some((run) => run.colorScheme !== runs[0].colorScheme);
  const runLabels = runs.map((run) => {
    const sizeLabel = `${run.viewport.width}x${run.viewport.height}`;

    return isSchemeMixed ? `${sizeLabel} ${run.colorScheme}` : sizeLabel;
  });
  const findingsByKey = new Map<string, AcrossFinding>();

  pageTrees.forEach(({ page, analysis }, runPosition) => {
    const nodePaths = getNodePaths(page);
    const nameCounts = createNameCounts(page);
    const findingsInTreeOrder = [...analysis.findings].sort((first, second) => first.nodeIndex - second.nodeIndex);

    for (const finding of findingsInTreeOrder) {
      const key = `${nodePaths[finding.nodeIndex]} ${finding.summaryText}`;
      const acrossFinding = findingsByKey.get(key) ?? {
        shortName: getShortName(page, finding.nodeIndex, nameCounts),
        text: finding.text,
        runPositions: new Set<number>(),
      };

      acrossFinding.runPositions.add(runPosition);
      findingsByKey.set(key, acrossFinding);
    }
  });

  const acrossFindings = [...findingsByKey.values()];
  const partialFindings = acrossFindings.filter((acrossFinding) => acrossFinding.runPositions.size < runs.length);
  const sharedCount = acrossFindings.length - partialFindings.length;

  if (partialFindings.length === 0) {
    return [];
  }

  const countByPartialLine = new Map<string, number>();

  for (const partialFinding of partialFindings) {
    const findingRunLabels = [...partialFinding.runPositions].map((runPosition) => runLabels[runPosition]);
    const partialLine = `  ${findingRunLabels.join(', ')} only: ${partialFinding.shortName} ${partialFinding.text}`;

    countByPartialLine.set(partialLine, (countByPartialLine.get(partialLine) ?? 0) + 1);
  }

  const partialLines = [...countByPartialLine].map(([partialLine, count]) => (count > 1 ? `${partialLine} ×${count}` : partialLine));
  const acrossLines = ['across runs:', ...partialLines.slice(0, maximumAcrossLineCount)];

  if (partialLines.length > maximumAcrossLineCount) {
    acrossLines.push(`  … ${partialLines.length - maximumAcrossLineCount} more`);
  }

  if (sharedCount > 0) {
    acrossLines.push(`  all runs: ${getFindingCountText(sharedCount)} shared`);
  }

  return acrossLines;
}
