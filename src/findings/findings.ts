import type { Analysis, Finding, FindingKind, MeasuredNode, NodeLayout, PageMeasurement, Rect } from '../types.ts';
import {
  getBottom,
  getChildIndexesByParent,
  getContentBox,
  getFlowItemRects,
  getInlineGap,
  getIntersection,
  getNodeLayouts,
  getPaddingBox,
  getRight,
  getSiblingGroupNames,
  getUnion,
  hasBoxInk,
  roundPixels,
} from './layout.ts';

type PhysicalSide = 'top' | 'right' | 'bottom' | 'left';

type SideAmounts = Record<PhysicalSide, number>;

const physicalSides: PhysicalSide[] = ['top', 'right', 'bottom', 'left'];

export const findingKindOrder: FindingKind[] = [
  'clipped',
  'overflows',
  'text-overflows',
  'past-viewport',
  'covered',
  'overlaps',
  'off-center',
  'text-off-center',
  'tops-across-siblings',
  'starts-across-siblings',
  'wider',
  'taller',
  'shorter',
  'sibling-gaps',
  'text-truncated',
  'contrast',
  'small-target',
  'image-not-loaded',
  'image-aspect',
  'image-upscaled',
  'scroll-range',
];

const maxAlignmentGroupMembers = 50;
const maxAlignmentDescendantsPerMember = 200;
const maxActiveOverlapCandidates = 50;
const targetSpacingRadius = 12;
const targetGridCellSize = 64;

interface AnalysisContext {
  page: PageMeasurement;
  nodes: MeasuredNode[];
  layouts: NodeLayout[];
  childIndexesByParent: number[][];
  siblingGroupNames: string[];
  isInsideHorizontalScrollByIndex: boolean[];
  viewportScrollXByIndex: number[];
  coveredLinks: CoveredLink[];
}

interface CoveredLink {
  nodeIndex: number;
  covererIndex: number;
  isTranslucent: boolean;
}

interface FindingDraft {
  kind: FindingKind;
  nodeIndex: number;
  template: string;
  amount?: number;
  printedAmount?: string;
  relatedIndex?: number | null;
  textColor?: string | null;
}

function createFinding(draft: FindingDraft): Finding {
  const relatedIndex = draft.relatedIndex ?? null;
  const textColor = draft.textColor ?? null;

  if (draft.amount === undefined) {
    const { kind, nodeIndex, template } = draft;

    return { kind, nodeIndex, text: template, summaryText: template, amount: null, relatedIndex, textColor };
  }

  const printedAmount = draft.printedAmount ?? String(roundPixels(draft.amount));
  const printedNumber = Number(printedAmount);

  return {
    kind: draft.kind,
    nodeIndex: draft.nodeIndex,
    text: draft.template.replace('{n}', printedAmount),
    summaryText: draft.template,
    amount: Number.isNaN(printedNumber) ? draft.amount : printedNumber,
    relatedIndex,
    textColor,
  };
}

/** Tracks which finding keys an ancestor already reported. Nodes must be visited in preorder. */
function createBranchMemory() {
  const carrierSubtreeEndByKey = new Map<string, number>();

  return {
    isSaidAbove(key: string, node: MeasuredNode): boolean {
      return (carrierSubtreeEndByKey.get(key) ?? -1) >= node.index;
    },
    remember(key: string, node: MeasuredNode): void {
      carrierSubtreeEndByKey.set(key, node.subtreeEnd);
    },
  };
}

function isShown(node: MeasuredNode): boolean {
  return node.visibility === 'shown';
}

function isTransformed(node: MeasuredNode): boolean {
  return node.rotateDegrees !== 0 || node.scale !== 1 || node.isInsideTransform;
}

function isScrollContainer(node: MeasuredNode): boolean {
  return node.clipsChildren.x === 'scroll' || node.clipsChildren.y === 'scroll';
}

/** A `display: inline` box that is not replaced. It is as tall as its font, not its line. */
function isInlineBox(node: MeasuredNode): boolean {
  return node.display === 'inline' && node.ink.replaced === null && !node.isControl;
}

function getAxis(side: PhysicalSide): 'x' | 'y' {
  return side === 'top' || side === 'bottom' ? 'y' : 'x';
}

function getSideLabel(side: PhysicalSide, direction: 'ltr' | 'rtl'): string {
  if (side === 'left') {
    return direction === 'rtl' ? 'end' : 'start';
  }

  if (side === 'right') {
    return direction === 'rtl' ? 'start' : 'end';
  }

  return side;
}

/** How far `inner` extends past `outer` on each side. Negative when it stays inside. */
function getOverhangs(inner: Rect, outer: Rect): SideAmounts {
  return {
    top: outer.y - inner.y,
    right: getRight(inner) - getRight(outer),
    bottom: getBottom(inner) - getBottom(outer),
    left: outer.x - inner.x,
  };
}

function getVisibleRect(node: MeasuredNode): Rect | null {
  return node.clip ? getIntersection(node.rect, node.clip.rect) : node.rect;
}

function getSpread(values: number[]): { min: number; max: number } {
  return { min: Math.min(...values), max: Math.max(...values) };
}

function getMostCommonValue(values: number[]): number {
  const countByValue = new Map<number, number>();
  let mostCommonValue = values[0];

  for (const value of values) {
    const count = (countByValue.get(value) ?? 0) + 1;
    countByValue.set(value, count);

    if (count > (countByValue.get(mostCommonValue) ?? 0)) {
      mostCommonValue = value;
    }
  }

  return mostCommonValue;
}

function isDescendant(node: MeasuredNode, ancestor: MeasuredNode): boolean {
  return ancestor.index < node.index && node.index <= ancestor.subtreeEnd;
}

function getCoveredLinks(nodes: MeasuredNode[]): CoveredLink[] {
  const coveredLinks: CoveredLink[] = [];

  for (const node of nodes) {
    if (!isShown(node) || !node.coverage) continue;

    const { sampleCount } = node.coverage;
    const coverers = [...node.coverage.coverers]
      .sort((first, second) => second.sampleCount - first.sampleCount)
      .filter((coverer) => (node.isControl ? coverer.sampleCount >= 0.1 * sampleCount : coverer.sampleCount >= 1));
    const covererNodes = coverers.map((coverer) => nodes[coverer.index]).filter((covererNode) => covererNode !== undefined);

    for (const coverer of coverers) {
      const covererNode = nodes[coverer.index];
      const isInsideOtherCoverer = covererNode !== undefined && covererNodes.some((other) => isDescendant(covererNode, other));
      if (!isInsideOtherCoverer) {
        coveredLinks.push({ nodeIndex: node.index, covererIndex: coverer.index, isTranslucent: coverer.isTranslucent });
      }
    }
  }

  return coveredLinks;
}

