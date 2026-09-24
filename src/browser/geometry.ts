import type { Ink, Rect, Sides } from '../types.ts';

export type ColorBytes = [red: number, green: number, blue: number, alpha: number];

export type ClipKind = 'none' | 'clip' | 'scroll';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ClipEntry extends Box {
  xKind: ClipKind;
  yKind: ClipKind;
  clipperIndex: number;
  isViewport: boolean;
}

const replacedTags = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'math']);

const controlTags =new Set(['input', 'select', 'textarea', 'button', 'progress', 'meter']);

export function roundToHundredth(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createBox(domRect: DOMRect, scrollX: number, scrollY: number): Box {
  return {
    left: domRect.left + scrollX,
    top: domRect.top + scrollY,
    right: domRect.right + scrollX,
    bottom: domRect.bottom + scrollY,
  };
}

export function createRect(box: Box): Rect {
  return {
    x: roundToHundredth(box.left),
    y: roundToHundredth(box.top),
    width: roundToHundredth(box.right - box.left),
    height: roundToHundredth(box.bottom - box.top),
  };
}

export function getBoxUnion(boxes: Box[]): Box | null {
  if (boxes.length === 0) {
    return null;
  }

  const union = { ...boxes[0] };

  for (const box of boxes) {
    union.left = Math.min(union.left, box.left);
    union.top = Math.min(union.top, box.top);
    union.right = Math.max(union.right, box.right);
    union.bottom = Math.max(union.bottom, box.bottom);
  }

  return union;
}

export function doBoxesIntersect(first: Box, second: Box): boolean {
  return first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
}

export function isPointInBox(box: Box, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

export function getSides(style: CSSStyleDeclaration, kind: 'padding' | 'border' | 'margin'): Sides {
  if (kind === 'margin') {
    return [
      parseFloat(style.marginTop) || 0,
      parseFloat(style.marginRight) || 0,
      parseFloat(style.marginBottom) || 0,
      parseFloat(style.marginLeft) || 0,
    ];
  }

  if (kind === 'padding') {
    return [
      parseFloat(style.paddingTop) || 0,
      parseFloat(style.paddingRight) || 0,
      parseFloat(style.paddingBottom) || 0,
      parseFloat(style.paddingLeft) || 0,
    ];
  }

  return [
    parseFloat(style.borderTopWidth) || 0,
    parseFloat(style.borderRightWidth) || 0,
    parseFloat(style.borderBottomWidth) || 0,
    parseFloat(style.borderLeftWidth) || 0,
  ];
}

export function getInsetBox(box: Box, sides: Sides): Box {
  return {
    left: box.left + sides[3],
    top: box.top + sides[0],
    right: box.right - sides[1],
    bottom: box.bottom - sides[2],
  };
}

// ---------- transforms ----------

interface OwnTransform {
  rotateDegrees: number;
  scale: number;
  translateX: number;
  translateY: number;
}

/** Parses the computed `translate` property. A percentage is of the layout size on that axis. */
function getTranslateProperty(translate: string, layoutWidth: number, layoutHeight: number): { x: number; y: number } {
  if (translate === 'none') {
    return { x: 0, y: 0 };
  }

  const [xPart, yPart = '0px'] = translate.split(' ');
  const getLength = (part: string, size: number) => (part.endsWith('%') ? (parseFloat(part) / 100) * size : parseFloat(part) || 0);

  return { x: getLength(xPart, layoutWidth), y: getLength(yPart, layoutHeight) };
}

export function getOwnTransform(style: CSSStyleDeclaration, layoutWidth: number, layoutHeight: number): OwnTransform {
  let matrix = new DOMMatrixReadOnly();

  if (style.rotate !== 'none') {
    const rotateParts = style.rotate.split(' ');
    const angleDegrees = getAngleDegrees(rotateParts[rotateParts.length - 1]);

    if (rotateParts.length === 4) {
      const [axisX, axisY, axisZ] = rotateParts.map(Number);
      matrix = matrix.rotateAxisAngle(axisX, axisY, axisZ, angleDegrees);
    } else {
      matrix = matrix.rotate(angleDegrees);
    }
  }

  if (style.scale !== 'none') {
    const scaleParts = style.scale.split(' ').map(Number);
    const scaleX = scaleParts[0];
    const scaleY = scaleParts[1] ?? scaleX;
    const scaleZ = scaleParts[2] ?? 1;
    matrix = matrix.scale(scaleX, scaleY, scaleZ);
  }

  if (style.transform !== 'none') {
    matrix = matrix.multiply(new DOMMatrixReadOnly(style.transform));
  }

  const rotateDegrees = (Math.atan2(matrix.m12, matrix.m11) * 180) / Math.PI;
  const scale = Math.hypot(matrix.m11, matrix.m12);
  const translateProperty = getTranslateProperty(style.translate, layoutWidth, layoutHeight);

  return {
    rotateDegrees: Math.abs(rotateDegrees) >= 0.5 ? roundToHundredth(rotateDegrees) : 0,
    scale: Math.abs(scale - 1) >= 0.01 ? roundToHundredth(scale) : 1,
    translateX: roundToHundredth(translateProperty.x + matrix.m41),
    translateY: roundToHundredth(translateProperty.y + matrix.m42),
  };
}

function getAngleDegrees(angle: string): number {
  const value = parseFloat(angle);

  if (angle.endsWith('grad')) {
    return (value * 360) / 400;
  }

  if (angle.endsWith('rad')) {
    return (value * 180) / Math.PI;
  }

  if (angle.endsWith('turn')) {
    return value * 360;
  }

  return value;
}

// ---------- containing blocks and clips ----------

export function isContainingBlockForFixed(style: CSSStyleDeclaration): boolean {
  const contain = style.contain;
  const willChange = style.willChange;

  return (
    style.transform !== 'none' ||
    style.translate !== 'none' ||
    style.rotate !== 'none' ||
    style.scale !== 'none' ||
    style.perspective !== 'none' ||
    style.filter !== 'none' ||
    style.backdropFilter !== 'none' ||
    /paint|layout|strict|content/.test(contain) ||
    style.containerType !== 'normal' ||
    /transform|translate|rotate|scale|perspective|filter|contain/.test(willChange)
  );
}

export function isContainingBlockForAbsolute(style: CSSStyleDeclaration): boolean {
  return style.position !== 'static' || /position/.test(style.willChange) || isContainingBlockForFixed(style);
}

export function getOverflowKind(overflow: string): ClipKind {
  if (overflow === 'auto' || overflow === 'scroll') {
    return 'scroll';
  }

  if (overflow === 'hidden' || overflow === 'clip') {
    return 'clip';
  }

  return 'none';
}

/** What a node clips for its children, before the viewport rules. */
export function createChildClipEntry(
  style: CSSStyleDeclaration,
  borderBox: Box,
  border: Sides,
  nodeIndex: number,
  shouldIgnoreOverflow: boolean,
): ClipEntry | null {
  const paddingBox = getInsetBox(borderBox, border);
  const entry: ClipEntry = {
    left: -Infinity,
    top: -Infinity,
    right: Infinity,
    bottom: Infinity,
    xKind: 'none',
    yKind: 'none',
    clipperIndex: nodeIndex,
    isViewport: false,
  };

  if (!shouldIgnoreOverflow) {
    const overflowXKind = getOverflowKind(style.overflowX);
    const overflowYKind = getOverflowKind(style.overflowY);

    if (overflowXKind !== 'none') {
      entry.left = paddingBox.left;
      entry.right = paddingBox.right;
      entry.xKind = overflowXKind;
    }

    if (overflowYKind !== 'none') {
      entry.top = paddingBox.top;
      entry.bottom = paddingBox.bottom;
      entry.yKind = overflowYKind;
    }
  }

  if (/paint|strict|content/.test(style.contain)) {
    clipEntryToBox(entry, paddingBox);
  }

  if (style.clipPath !== 'none') {
    clipEntryToBox(entry, borderBox);
  }

  const clipRectBox = getClipPropertyBox(style, borderBox);
  if (clipRectBox) {
    clipEntryToBox(entry, clipRectBox);
  }

  const isClipping = entry.xKind !== 'none' || entry.yKind !== 'none';

  return isClipping ? entry : null;
}

function clipEntryToBox(entry: ClipEntry, box: Box): void {
  entry.left = Math.max(entry.left, box.left);
  entry.top = Math.max(entry.top, box.top);
  entry.right = Math.min(entry.right, box.right);
  entry.bottom = Math.min(entry.bottom, box.bottom);

  if (entry.xKind === 'none') {
    entry.xKind = 'clip';
  }

  if (entry.yKind === 'none') {
    entry.yKind = 'clip';
  }
}

function getClipPropertyBox(style: CSSStyleDeclaration, borderBox: Box): Box | null {
  const isAbsolute = style.position === 'absolute' || style.position === 'fixed';
  if (!isAbsolute || !style.clip.startsWith('rect(')) {
    return null;
  }

  const clipParts = style.clip.slice(5, -1).split(/,\s*|\s+/);
  const [top, right, bottom, left] = clipParts.map((part) => (part === 'auto' ? null : parseFloat(part)));

  return {
    left: left === null ? borderBox.left : borderBox.left + left,
    top: top === null ? borderBox.top : borderBox.top + top,
    right: right === null ? borderBox.right : borderBox.left + right,
    bottom: bottom === null ? borderBox.bottom : borderBox.top + bottom,
  };
}

export function isZeroClipRect(style: CSSStyleDeclaration): boolean {
  return style.clip === 'rect(0px, 0px, 0px, 0px)';
}

/** True when an inset() clip-path removes the whole width or height. */
export function isFullInsetClipPath(clipPath: string): boolean {
  if (!clipPath.startsWith('inset(')) {
    return false;
  }

  const insetValues = clipPath.slice(6, -1).split(' round ')[0].trim().split(/\s+/);
  if (!insetValues.every((value) => value.endsWith('%'))) {
    return false;
  }

  const [top, right = top, bottom = top, left = right] = insetValues.map(parseFloat);

  return top + bottom >= 100 || left + right >= 100;
}

/**
 * The entries without the axes that a scroll container further in scrolls. Scrolling brings content into that
 * scroller's box, so a clipper outside it does not decide what the content can reach on that axis.
 */
export function getReachableClipEntries(entries: ClipEntry[]): ClipEntry[] {
  const innermostScrollerPositionX = entries.findLastIndex((entry) => entry.xKind === 'scroll');
  const innermostScrollerPositionY = entries.findLastIndex((entry) => entry.yKind === 'scroll');

  return entries.map((entry, position) => {
    const isOutsideScrollerX = position < innermostScrollerPositionX;
    const isOutsideScrollerY = position < innermostScrollerPositionY;
    if (!isOutsideScrollerX && !isOutsideScrollerY) {
      return entry;
    }

    return {
      ...entry,
      left: isOutsideScrollerX ? -Infinity : entry.left,
      right: isOutsideScrollerX ? Infinity : entry.right,
      top: isOutsideScrollerY ? -Infinity : entry.top,
      bottom: isOutsideScrollerY ? Infinity : entry.bottom,
      xKind: isOutsideScrollerX ? 'none' : entry.xKind,
      yKind: isOutsideScrollerY ? 'none' : entry.yKind,
    };
  });
}

export function getEntriesIntersection(entries: ClipEntry[], shouldIncludeScroll: boolean): Box {
  const intersection = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };

  for (const entry of entries) {
    const isXIncluded = entry.xKind === 'clip' || (shouldIncludeScroll && entry.xKind === 'scroll');
    const isYIncluded = entry.yKind === 'clip' || (shouldIncludeScroll && entry.yKind === 'scroll');

    if (isXIncluded) {
      intersection.left = Math.max(intersection.left, entry.left);
      intersection.right = Math.min(intersection.right, entry.right);
    }

    if (isYIncluded) {
      intersection.top = Math.max(intersection.top, entry.top);
      intersection.bottom = Math.min(intersection.bottom, entry.bottom);
    }
  }

  return intersection;
}

// ---------- colors ----------

const colorBytesByString = new Map<string, ColorBytes>();

let colorContext: OffscreenCanvasRenderingContext2D | null = null;

function getColorContext(): OffscreenCanvasRenderingContext2D {
  if (!colorContext) {
    colorContext = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!;
  }

  return colorContext;
}

export function getColorBytes(color: string): ColorBytes {
  const cachedBytes = colorBytesByString.get(color);
  if (cachedBytes) {
    return cachedBytes;
  }

  const context = getColorContext();
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = '#000000';
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);

  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  const bytes: ColorBytes = [red, green, blue, alpha];
  colorBytesByString.set(color, bytes);

  return bytes;
}

