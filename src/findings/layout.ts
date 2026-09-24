import type { Gaps, MeasuredNode, NodeLayout, PageMeasurement, Rect } from '../types.ts';

/** Rounds half away from zero, as every printed pixel value is. */
export function roundPixels(value: number): number {
  const rounded = Math.sign(value) * Math.round(Math.abs(value));

  return rounded === 0 ? 0 : rounded;
}

/** A background, border, shadow or outline that shows the node's box. */
export function hasBoxInk(node: MeasuredNode): boolean {
  const { ink } = node;

  return ink.background !== null || ink.hasBackgroundImage || ink.borderSides.length > 0 || ink.hasShadow || ink.hasOutline;
}

export function getRight(rect: Rect): number {
  return rect.x + rect.width;
}

export function getBottom(rect: Rect): number {
  return rect.y + rect.height;
}

/** True when the node's own transform scales either axis. */
export function isScaled(node: MeasuredNode): boolean {
  return node.scale.x !== 1 || node.scale.y !== 1;
}

/**
 * Drawn size over layout size on each axis. Border and padding are layout values, and a scale draws them bigger or
 * smaller. It is 1 outside transforms.
 */
function getDrawnScale(node: MeasuredNode): { x: number; y: number } {
  const isDrawnScaled = isScaled(node) || node.isInsideTransform;
  if (!isDrawnScaled || node.layoutWidth <= 0 || node.layoutHeight <= 0) {
    return { x: 1, y: 1 };
  }

  return { x: node.rect.width / node.layoutWidth, y: node.rect.height / node.layoutHeight };
}

function getDrawnSides(node: MeasuredNode, sides: MeasuredNode['border']): MeasuredNode['border'] {
  const drawnScale = getDrawnScale(node);

  return [sides[0] * drawnScale.y, sides[1] * drawnScale.x, sides[2] * drawnScale.y, sides[3] * drawnScale.x];
}

export function getPaddingBox(node: MeasuredNode): Rect {
  const [borderTop, borderRight, borderBottom, borderLeft] = getDrawnSides(node, node.border);

  return {
    x: node.rect.x + borderLeft,
    y: node.rect.y + borderTop,
    width: node.rect.width - borderLeft - borderRight,
    height: node.rect.height - borderTop - borderBottom,
  };
}

export function getContentBox(node: MeasuredNode): Rect {
  const paddingBox = getPaddingBox(node);
  const [paddingTop, paddingRight, paddingBottom, paddingLeft] = getDrawnSides(node, node.padding);

  return {
    x: paddingBox.x + paddingLeft,
    y: paddingBox.y + paddingTop,
    width: paddingBox.width - paddingLeft - paddingRight,
    height: paddingBox.height - paddingTop - paddingBottom,
  };
}