function createAnalysisContext(page: PageMeasurement): AnalysisContext {
  const nodes = page.nodes;
  const isInsideHorizontalScrollByIndex: boolean[] = [];
  const viewportScrollXByIndex: number[] = [];

  for (const node of nodes) {
    const parent = node.parentIndex >= 0 ? nodes[node.parentIndex] : null;
    const isParentHorizontalScroll = parent !== null && parent.clipsChildren.x === 'scroll';
    isInsideHorizontalScrollByIndex.push(parent !== null && (isParentHorizontalScroll || isInsideHorizontalScrollByIndex[parent.index]));

    if (node.isViewportFrame) {
      viewportScrollXByIndex.push(page.scroll.x);
    } else {
      viewportScrollXByIndex.push(parent !== null ? viewportScrollXByIndex[parent.index] : 0);
    }
  }

  const childIndexesByParent = getChildIndexesByParent(page);

  return {
    page,
    nodes,
    layouts: getNodeLayouts(page),
    childIndexesByParent,
    siblingGroupNames: getSiblingGroupNames(page, childIndexesByParent),
    isInsideHorizontalScrollByIndex,
    viewportScrollXByIndex,
    coveredLinks: getCoveredLinks(nodes),
  };
}

function getClippedFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const branchMemory = createBranchMemory();

  for (const node of context.nodes) {
    if (!isShown(node) || !node.clip) continue;
    if (!node.textInfo && !node.isControl) continue;

    const overhangs = getOverhangs(node.rect, node.clip.rect);

    for (const side of physicalSides) {
      const axis = getAxis(side);
      const clipperIndex = axis === 'x' ? node.clip.clipperIndexX : node.clip.clipperIndexY;
      const clipper = clipperIndex === null ? null : context.nodes[clipperIndex];
      const key = `${side}|${clipperIndex ?? 'viewport'}`;
      const isScrolledOut = clipper?.clipsChildren[axis] === 'scroll';
      if (overhangs[side] < 1 || isScrolledOut || branchMemory.isSaidAbove(key, node)) continue;

      branchMemory.remember(key, node);
      findings.push(
        createFinding({
          kind: 'clipped',
          nodeIndex: node.index,
          template: `clipped ${side} {n} by ${clipper?.name ?? 'viewport'}`,
          amount: overhangs[side],
          relatedIndex: clipperIndex,
        }),
      );
    }
  }

  return findings;
}

/** Finds text, controls, and boxes whose unwalked children may hold them, that a non-scrolling clip cuts off fully. */
function getClippedOutFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const node of context.nodes) {
    if (node.visibility !== 'clipped-out' || node.clippedOutByIndex === null) continue;

    const parent = node.parentIndex >= 0 ? context.nodes[node.parentIndex] : null;
    const isParentPainted = parent === null || parent.visibility === 'shown' || parent.visibility === 'clipped-out';
    const clipper = context.nodes[node.clippedOutByIndex];
    const mayHoldContent = node.textInfo !== null || node.isControl || node.skippedChildCount > 0;
    if (!mayHoldContent || !isParentPainted) continue;

    findings.push(
      createFinding({ kind: 'clipped', nodeIndex: node.index, template: `clipped out by ${clipper.name}`, relatedIndex: clipper.index }),
    );
  }

  return findings;
}

/** The visible box, grown by the visible part of the node's own text ink. */
function getVisibleInkRect(node: MeasuredNode): Rect | null {
  const visibleRect = getVisibleRect(node);
  const inkRect = node.textInfo?.inkRect;
  const visibleInkRect = inkRect && (node.clip ? getIntersection(inkRect, node.clip.rect) : inkRect);
  if (!visibleRect || !visibleInkRect) {
    return visibleRect ?? visibleInkRect ?? null;
  }

  return getUnion([visibleRect, visibleInkRect]);
}

/** How far each node's visible rect or text ink extends past the viewport's inline end. 0 when it does not count. */
function getPastViewportOverhangs(context: AnalysisContext): number[] {
  const { page } = context;

  return context.nodes.map((node) => {
    const visibleInkRect = getVisibleInkRect(node);
    if (!isShown(node) || !visibleInkRect || context.isInsideHorizontalScrollByIndex[node.index]) {
      return 0;
    }

    const viewportLeft = context.viewportScrollXByIndex[node.index];
    const viewportRight = viewportLeft + page.viewport.width;

    return page.direction === 'rtl' ? viewportLeft - visibleInkRect.x : getRight(visibleInkRect) - viewportRight;
  });
}

/** How far the node's visible box or text ink extends past its parent's border box at the page's inline end. */
function getPastParentEndOverhang(context: AnalysisContext, node: MeasuredNode): number {
  const visibleInkRect = getVisibleInkRect(node);
  if (node.parentIndex < 0 || !visibleInkRect) {
    return 0;
  }

  const overhangs = getOverhangs(visibleInkRect, context.nodes[node.parentIndex].rect);

  return context.page.direction === 'rtl' ? overhangs.left : overhangs.right;
}

function getPastViewportFindings(context: AnalysisContext, pastViewportOverhangs: number[]): Finding[] {
  const findings: Finding[] = [];

  for (const node of context.nodes) {
    const overhang = pastViewportOverhangs[node.index];
    const hasParentCondition = node.parentIndex >= 0 && pastViewportOverhangs[node.parentIndex] >= 1;
    const isWhereItBegins = !hasParentCondition || getPastParentEndOverhang(context, node) >= 1;
    if (overhang >= 1 && isWhereItBegins) {
      findings.push(createFinding({ kind: 'past-viewport', nodeIndex: node.index, template: 'past viewport end {n}', amount: overhang }));
    }
  }

  return findings;
}

/** How far each in-flow node's visible rect extends past its parent's border box. null when the node does not count. */
function getParentOverflows(context: AnalysisContext): Array<SideAmounts | null> {
  return context.nodes.map((node) => {
    const visibleRect = getVisibleRect(node);
    if (!isShown(node) || !node.isInFlow || node.parentIndex < 0 || !visibleRect) {
      return null;
    }

    return getOverhangs(visibleRect, context.nodes[node.parentIndex].rect);
  });
}

function getOverflowsFindings(context: AnalysisContext, pastViewportOverhangs: number[]): Finding[] {
  const findings: Finding[] = [];
  const parentOverflows = getParentOverflows(context);
  const pastViewportSide: PhysicalSide = context.page.direction === 'rtl' ? 'left' : 'right';

  for (const node of context.nodes) {
    const overhangs = parentOverflows[node.index];
    if (!overhangs) continue;

    const parent = context.nodes[node.parentIndex];
    const hasInlineBox = isInlineBox(node) || isInlineBox(parent);

    const overflowingSides = physicalSides.filter((side) => {
      const axis = getAxis(side);
      const isParentScrolling = parent.clipsChildren[axis] === 'scroll';
      const isInlineBoxBlockSide = hasInlineBox && axis === 'y';
      const isPastViewportSide = side === pastViewportSide && pastViewportOverhangs[node.index] >= 1;
      const isSuppressed = isParentScrolling || isInlineBoxBlockSide || isPastViewportSide;

      return overhangs[side] >= 1 && !isSuppressed;
    });

    for (const [firstSide, secondSide] of getEqualOppositeSidePairs(overflowingSides, overhangs)) {
      const firstSideLabel = getSideLabel(firstSide, parent.direction);
      const sidesText = secondSide === null ? firstSideLabel : `${firstSideLabel} and ${getSideLabel(secondSide, parent.direction)}`;

      findings.push(
        createFinding({
          kind: 'overflows',
          nodeIndex: node.index,
          template: `overflows parent ${sidesText} {n}`,
          amount: overhangs[firstSide],
          relatedIndex: parent.index,
        }),
      );
    }
  }

  return findings;
}