export function formatHex(bytes: ColorBytes): string {
  const channels = bytes[3] === 255 ? bytes.slice(0, 3) : bytes;

  return '#' + channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('');
}

/** Front-to-back compositing of layers that are handed in from the top down. */
export interface ColorAccumulator {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export function createColorAccumulator(): ColorAccumulator {
  return { red: 0, green: 0, blue: 0, alpha: 0 };
}

export function addLayerBelow(accumulator: ColorAccumulator, bytes: ColorBytes, opacity: number): void {
  const layerAlpha = (bytes[3] / 255) * opacity;
  const visibleShare = (1 - accumulator.alpha) * layerAlpha;

  accumulator.red += visibleShare * bytes[0];
  accumulator.green += visibleShare * bytes[1];
  accumulator.blue += visibleShare * bytes[2];
  accumulator.alpha += visibleShare;
}

export function isAccumulatorOpaque(accumulator: ColorAccumulator): boolean {
  return accumulator.alpha >= 0.999;
}

export function finishOverBase(accumulator: ColorAccumulator, baseBytes: ColorBytes): ColorBytes {
  const remainingShare = 1 - accumulator.alpha;

  return [
    Math.round(accumulator.red + remainingShare * baseBytes[0]),
    Math.round(accumulator.green + remainingShare * baseBytes[1]),
    Math.round(accumulator.blue + remainingShare * baseBytes[2]),
    255,
  ];
}

export function blendColorOver(foreground: ColorBytes, opacity: number, background: ColorBytes): ColorBytes {
  const accumulator = createColorAccumulator();
  addLayerBelow(accumulator, foreground, opacity);

  return finishOverBase(accumulator, background);
}

// ---------- ink ----------

interface InkDetails {
  ink: Ink;
  backgroundBytes: ColorBytes | null;
  paintsBox: boolean;
}

const borderSideNames = ['top', 'right', 'bottom', 'left'] as const;

export function getInkDetails(
  element: Element,
  style: CSSStyleDeclaration,
  tag: string,
  border: Sides,
  hasText: boolean,
  cumulativeOpacity: number,
): InkDetails {
  const backgroundBytes = getColorBytes(style.backgroundColor);
  const hasBackgroundColor = backgroundBytes[3] > 0;
  const borderSides: Ink['borderSides'] = [];
  let borderColor: string | null = null;

  const borderStyles = [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle];
  const borderColors = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];