export function getIntersection(first: Rect, second: Rect): Rect | null {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(getRight(first), getRight(second));
  const bottom = Math.min(getBottom(first), getBottom(second));
  if (right <= left || bottom <= top) {
    return null;
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function getUnion(rects: Rect[]): Rect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, getRight(rect));
    bottom = Math.max(bottom, getBottom(rect));
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function getChildIndexesByParent(page: PageMeasurement): number[][] {
  const childIndexesByParent: number[][] = page.nodes.map(() => []);

  for (const node of page.nodes) {
    if (node.parentIndex >= 0) {
      childIndexesByParent[node.parentIndex].push(node.index);
    }
  }

  return childIndexesByParent;
}

function isUngroupedPair(page: PageMeasurement, sameTagIndexes: number[]): boolean {
  if (sameTagIndexes.length !== 2) {
    return false;
  }

  const [firstClassNames, secondClassNames] = sameTagIndexes.map((index) => getNameClassNames(page.nodes[index].name));
  const hasSharedClass = firstClassNames.some((className) => secondClassNames.includes(className));
  const hasAnyClass = firstClassNames.length > 0 || secondClassNames.length > 0;

  return hasAnyClass && !hasSharedClass;
}

/**
 * The name that groups each node with its siblings. It is the tag plus the classes of its name that more than half of
 * its same-tag siblings carry, or at least two of them. A class on one sibling, such as `active`, does not split the
 * group. Two same-tag siblings group only when they share a class or both have none. Otherwise they keep their own
 * names. Roots keep their own name.
 */
export function getSiblingGroupNames(page: PageMeasurement, childIndexesByParent: number[][]): string[] {
  const siblingGroupNames = page.nodes.map((node) => node.name);

  for (const childIndexes of childIndexesByParent) {
    const childIndexesByTag = new Map<string, number[]>();

    for (const childIndex of childIndexes) {
      const tag = page.nodes[childIndex].tag;
      const sameTagIndexes = childIndexesByTag.get(tag) ?? [];

      sameTagIndexes.push(childIndex);
      childIndexesByTag.set(tag, sameTagIndexes);
    }

    for (const [tag, sameTagIndexes] of childIndexesByTag) {
      if (isUngroupedPair(page, sameTagIndexes)) continue;

      const siblingCountByClassName = new Map<string, number>();

      for (const index of sameTagIndexes) {
        for (const className of getNameClassNames(page.nodes[index].name)) {
          siblingCountByClassName.set(className, (siblingCountByClassName.get(className) ?? 0) + 1);
        }
      }

      for (const index of sameTagIndexes) {
        const sharedClassNames = getNameClassNames(page.nodes[index].name).filter((className) => {
          const siblingCount = siblingCountByClassName.get(className)!;

          return siblingCount * 2 > sameTagIndexes.length || siblingCount >= 2;
        });

        siblingGroupNames[index] = [tag, ...sharedClassNames].join('.');
      }
    }
  }

  return siblingGroupNames;
}

/** The classes printed in a node name, `tag#id.first.second`. */
export function getNameClassNames(name: string): string[] {
  return name.split('.').slice(1);
}

/** Rects of the shown in-flow children and the own text runs of a node, in tree order. */
export function getFlowItemRects(page: PageMeasurement, node: MeasuredNode, childIndexes: number[]): Rect[] {
  const flowItemRects: Rect[] = [];
  const textRuns = node.textRuns;
  let nextTextRunIndex = 0;

  childIndexes.forEach((childIndex, childPosition) => {
    while (nextTextRunIndex < textRuns.length && textRuns[nextTextRunIndex].afterChildCount <= childPosition) {
      flowItemRects.push(textRuns[nextTextRunIndex].rect);
      nextTextRunIndex++;
    }

    const child = page.nodes[childIndex];
    if (child.visibility === 'shown' && child.isInFlow) {
      flowItemRects.push(child.rect);
    }
  });

  for (const textRun of textRuns.slice(nextTextRunIndex)) {
    flowItemRects.push(textRun.rect);
  }

  return flowItemRects;
}

function getOffsetFromBox(rect: Rect, box: Rect, direction: 'ltr' | 'rtl'): { x: number; y: number } {
  const x = direction === 'rtl' ? getRight(box) - getRight(rect) : rect.x - box.x;

  return { x, y: rect.y - box.y };
}

function getPosition(page: PageMeasurement, node: MeasuredNode): { x: number; y: number } {
  const { width, height } = page.viewport;

  if (node.isViewportFrame) {
    const viewportRect = { x: page.scroll.x, y: page.scroll.y, width, height };

    return getOffsetFromBox(node.rect, viewportRect, page.direction);
  }

  if (node.parentIndex < 0) {
    return getOffsetFromBox(node.rect, { x: 0, y: 0, width, height }, page.direction);
  }

  const parent = page.nodes[node.parentIndex];

  return getOffsetFromBox(node.rect, getContentBox(parent), parent.direction);
}

function isAfterInline(rect: Rect, previousRect: Rect, direction: 'ltr' | 'rtl'): boolean {
  if (direction === 'rtl') {
    return getRight(rect) <= previousRect.x + 0.5;
  }

  return rect.x >= getRight(previousRect) - 0.5;
}

export function getInlineGap(rect: Rect, previousRect: Rect, direction: 'ltr' | 'rtl'): number {
  if (direction === 'rtl') {
    return previousRect.x - getRight(rect);
  }

  return rect.x - getRight(previousRect);
}

/** Splits items into rows. Returns null when the items are neither stacked nor laid out along the inline direction. */
function splitIntoRows(itemRects: Rect[], direction: 'ltr' | 'rtl'): Rect[][] | null {
  const itemRows: Rect[][] = [[itemRects[0]]];
  let rowBottom = getBottom(itemRects[0]);

  for (const rect of itemRects.slice(1)) {
    const currentRow = itemRows[itemRows.length - 1];

    if (rect.y >= rowBottom - 0.5) {
      itemRows.push([rect]);
      rowBottom = getBottom(rect);
      continue;
    }

    if (!isAfterInline(rect, currentRow[currentRow.length - 1], direction)) {
      return null;
    }

    currentRow.push(rect);
    rowBottom = Math.max(rowBottom, getBottom(rect));
  }

  return itemRows;
}

function getInlineGaps(itemRows: Rect[][], direction: 'ltr' | 'rtl'): number[] {
  return itemRows.flatMap((row) => row.slice(1).map((rect, position) => getInlineGap(rect, row[position], direction)));
}

function getRowGaps(itemRows: Rect[][]): number[] {
  const rowUnions = itemRows.map(getUnion);

  return rowUnions.slice(1).map((rowUnion, position) => rowUnion.y - getBottom(rowUnions[position]));
}

/** Gaps between flow items. null when every gap is zero and there is no free space. */
function getGaps(itemRects: Rect[], contentBox: Rect, direction: 'ltr' | 'rtl'): Gaps | null {
  const allGaps = getAllGaps(itemRects, contentBox, direction);
  if (!allGaps) {
    return null;
  }

  const isZero = (gap: number) => Math.abs(gap) < 0.5;
  const hasOnlyZeroGaps = allGaps.gaps.every(isZero) && allGaps.columnGaps.every(isZero);
  const hasFreeSpace = allGaps.freeStart >= 1 || allGaps.freeEnd >= 1;

  return hasOnlyZeroGaps && !hasFreeSpace ? null : allGaps;
}

function getAllGaps(itemRects: Rect[], contentBox: Rect, direction: 'ltr' | 'rtl'): Gaps | null {
  if (itemRects.length < 2) {
    return null;
  }

  const itemRows = splitIntoRows(itemRects, direction);
  if (!itemRows) {
    return null;
  }

  const itemUnion = getUnion(itemRects);
  const blockFreeStart = Math.max(0, itemUnion.y - contentBox.y);
  const blockFreeEnd = Math.max(0, getBottom(contentBox) - getBottom(itemUnion));

  if (itemRows.every((row) => row.length === 1)) {
    return { arrangement: 'stacked', gaps: getRowGaps(itemRows), columnGaps: [], freeStart: blockFreeStart, freeEnd: blockFreeEnd };
  }

  if (itemRows.length === 1) {
    const leftFree = Math.max(0, itemUnion.x - contentBox.x);
    const rightFree = Math.max(0, getRight(contentBox) - getRight(itemUnion));
    const isRightToLeft = direction === 'rtl';

    return {
      arrangement: 'across',
      gaps: getInlineGaps(itemRows, direction),
      columnGaps: [],
      freeStart: isRightToLeft ? rightFree : leftFree,
      freeEnd: isRightToLeft ? leftFree : rightFree,
    };
  }

  return {
    arrangement: 'grid',
    gaps: getRowGaps(itemRows),
    columnGaps: getInlineGaps(itemRows, direction),
    freeStart: blockFreeStart,
    freeEnd: blockFreeEnd,
  };
}

/** Own text with only inline-level children in flow is a run of text lines, not a row of items. */
function isTextFlow(page: PageMeasurement, node: MeasuredNode, childIndexes: number[]): boolean {
  const hasOnlyInlineFlowChildren = childIndexes.every((childIndex) => {
    const child = page.nodes[childIndex];

    return child.visibility !== 'shown' || !child.isInFlow || child.isInline;
  });

  return node.textRuns.length > 0 && hasOnlyInlineFlowChildren;
}

export function getNodeLayouts(page: PageMeasurement): NodeLayout[] {
  const childIndexesByParent = getChildIndexesByParent(page);

  return page.nodes.map((node) => {
    const childIndexes = childIndexesByParent[node.index];
    const position = getPosition(page, node);
    const itemRects = getFlowItemRects(page, node, childIndexes);
    const gaps = isTextFlow(page, node, childIndexes) ? null : getGaps(itemRects, getContentBox(node), node.direction);

    return {
      index: node.index,
      x: position.x,
      y: position.y,
      gaps,
    };
  });
}