/** Joins two opposite sides that overhang by the same amount within 1 px. Other sides stay alone. */
function getEqualOppositeSidePairs(sides: PhysicalSide[], overhangs: SideAmounts): Array<[PhysicalSide, PhysicalSide | null]> {
  const oppositeSidePairs: Array<[PhysicalSide, PhysicalSide]> = [
    ['top', 'bottom'],
    ['left', 'right'],
  ];
  const sidePairs: Array<[PhysicalSide, PhysicalSide | null]> = [];

  for (const [firstSide, secondSide] of oppositeSidePairs) {
    const hasFirstSide = sides.includes(firstSide);
    const hasSecondSide = sides.includes(secondSide);

    if (hasFirstSide && hasSecondSide && Math.abs(overhangs[firstSide] - overhangs[secondSide]) <= 1) {
      sidePairs.push([firstSide, secondSide]);
      continue;
    }

    if (hasFirstSide) {
      sidePairs.push([firstSide, null]);
    }

    if (hasSecondSide) {
      sidePairs.push([secondSide, null]);
    }
  }

  return sidePairs;
}

function hasReportedTruncation(node: MeasuredNode): boolean {
  const truncation = node.textInfo?.truncation;

  return !!truncation && (truncation.kind === 'clamp' || truncation.hiddenPx >= 1);
}

function getTextOverflowsFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const node of context.nodes) {
    const { textInfo } = node;
    if (!isShown(node) || !textInfo || hasReportedTruncation(node)) continue;

    const inkRect = textInfo.inkRect;
    const overhangs = getOverhangs(inkRect, node.rect);

    // Text rects are taller than the line when line-height is below the font's content height. That excess is not overflow.
    const contentAreaHeight = inkRect.height - (textInfo.lineCount - 1) * textInfo.lineHeight;
    const halfNegativeLeading = Math.max(0, (contentAreaHeight - textInfo.lineHeight) / 2);

    for (const side of physicalSides) {
      const axis = getAxis(side);
      const amount = overhangs[side] - (axis === 'y' ? halfNegativeLeading : 0);
      if (amount < 1 || node.clipsChildren[axis] !== 'none') continue;

      findings.push(
        createFinding({
          kind: 'text-overflows',
          nodeIndex: node.index,
          template: `text overflows ${getSideLabel(side, node.direction)} {n}`,
          amount,
        }),
      );
    }
  }

  return findings;
}

function getCoveredDescription(visibleRect: Rect, overlap: Rect, direction: 'ltr' | 'rtl'): { side: string | null; amount: number } {
  const overlapSides = getOverhangs(overlap, visibleRect);
  const isTouching = (side: PhysicalSide) => Math.abs(overlapSides[side]) < 0.5;
  const isFullWidth = overlap.width >= visibleRect.width - 0.5;
  const isFullHeight = overlap.height >= visibleRect.height - 0.5;

  if (isFullWidth && isTouching('top') !== isTouching('bottom')) {
    return { side: isTouching('top') ? 'top' : 'bottom', amount: overlap.height };
  }

  if (isFullHeight && isTouching('left') !== isTouching('right')) {
    return { side: getSideLabel(isTouching('left') ? 'left' : 'right', direction), amount: overlap.width };
  }

  const coveredShare = (overlap.width * overlap.height) / (visibleRect.width * visibleRect.height);

  return { side: null, amount: Math.max(1, Math.round(coveredShare * 100)) };
}

function getCoveredFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const branchMemory = createBranchMemory();
  const { viewport, scroll } = context.page;
  const viewportRect = { x: scroll.x, y: scroll.y, width: viewport.width, height: viewport.height };

  for (const link of context.coveredLinks) {
    const node = context.nodes[link.nodeIndex];
    const coverer = context.nodes[link.covererIndex];
    const key = String(link.covererIndex);

    const isAncestor = coverer !== undefined && isDescendant(node, coverer);
    const isAncestorPseudoInk = isAncestor && coverer.ink.pseudoInk !== null;
    if (!coverer || isAncestorPseudoInk || branchMemory.isSaidAbove(key, node)) continue;

    const nodeVisibleRect = getVisibleRect(node);
    const visibleRect = nodeVisibleRect && getIntersection(nodeVisibleRect, viewportRect);
    const covererVisibleRect = getVisibleRect(coverer);
    const overlap = visibleRect && covererVisibleRect && getIntersection(visibleRect, covererVisibleRect);
    if (!visibleRect || !overlap || overlap.width < 1 || overlap.height < 1) continue;

    const description = getCoveredDescription(visibleRect, overlap, node.direction);
    const amountText = description.side ? `${description.side} {n}` : '{n}%';
    const translucentText = link.isTranslucent ? ' (translucent)' : '';

    branchMemory.remember(key, node);
    findings.push(
      createFinding({
        kind: 'covered',
        nodeIndex: node.index,
        template: `covered ${amountText} by ${coverer.name}${translucentText}`,
        amount: description.amount,
        relatedIndex: coverer.index,
      }),
    );
  }

  return findings;
}

/** The two sibling subtrees that a covered link joins, as 'lowIndex|highIndex'. null when one contains the other. */
function getCoveredPairKey(nodes: MeasuredNode[], link: CoveredLink): string | null {
  let first = nodes[link.nodeIndex];
  let second = nodes[link.covererIndex];
  if (!first || !second) {
    return null;
  }

  while (first.depth > second.depth && first.parentIndex >= 0) {
    first = nodes[first.parentIndex];
  }

  while (second.depth > first.depth && second.parentIndex >= 0) {
    second = nodes[second.parentIndex];
  }

  while (first.parentIndex !== second.parentIndex && first.parentIndex >= 0 && second.parentIndex >= 0) {
    first = nodes[first.parentIndex];
    second = nodes[second.parentIndex];
  }

  if (first === second || first.parentIndex !== second.parentIndex) {
    return null;
  }

  return `${Math.min(first.index, second.index)}|${Math.max(first.index, second.index)}`;
}

function isOverlapEligible(node: MeasuredNode): boolean {
  const { ink } = node;
  const isPlaced = node.isInFlow || node.position === 'absolute';
  const hasOverlapInk = ink.background !== null || ink.hasBackgroundImage || ink.borderSides.length > 0 || ink.replaced !== null;

  return isShown(node) && isPlaced && !node.isFloat && !node.isInline && hasOverlapInk;
}