  for (let sideIndex = 0; sideIndex < 4; sideIndex++) {
    const isStylePainted = borderStyles[sideIndex] !== 'none' && borderStyles[sideIndex] !== 'hidden';
    if (border[sideIndex] <= 0 || !isStylePainted) continue;

    const sideColorBytes = getColorBytes(borderColors[sideIndex]);
    if (sideColorBytes[3] === 0) continue;

    borderSides.push(borderSideNames[sideIndex]);
    borderColor ??= formatHex(sideColorBytes);
  }

  const replaced = replacedTags.has(tag) ? (tag as Ink['replaced']) : null;
  const hasBackgroundImage = style.backgroundImage !== 'none';
  const pseudoInk = getPseudoInk(element);
  const isControl = isControlElement(element, tag);

  const ink: Ink = {
    background: hasBackgroundColor ? formatHex(backgroundBytes) : null,
    hasBackgroundImage,
    borderSides,
    borderColor,
    hasShadow: style.boxShadow !== 'none',
    hasOutline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
    replaced,
    pseudoInk,
    hasText,
    opacity: roundToHundredth(cumulativeOpacity),
  };

  return {
    ink,
    backgroundBytes: hasBackgroundColor ? backgroundBytes : null,
    paintsBox: hasBackgroundColor || hasBackgroundImage || replaced !== null || isControl || pseudoInk !== null,
  };
}