function isRectInside(inner: Rect, outer: Rect): boolean {
  const overhangs = getOverhangs(inner, outer);

  return physicalSides.every((side) => overhangs[side] <= 0.5);
}

function getSiblingOverlap(first: MeasuredNode, second: MeasuredNode): Rect | null {
  const intersection = getIntersection(first.rect, second.rect);
  if (!intersection || intersection.width < 2 || intersection.height < 2) {
    return null;
  }

  const isOneInsideOther = isRectInside(second.rect, first.rect) || isRectInside(first.rect, second.rect);

  return isOneInsideOther ? null : intersection;
}

function getOverlapsFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const coveredPairKeys = new Set<string>();

  for (const link of context.coveredLinks) {
    const pairKey = getCoveredPairKey(context.nodes, link);
    if (pairKey) {
      coveredPairKeys.add(pairKey);
    }
  }

  for (const parent of context.nodes) {
    if (isTransformed(parent)) continue;

    const eligibleChildren = context.childIndexesByParent[parent.index].map((index) => context.nodes[index]).filter(isOverlapEligible);
    if (eligibleChildren.length < 2) continue;

    const childrenByStartEdge = [...eligibleChildren].sort((first, second) => first.rect.x - second.rect.x);
    let activeChildren: MeasuredNode[] = [];

    for (const child of childrenByStartEdge) {
      activeChildren = activeChildren.filter((active) => getRight(active.rect) - child.rect.x >= 2);

      for (const active of activeChildren) {
        const overlap = getSiblingOverlap(active, child);
        if (!overlap) continue;

        const [earlier, later] = active.index < child.index ? [active, child] : [child, active];
        if (coveredPairKeys.has(`${earlier.index}|${later.index}`)) continue;

        findings.push(
          createFinding({
            kind: 'overlaps',
            nodeIndex: later.index,
            template: `overlaps ${earlier.name} {n}`,
            amount: Math.min(overlap.width, overlap.height),
            printedAmount: `${roundPixels(overlap.width)}x${roundPixels(overlap.height)}`,
            relatedIndex: earlier.index,
          }),
        );
      }

      activeChildren.push(child);

      if (activeChildren.length > maxActiveOverlapCandidates) {
        activeChildren.shift();
      }
    }
  }

  return findings;
}

function getOffCenterFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const parent of context.nodes) {
    if (!isShown(parent) || (!hasBoxInk(parent) && !parent.isControl)) continue;
    if (isTransformed(parent) || isScrollContainer(parent) || parent.ink.pseudoInk !== null) continue;

    const childIndexes = context.childIndexesByParent[parent.index];
    const hasFlowChild = childIndexes.some((index) => isShown(context.nodes[index]) && context.nodes[index].isInFlow);
    if (!hasFlowChild) continue;

    const itemRects = getFlowItemRects(context.page, parent, childIndexes);
    const doChildrenOverflow = itemRects.some((rect) => {
      const overhangs = getOverhangs(rect, parent.rect);

      return physicalSides.some((side) => overhangs[side] >= 0.5);
    });

    if (doChildrenOverflow) continue;

    const contentBox = getContentBox(parent);
    const itemUnion = getUnion(itemRects);
    const [paddingTop, paddingRight, paddingBottom, paddingLeft] = parent.padding;
    const leftFree = itemUnion.x - contentBox.x;
    const rightFree = getRight(contentBox) - getRight(itemUnion);
    const isRightToLeft = parent.direction === 'rtl';

    const centeringAxes = [
      {
        hasSymmetricPadding: Math.abs(paddingTop - paddingBottom) < 0.5,
        before: itemUnion.y - contentBox.y,
        after: getBottom(contentBox) - getBottom(itemUnion),
        towardAfter: 'down',
        towardBefore: 'up',
      },
      {
        hasSymmetricPadding: Math.abs(paddingLeft - paddingRight) < 0.5,
        before: isRightToLeft ? rightFree : leftFree,
        after: isRightToLeft ? leftFree : rightFree,
        towardAfter: 'end',
        towardBefore: 'start',
      },
    ];

    for (const axis of centeringAxes) {
      const difference = axis.before - axis.after;
      const distance = Math.abs(difference);
      const isWithinCenteringRange = distance >= 2 && distance <= 0.5 * (axis.before + axis.after);
      if (!axis.hasSymmetricPadding || !isWithinCenteringRange) continue;

      const towardText = difference > 0 ? axis.towardAfter : axis.towardBefore;

      findings.push(
        createFinding({
          kind: 'off-center',
          nodeIndex: parent.index,
          template: `off center {n} ${towardText}`,
          amount: distance,
        }),
      );
    }
  }

  return findings;
}

function getTextOffCenterFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const node of context.nodes) {
    const { textInfo } = node;
    if (!isShown(node) || !textInfo || textInfo.lineCount !== 1 || isTransformed(node)) continue;
    if (!hasBoxInk(node) && !node.isControl) continue;

    const hasChildBox = context.childIndexesByParent[node.index].some((index) => isShown(context.nodes[index]));
    const hasSymmetricBlockPadding = Math.abs(node.padding[0] - node.padding[2]) < 0.5;
    if (hasChildBox || !hasSymmetricBlockPadding) continue;

    const paddingBox = getPaddingBox(node);
    const spaceAbove = textInfo.capTop - paddingBox.y;
    const spaceBelow = getBottom(paddingBox) - textInfo.baseline;
    const difference = spaceAbove - spaceBelow;
    const distance = Math.abs(difference);
    const isWithinCenteringRange = distance >= 3 && distance <= 0.5 * (spaceAbove + spaceBelow);
    if (!isWithinCenteringRange) continue;

    findings.push(
      createFinding({
        kind: 'text-off-center',
        nodeIndex: node.index,
        template: `text off center {n} ${difference > 0 ? 'down' : 'up'}`,
        amount: distance,
      }),
    );
  }

  return findings;
}

/**
 * Rows of two or more shown siblings of one sibling group that sit side by side. A sibling joins a row when its top is
 * within 1 px of the first member's top or above that member's bottom. Members are in tree order.
 */
function getChildrenByGroupName(context: AnalysisContext, childIndexes: number[]): Map<string, MeasuredNode[]> {
  const childrenByGroupName = new Map<string, MeasuredNode[]>();

  for (const index of childIndexes) {
    const child = context.nodes[index];
    if (!isShown(child) || child.position === 'fixed') continue;

    const groupName = context.siblingGroupNames[index];
    const sameGroupChildren = childrenByGroupName.get(groupName) ?? [];

    sameGroupChildren.push(child);
    childrenByGroupName.set(groupName, sameGroupChildren);
  }

  return childrenByGroupName;
}

function getSiblingGroupRows(childrenByGroupName: Map<string, MeasuredNode[]>): MeasuredNode[][] {
  const siblingGroupRows: MeasuredNode[][] = [];

  for (const sameGroupChildren of childrenByGroupName.values()) {
    if (sameGroupChildren.length < 2) continue;

    const childrenByTop = [...sameGroupChildren].sort((first, second) => first.rect.y - second.rect.y);
    let currentRow: MeasuredNode[] = [];

    for (const child of childrenByTop) {
      const rowStart = currentRow[0]?.rect;
      const isBesideRow = rowStart !== undefined && (child.rect.y - rowStart.y <= 1 || child.rect.y < getBottom(rowStart) - 1);

      if (currentRow.length > 0 && !isBesideRow) {
        siblingGroupRows.push(currentRow);
        currentRow = [];
      }

      currentRow.push(child);
    }

    siblingGroupRows.push(currentRow);
  }

  return siblingGroupRows.filter((row) => row.length >= 2).map((row) => row.sort((first, second) => first.index - second.index));
}

/** Sibling groups of two or more whose members all sit below each other, none side by side. Members are in tree order. */
function getSiblingGroupColumns(childrenByGroupName: Map<string, MeasuredNode[]>): MeasuredNode[][] {
  const siblingGroupColumns: MeasuredNode[][] = [];

  for (const sameGroupChildren of childrenByGroupName.values()) {
    if (sameGroupChildren.length < 2) continue;

    const childrenByTop = [...sameGroupChildren].sort((first, second) => first.rect.y - second.rect.y);
    const isStacked = childrenByTop.slice(1).every((child, position) => child.rect.y >= getBottom(childrenByTop[position].rect) - 1);

    if (isStacked) {
      siblingGroupColumns.push(sameGroupChildren);
    }
  }

  return siblingGroupColumns;
}

/**
 * Shown descendants by their relative path below `member`. Each step is the tag and its position among the parent's
 * children, like `ul[1]>li[2]`. Two descendants pair only when every step has the same tag at the same position. A
 * `.button-primary` in one card then pairs with a `.button-secondary` in the next, and never with a divider.
 */
function getDescendantIndexByRelativePath(nodes: MeasuredNode[], member: MeasuredNode): Map<string, number> {
  const pathByIndex = new Map<number, string>([[member.index, '']]);
  const childCountByParent = new Map<number, number>();
  const descendantIndexByPath = new Map<string, number>();
  const lastIndex = Math.min(member.subtreeEnd, member.index + maxAlignmentDescendantsPerMember);

  for (let index = member.index + 1; index <= lastIndex; index++) {
    const descendant = nodes[index];
    const parentPath = pathByIndex.get(descendant.parentIndex);
    if (parentPath === undefined) continue;

    const childPosition = childCountByParent.get(descendant.parentIndex) ?? 0;
    childCountByParent.set(descendant.parentIndex, childPosition + 1);

    const step = `${descendant.tag}[${childPosition}]`;
    const path = parentPath === '' ? step : `${parentPath}>${step}`;
    pathByIndex.set(index, path);

    if (isShown(descendant)) {
      descendantIndexByPath.set(path, index);
    }
  }

  return descendantIndexByPath;
}

/** True when the tops, the vertical centers and the bottoms, taken from each reference top, all spread by 2 px or more. */
function hasSpreadTops(nodes: MeasuredNode[], indexes: number[], referenceTops: number[]): boolean {
  const nodeRects = indexes.map((index) => nodes[index].rect);
  const topSpread = getSpread(nodeRects.map((rect, position) => rect.y - referenceTops[position]));
  const centerSpread = getSpread(nodeRects.map((rect, position) => rect.y + rect.height / 2 - referenceTops[position]));
  const bottomSpread = getSpread(nodeRects.map((rect, position) => getBottom(rect) - referenceTops[position]));

  return [topSpread, centerSpread, bottomSpread].every((spread) => spread.max - spread.min >= 2);
}

/** `min..max` of the printed `@x,y` values, so the numbers can be found in the tree. */
function getPrintedRangeText(printedValues: number[]): string {
  const roundedValues = printedValues.map(roundPixels);

  return `${Math.min(...roundedValues)}..${Math.max(...roundedValues)}`;
}

function createTopsAcrossSiblingsFinding(context: AnalysisContext, parent: MeasuredNode, name: string, indexes: number[]): Finding {
  const topRangeText = getPrintedRangeText(indexes.map((index) => context.layouts[index].y));

  return createFinding({ kind: 'tops-across-siblings', nodeIndex: parent.index, template: `${name} tops ${topRangeText} across siblings` });
}

/**
 * Up to two findings per row. One is for the members' own tops in the parent's content box. The other is for the first
 * descendant whose tops spread across the members. Later descendants usually move with that first one.
 * A descendant spreads when it does so both from each member's top and in the row. The first keeps a pushed down card
 * from repeating on its content. The second keeps parts that line up on screen quiet when the members differ in height.
 * The printed range is each node's own `@y`, as the tree prints it.
 */
function getTopsAcrossSiblingsFindings(context: AnalysisContext, parent: MeasuredNode, row: MeasuredNode[]): Finding[] {
  const findings: Finding[] = [];
  const members = row.slice(0, maxAlignmentGroupMembers);
  const memberIndexes = members.map((member) => member.index);
  const parentContentTop = getContentBox(parent).y;
  if (hasSpreadTops(context.nodes, memberIndexes, members.map(() => parentContentTop))) {
    findings.push(createTopsAcrossSiblingsFinding(context, parent, context.siblingGroupNames[members[0].index], memberIndexes));
  }

  const memberTops = members.map((member) => member.rect.y);
  const descendantIndexByPathPerMember = members.map((member) => getDescendantIndexByRelativePath(context.nodes, member));

  for (const [path, firstDescendantIndex] of descendantIndexByPathPerMember[0]) {
    const descendantIndexes = descendantIndexByPathPerMember.map((descendantIndexByPath) => descendantIndexByPath.get(path) ?? -1);
    if (descendantIndexes.some((index) => index < 0)) continue;

    const isSpreadInMembers = hasSpreadTops(context.nodes, descendantIndexes, memberTops);
    const isSpreadInRow = hasSpreadTops(context.nodes, descendantIndexes, members.map(() => parentContentTop));
    if (!isSpreadInMembers || !isSpreadInRow) continue;

    findings.push(createTopsAcrossSiblingsFinding(context, parent, context.nodes[firstDescendantIndex].name, descendantIndexes));
    break;
  }

  return findings;
}

/** Start, center and end of a rect along the inline direction, measured from `referenceStart` toward the end edge. */
function getInlineLines(rect: Rect, referenceStart: number, direction: 'ltr' | 'rtl'): { start: number; center: number; end: number } {
  const start = direction === 'rtl' ? referenceStart - getRight(rect) : rect.x - referenceStart;

  return { start, center: start + rect.width / 2, end: start + rect.width };
}

/** True when the starts, the centers and the ends, taken from each reference start, all spread by 2 px or more. */
function hasSpreadStarts(nodes: MeasuredNode[], indexes: number[], referenceStarts: number[], direction: 'ltr' | 'rtl'): boolean {
  const inlineLines = indexes.map((index, position) => getInlineLines(nodes[index].rect, referenceStarts[position], direction));
  const startSpread = getSpread(inlineLines.map((lines) => lines.start));
  const centerSpread = getSpread(inlineLines.map((lines) => lines.center));
  const endSpread = getSpread(inlineLines.map((lines) => lines.end));

  return [startSpread, centerSpread, endSpread].every((spread) => spread.max - spread.min >= 2);
}