function getPseudoInk(element: Element): Ink['pseudoInk'] {
  const hasBeforeInk = hasPseudoElementInk(element, '::before');
  const hasAfterInk = hasPseudoElementInk(element, '::after');
  if (hasBeforeInk && hasAfterInk) {
    return 'both';
  }

  if (hasBeforeInk) {
    return 'before';
  }

  return hasAfterInk ? 'after' : null;
}

function hasPseudoElementInk(element: Element, pseudo: '::before' | '::after'): boolean {
  const pseudoStyle = getComputedStyle(element, pseudo);
  const content = pseudoStyle.content;
  if (content === 'none' || content === 'normal' || pseudoStyle.display === 'none') {
    return false;
  }

  if (content !== '""') {
    return true;
  }

  const hasBackground = getColorBytes(pseudoStyle.backgroundColor)[3] > 0 || pseudoStyle.backgroundImage !== 'none';
  const hasBorder = getSides(pseudoStyle, 'border').some((width) => width > 0);

  return hasBackground || hasBorder;
}

export function isControlElement(element: Element, tag: string): boolean {
  const isHiddenInput = tag === 'input' && (element as HTMLInputElement).type === 'hidden';

  return controlTags.has(tag) && !isHiddenInput;
}

// ---------- text metrics ----------