function getInlineStartEdge(rect: Rect, direction: 'ltr' | 'rtl'): number {
  return direction === 'rtl' ? getRight(rect) : rect.x;
}

function createStartsAcrossSiblingsFinding(context: AnalysisContext, parent: MeasuredNode, name: string, indexes: number[]): Finding {
  const startRangeText = getPrintedRangeText(indexes.map((index) => context.layouts[index].x));

  return createFinding({ kind: 'starts-across-siblings', nodeIndex: parent.index, template: `${name} starts ${startRangeText} across siblings` });
}

/**
 * The inline twin of tops across siblings, for siblings stacked in a column. Up to two findings per column: one for the
 * members' own starts in the parent's content box, one for the first descendant whose starts spread across the members.
 * Descendants count only when every member has the same shape, the same relative paths, like a column of form fields.
 * Inline boxes are skipped, because they start where the text before them ends.
 */
function getStartsAcrossSiblingsFindings(context: AnalysisContext, parent: MeasuredNode, column: MeasuredNode[]): Finding[] {
  const findings: Finding[] = [];
  const direction = parent.direction;
  const members = column.slice(0, maxAlignmentGroupMembers);
  const memberIndexes = members.map((member) => member.index);
  const parentContentStart = getInlineStartEdge(getContentBox(parent), direction);
  if (hasSpreadStarts(context.nodes, memberIndexes, members.map(() => parentContentStart), direction)) {
    findings.push(createStartsAcrossSiblingsFinding(context, parent, context.siblingGroupNames[members[0].index], memberIndexes));
  }

  const memberStarts = members.map((member) => getInlineStartEdge(member.rect, direction));
  const descendantIndexByPathPerMember = members.map((member) => getDescendantIndexByRelativePath(context.nodes, member));
  const firstMemberShape = [...descendantIndexByPathPerMember[0].keys()].join(',');
  const hasSameShape = descendantIndexByPathPerMember.every((descendantIndexByPath) => [...descendantIndexByPath.keys()].join(',') === firstMemberShape);
  if (!hasSameShape) {
    return findings;
  }

  for (const [path, firstDescendantIndex] of descendantIndexByPathPerMember[0]) {
    const descendantIndexes = descendantIndexByPathPerMember.map((descendantIndexByPath) => descendantIndexByPath.get(path)!);
    const isEveryDescendantPlaced = descendantIndexes.every((index) => !isInlineBox(context.nodes[index]));
    if (!isEveryDescendantPlaced) continue;

    const isSpreadInMembers = hasSpreadStarts(context.nodes, descendantIndexes, memberStarts, direction);
    const isSpreadInColumn = hasSpreadStarts(context.nodes, descendantIndexes, members.map(() => parentContentStart), direction);
    if (!isSpreadInMembers || !isSpreadInColumn) continue;

    findings.push(createStartsAcrossSiblingsFinding(context, parent, context.nodes[firstDescendantIndex].name, descendantIndexes));
    break;
  }

  return findings;
}

/** The size shared by at least half of the sizes within 1 px, or null. */
function getSharedSize(sizes: number[]): number | null {
  const sortedSizes = [...sizes].sort((first, second) => first - second);
  let windowStart = 0;
  let bestWindowStart = 0;
  let bestWindowSize = 0;

  for (let windowEnd = 0; windowEnd < sortedSizes.length; windowEnd++) {
    while (sortedSizes[windowEnd] - sortedSizes[windowStart] > 1) {
      windowStart++;
    }

    if (windowEnd - windowStart + 1 > bestWindowSize) {
      bestWindowSize = windowEnd - windowStart + 1;
      bestWindowStart = windowStart;
    }
  }

  if (bestWindowSize * 2 < sortedSizes.length) {
    return null;
  }

  return sortedSizes[bestWindowStart + Math.floor(bestWindowSize / 2)];
}

function getWiderFindings(context: AnalysisContext, row: MeasuredNode[]): Finding[] {
  const findings: Finding[] = [];
  const sharedWidth = row.length >= 3 ? getSharedSize(row.map((member) => member.rect.width)) : null;
  if (sharedWidth === null) {
    return findings;
  }

  for (const member of row) {
    const extraWidth = member.rect.width - sharedWidth;
    const groupName = context.siblingGroupNames[member.index];

    if (extraWidth < 2 || isTransformed(member)) continue;

    findings.push(createFinding({ kind: 'wider', nodeIndex: member.index, template: `{n} wider than ${groupName}`, amount: extraWidth }));
  }

  return findings;
}

/** The height twin of wider. It prints both ways: `taller than` and `shorter than`. */
function getHeightFindings(context: AnalysisContext, row: MeasuredNode[]): Finding[] {
  const findings: Finding[] = [];
  const sharedHeight = row.length >= 3 ? getSharedSize(row.map((member) => member.rect.height)) : null;
  if (sharedHeight === null) {
    return findings;
  }

  for (const member of row) {
    const heightDifference = member.rect.height - sharedHeight;
    const groupName = context.siblingGroupNames[member.index];

    if (Math.abs(heightDifference) < 2 || isTransformed(member)) continue;

    const kind = heightDifference > 0 ? 'taller' : 'shorter';
    findings.push(createFinding({ kind, nodeIndex: member.index, template: `{n} ${kind} than ${groupName}`, amount: Math.abs(heightDifference) }));
  }

  return findings;
}

function getRowFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const parent of context.nodes) {
    const childrenByGroupName = getChildrenByGroupName(context, context.childIndexesByParent[parent.index]);

    for (const row of getSiblingGroupRows(childrenByGroupName)) {
      findings.push(...getTopsAcrossSiblingsFindings(context, parent, row), ...getWiderFindings(context, row), ...getHeightFindings(context, row));
    }

    for (const column of getSiblingGroupColumns(childrenByGroupName)) {
      findings.push(...getStartsAcrossSiblingsFindings(context, parent, column));
    }
  }

  return findings;
}

function getPairGap(previous: MeasuredNode, current: MeasuredNode, direction: 'ltr' | 'rtl'): { axis: 'x' | 'y'; gap: number } | null {
  if (current.rect.y >= getBottom(previous.rect) - 0.5) {
    return { axis: 'y', gap: current.rect.y - getBottom(previous.rect) };
  }

  const isVerticallyOverlapping = current.rect.y < getBottom(previous.rect) && previous.rect.y < getBottom(current.rect);
  const inlineGap = getInlineGap(current.rect, previous.rect, direction);
  if (isVerticallyOverlapping && inlineGap >= -0.5) {
    return { axis: 'x', gap: inlineGap };
  }

  return null;
}

function getSiblingGapsFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const parent of context.nodes) {
    const flowChildren = context.childIndexesByParent[parent.index]
      .map((index) => context.nodes[index])
      .filter((child) => isShown(child) && child.isInFlow);
    let runAxis: 'x' | 'y' | null = null;
    let runGaps: number[] = [];
    let runSiblingGroupName = '';

    const closeRun = () => {
      if (runGaps.length >= 3) {
        const roundedGaps = runGaps.map(roundPixels);
        const mostCommonGap = getMostCommonValue(roundedGaps);

        if (runGaps.some((gap) => Math.abs(gap - mostCommonGap) >= 2)) {
          const template = `gaps ${roundedGaps.join(' ')} between ${runSiblingGroupName}`;

          findings.push(createFinding({ kind: 'sibling-gaps', nodeIndex: parent.index, template }));
        }
      }

      runAxis = null;
      runGaps = [];
    };

    for (let position = 1; position < flowChildren.length; position++) {
      const previous = flowChildren[position - 1];
      const current = flowChildren[position];
      const currentGroupName = context.siblingGroupNames[current.index];
      const isSameGroup = currentGroupName === context.siblingGroupNames[previous.index];
      const pairGap = isSameGroup ? getPairGap(previous, current, parent.direction) : null;
      if (!pairGap || (runAxis !== null && pairGap.axis !== runAxis)) {
        closeRun();
      }

      if (pairGap) {
        runAxis = pairGap.axis;
        runGaps.push(pairGap.gap);
        runSiblingGroupName = currentGroupName;
      }
    }

    closeRun();
  }

  return findings;
}

function getTextTruncatedFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const node of context.nodes) {
    const truncation = node.textInfo?.truncation;
    if (!isShown(node) || !truncation || !hasReportedTruncation(node)) continue;

    if (truncation.kind === 'clamp') {
      findings.push(createFinding({ kind: 'text-truncated', nodeIndex: node.index, template: 'text clamped {n} lines', amount: truncation.clampLines }));
      continue;
    }

    const template = truncation.kind === 'ellipsis' ? 'text truncated ellipsis {n}' : 'text cut {n}';
    findings.push(createFinding({ kind: 'text-truncated', nodeIndex: node.index, template, amount: truncation.hiddenPx }));
  }

  return findings;
}

function getRelativeLuminance(hexColor: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hexColor.slice(offset, offset + 2), 16) / 255;

    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function getContrastRatio(firstHexColor: string, secondHexColor: string): number {
  const firstLuminance = getRelativeLuminance(firstHexColor);
  const secondLuminance = getRelativeLuminance(secondHexColor);

  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

/** One decimal, rounded down, so a failing ratio never prints as the passing value. */
export function getPrintedContrastRatio(ratio: number): string {
  return (Math.floor(ratio * 10) / 10).toFixed(1);
}

function getContrastFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const node of context.nodes) {
    const { textInfo } = node;
    if (!isShown(node) || !textInfo || textInfo.color === null || textInfo.background === null || node.isDisabled) continue;

    const ratio = getContrastRatio(textInfo.color, textInfo.background);
    const minimumRatio = textInfo.isLarge ? 3 : 4.5;
    if (ratio >= minimumRatio) continue;

    const printedAmount = getPrintedContrastRatio(ratio);

    findings.push(
      createFinding({
        kind: 'contrast',
        nodeIndex: node.index,
        template: 'contrast {n}',
        amount: ratio,
        printedAmount,
        textColor: textInfo.color,
      }),
    );
  }

  return findings;
}

function isLargeEnoughTarget(rect: Rect): boolean {
  return rect.width >= 24 && rect.height >= 24;
}

function getCenter(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function getDistanceToRect(point: { x: number; y: number }, rect: Rect): number {
  const horizontalDistance = Math.max(rect.x - point.x, 0, point.x - getRight(rect));
  const verticalDistance = Math.max(rect.y - point.y, 0, point.y - getBottom(rect));

  return Math.hypot(horizontalDistance, verticalDistance);
}

function isNested(first: MeasuredNode, second: MeasuredNode): boolean {
  return isDescendant(first, second) || isDescendant(second, first);
}

/** Targets grouped by the grid cells that their rects touch, for neighbor lookups. */
function createTargetGrid(targets: MeasuredNode[]): Map<string, MeasuredNode[]> {
  const targetsByCell = new Map<string, MeasuredNode[]>();

  for (const target of targets) {
    const firstColumn = Math.floor(target.rect.x / targetGridCellSize);
    const lastColumn = Math.floor(getRight(target.rect) / targetGridCellSize);
    const firstRow = Math.floor(target.rect.y / targetGridCellSize);
    const lastRow = Math.floor(getBottom(target.rect) / targetGridCellSize);

    for (let column = firstColumn; column <= lastColumn; column++) {
      for (let row = firstRow; row <= lastRow; row++) {
        const cellKey = `${column},${row}`;
        const cellTargets = targetsByCell.get(cellKey) ?? [];
        cellTargets.push(target);
        targetsByCell.set(cellKey, cellTargets);
      }
    }
  }

  return targetsByCell;
}

/**
 * WCAG 2.5.8 spacing. A 24 px circle on the target's center touches no other target and no other undersized target's circle.
 * A target that is not inert ignores inert neighbors, because nothing can hit them. An inert target, behind a modal,
 * still compares with its own neighbors, so an element match there prints its finding.
 */
function isSpacedTarget(target: MeasuredNode, targetsByCell: Map<string, MeasuredNode[]>, undersizedIndexes: Set<number>): boolean {
  const center = getCenter(target.rect);
  const firstColumn = Math.floor((center.x - 2 * targetSpacingRadius) / targetGridCellSize);
  const lastColumn = Math.floor((center.x + 2 * targetSpacingRadius) / targetGridCellSize);
  const firstRow = Math.floor((center.y - 2 * targetSpacingRadius) / targetGridCellSize);
  const lastRow = Math.floor((center.y + 2 * targetSpacingRadius) / targetGridCellSize);

  for (let column = firstColumn; column <= lastColumn; column++) {
    for (let row = firstRow; row <= lastRow; row++) {
      for (const neighbor of targetsByCell.get(`${column},${row}`) ?? []) {
        const isUnreachableInertNeighbor = neighbor.isInert && !target.isInert;
        if (neighbor === target || isNested(neighbor, target) || isUnreachableInertNeighbor) continue;

        const neighborCenter = getCenter(neighbor.rect);
        const isTouchingNeighbor = getDistanceToRect(center, neighbor.rect) < targetSpacingRadius;
        const isTouchingNeighborCircle =
          undersizedIndexes.has(neighbor.index) && Math.hypot(neighborCenter.x - center.x, neighborCenter.y - center.y) < 2 * targetSpacingRadius;

        if (isTouchingNeighbor || isTouchingNeighborCircle) {
          return false;
        }
      }
    }
  }

  return true;
}

/** Coverage sampling found something painted over every sample of its ink. */
function isFullyCovered(node: MeasuredNode): boolean {
  return node.coverage !== null && node.coverage.sampleCount > 0 && node.coverage.coveredSampleCount === node.coverage.sampleCount;
}

/** A target that a pointer can reach: not `pointer-events: none` and not covered on every sample. Inert targets are checked per pair. */
function isHittableTarget(node: MeasuredNode): boolean {
  return !node.isPointerEventsNone && !isFullyCovered(node);
}

function getSmallTargetFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const targets = context.nodes.filter((node) => isShown(node) && node.isInteractive);
  const hittableTargets = targets.filter(isHittableTarget);

  const undersizedTargets = targets.filter((target) => {
    const isLinkInText = target.tag === 'a' && target.isInlineInText;
    const label = target.labelIndex === null ? null : context.nodes[target.labelIndex];
    const hasLargeLabel = label !== null && isShown(label) && isLargeEnoughTarget(label.rect);

    return !isLinkInText && !hasLargeLabel && !isLargeEnoughTarget(target.rect);
  });

  const targetsByCell = createTargetGrid(hittableTargets);
  const undersizedIndexes = new Set(undersizedTargets.map((target) => target.index));

  for (const target of undersizedTargets) {
    if (isSpacedTarget(target, targetsByCell, undersizedIndexes)) continue;

    const { width, height } = target.rect;

    findings.push(
      createFinding({
        kind: 'small-target',
        nodeIndex: target.index,
        template: 'small target {n}',
        amount: Math.min(width, height),
        printedAmount: `${roundPixels(width)}x${roundPixels(height)}`,
      }),
    );
  }

  return findings;
}