interface FontMetrics {
  fontAscent: number;
  fontDescent: number;
  capHeight: number;
}

const fontMetricsByFont = new Map<string, FontMetrics>();

let textContext: OffscreenCanvasRenderingContext2D | null = null;

export function getFontMetrics(style: CSSStyleDeclaration): FontMetrics {
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const cachedMetrics = fontMetricsByFont.get(font);
  if (cachedMetrics) {
    return cachedMetrics;
  }

  if (!textContext) {
    textContext = new OffscreenCanvas(1, 1).getContext('2d')!;
  }

  textContext.font = font;

  const letterMetrics = textContext.measureText('H');
  const fontMetrics = {
    fontAscent: letterMetrics.fontBoundingBoxAscent,
    fontDescent: letterMetrics.fontBoundingBoxDescent,
    capHeight: letterMetrics.actualBoundingBoxAscent,
  };
  fontMetricsByFont.set(font, fontMetrics);

  return fontMetrics;
}

// ---------- sticky ----------

/** Returns, per element, whether it sits away from its flow position right now. */
export function getStuckStates(elements: Element[]): boolean[] {
  const stuckBoxes = elements.map((element) => element.getBoundingClientRect());
  const savedStyleAttributes = elements.map((element) => element.getAttribute('style'));

  elements.forEach((element, elementIndex) => {
    const savedStyle = savedStyleAttributes[elementIndex];
    element.setAttribute('style', `${savedStyle ?? ''}; position: static !important`);
  });

  const flowBoxes = elements.map((element) => element.getBoundingClientRect());

  elements.forEach((element, elementIndex) => {
    const savedStyle = savedStyleAttributes[elementIndex];

    if (savedStyle === null) {
      element.removeAttribute('style');
    } else {
      element.setAttribute('style', savedStyle);
    }
  });

  return elements.map((_element, elementIndex) => {
    const topDifference = Math.abs(stuckBoxes[elementIndex].top - flowBoxes[elementIndex].top);
    const leftDifference = Math.abs(stuckBoxes[elementIndex].left - flowBoxes[elementIndex].left);

    return topDifference >= 0.5 || leftDifference >= 0.5;
  });
}