function getImageContentSize(node: MeasuredNode): { width: number; height: number } {
  const [borderTop, borderRight, borderBottom, borderLeft] = node.border;
  const [paddingTop, paddingRight, paddingBottom, paddingLeft] = node.padding;

  return {
    width: node.layoutWidth - borderLeft - borderRight - paddingLeft - paddingRight,
    height: node.layoutHeight - borderTop - borderBottom - paddingTop - paddingBottom,
  };
}

function getImageScale(node: MeasuredNode, naturalWidth: number, naturalHeight: number, objectFit: string): number {
  const contentSize = getImageContentSize(node);
  const horizontalScale = contentSize.width / naturalWidth;
  const verticalScale = contentSize.height / naturalHeight;
  const containScale = Math.min(horizontalScale, verticalScale);

  if (objectFit === 'contain') {
    return containScale;
  }

  if (objectFit === 'cover') {
    return Math.max(horizontalScale, verticalScale);
  }

  if (objectFit === 'none') {
    return 1;
  }

  if (objectFit === 'scale-down') {
    return Math.min(1, containScale);
  }

  return horizontalScale;
}

function getImageFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const node of context.nodes) {
    const { image } = node;
    if (!isShown(node) || !image) continue;

    const isSpacerImage = image.naturalWidth <= 2 && image.naturalHeight <= 2;
    const hasNaturalSize = image.naturalWidth > 0 && image.naturalHeight > 0 && !isSpacerImage;

    if (node.tag === 'img' && image.hasSource && image.isComplete && image.naturalWidth === 0) {
      findings.push(createFinding({ kind: 'image-not-loaded', nodeIndex: node.index, template: 'image not loaded' }));
    }

    if ((node.tag === 'img' || node.tag === 'video') && image.objectFit === 'fill' && hasNaturalSize) {
      const contentSize = getImageContentSize(node);
      const aspectRatioToNatural = contentSize.width / contentSize.height / (image.naturalWidth / image.naturalHeight);

      if (Math.abs(aspectRatioToNatural - 1) >= 0.02) {
        findings.push(
          createFinding({
            kind: 'image-aspect',
            nodeIndex: node.index,
            template: 'image aspect {n} of natural',
            amount: aspectRatioToNatural,
            printedAmount: aspectRatioToNatural.toFixed(2),
          }),
        );
      }
    }

    if (node.tag === 'img' && !image.isVector && hasNaturalSize) {
      const upscale = getImageScale(node, image.naturalWidth, image.naturalHeight, image.objectFit) * context.page.devicePixelRatio;

      if (upscale >= 1.25) {
        findings.push(
          createFinding({
            kind: 'image-upscaled',
            nodeIndex: node.index,
            template: 'image upscaled {n}',
            amount: upscale,
            printedAmount: upscale.toFixed(1),
          }),
        );
      }
    }
  }

  return findings;
}

function getScrollRangeFindings(context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];

  for (const node of context.nodes) {
    if (!isShown(node) || !node.scroll) continue;

    for (const scrollAxis of node.scroll.axes) {
      const excess = scrollAxis.contentSize - scrollAxis.visibleSize;
      if (excess < 1 || excess > 8) continue;

      findings.push(
        createFinding({ kind: 'scroll-range', nodeIndex: node.index, template: `scroll range ${scrollAxis.axis} {n}`, amount: excess }),
      );
    }
  }

  return findings;
}

export function analyze(page: PageMeasurement): Analysis {
  const context = createAnalysisContext(page);
  const pastViewportOverhangs = getPastViewportOverhangs(context);

  const findings = [
    ...getClippedFindings(context),
    ...getClippedOutFindings(context),
    ...getOverflowsFindings(context, pastViewportOverhangs),
    ...getTextOverflowsFindings(context),
    ...getPastViewportFindings(context, pastViewportOverhangs),
    ...getCoveredFindings(context),
    ...getOverlapsFindings(context),
    ...getOffCenterFindings(context),
    ...getTextOffCenterFindings(context),
    ...getRowFindings(context),
    ...getSiblingGapsFindings(context),
    ...getTextTruncatedFindings(context),
    ...getContrastFindings(context),
    ...getSmallTargetFindings(context),
    ...getImageFindings(context),
    ...getScrollRangeFindings(context),
  ];

  const getKindPosition = (finding: Finding) => findingKindOrder.indexOf(finding.kind);
  findings.sort((first, second) => first.nodeIndex - second.nodeIndex || getKindPosition(first) - getKindPosition(second));

  const listedFindings = findings.filter((finding) => !isHiddenBehindModal(page, finding.nodeIndex));

  return { layouts: context.layouts, findings: listedFindings, behindModalFindingCount: findings.length - listedFindings.length };
}

/** Inert behind an open modal, and not inside an element match. An element match is an explicit request, so it keeps its findings. */
function isHiddenBehindModal(page: PageMeasurement, nodeIndex: number): boolean {
  const node = page.nodes[nodeIndex];
  if (page.modalIndex === null || !node.isInert) {
    return false;
  }

  const isInsideModal = page.modalIndex <= nodeIndex && nodeIndex <= page.nodes[page.modalIndex].subtreeEnd;
  const isInsideElementMatch = (page.element?.matchedIndexes ?? []).some(
    (matchedIndex) => matchedIndex <= nodeIndex && nodeIndex <= page.nodes[matchedIndex].subtreeEnd,
  );

  return !isInsideModal && !isInsideElementMatch;
}
