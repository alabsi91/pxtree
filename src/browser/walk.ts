import type { ElementMatch, MeasuredNode, ScrollAxis, TextInfo, Visibility } from '../types.ts';
import {
  type Box,
  type ClipEntry,
  type ClipKind,
  type ColorBytes,
  createBox,
  createChildClipEntry,
  createRect,
  getBoxUnion,
  getEntriesIntersection,
  getReachableClipEntries,
  getColorBytes,
  getFontMetrics,
  getInkDetails,
  getInsetBox,
  getOverflowKind,
  getOwnTransform,
  getSides,
  isContainingBlockForAbsolute,
  isContainingBlockForFixed,
  isControlElement,
  isFullInsetClipPath,
  isZeroClipRect,
  roundToHundredth,
} from './geometry.ts';

/** Closed shadow roots that attachShadow created. The hook in index.ts fills it. */
export const closedShadowRoots = new WeakMap<Element, ShadowRoot>();

const leafTags = new Set([
  'svg',
  'math',
  'img',
  'video',
  'canvas',
  'iframe',
  'frame',
  'object',
  'embed',
  'select',
  'textarea',
  'input',
]);

const frameTags = new Set(['iframe', 'frame', 'object', 'embed']);

const interactiveRoles = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem']);

const inputTypesShowingValue = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'submit', 'button', 'reset']);

const topLayerSelector = ':modal, :popover-open, :fullscreen';

export interface PageContext {
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  viewportBox: Box;
  direction: 'ltr' | 'rtl';
  rootOverflowSource: Element;
  viewportOverflowXKind: ClipKind;
  isScrollLocked: boolean;
}

export interface WalkedNode {
  record: MeasuredNode;
  element: Element;
  style: CSSStyleDeclaration;
  box: Box;
  clipEntries: ClipEntry[];
  childClipEntries: ClipEntry[];
  textBoxes: Box[];
  backgroundBytes: ColorBytes | null;
  paintsBox: boolean;
  cumulativeOpacity: number;
  classNames: string[];
  hasOwnText: boolean;
  absoluteContainerIndexForChildren: number;
  fixedContainerIndexForChildren: number;
}

export interface WalkResult {
  context: PageContext;
  walkedNodes: WalkedNode[];
  nodeIndexByElement: Map<Element, number>;
  shadowRootByHost: Map<Element, ShadowRoot>;
  allShadowRoots: ShadowRoot[];
  topLayerIndexes: number[];
  modalIndex: number | null;
  isNodeCapReached: boolean;
  element: ElementMatch | null;
}

type FlatEntry =
  | { kind: 'text'; node: Text }
  | { kind: 'element'; element: Element; style: CSSStyleDeclaration; isSlotted: boolean };

interface Inheritance {
  parent: WalkedNode | null;
  depth: number;
  isSlotted: boolean;
  isTopLayerRoot: boolean;
}

interface WalkState {
  context: PageContext;
  walkedNodes: WalkedNode[];
  maxNodes: number;
  isNodeCapReached: boolean;
  topLayerElements: Set<Element>;
  animatingElements: Set<Element>;
  shadowRootByHost: Map<Element, ShadowRoot>;
  range: Range;
}

// ---------- flat tree ----------

export function getShadowRoot(element: Element): ShadowRoot | null {
  return element.shadowRoot ?? closedShadowRoots.get(element) ?? null;
}

/** Every open and captured closed shadow root in the document, nested ones included. */
export function getAllShadowRoots(): ShadowRoot[] {
  const shadowRoots: ShadowRoot[] = [];
  const pendingScopes: Array<Document | ShadowRoot> = [document];

  while (pendingScopes.length > 0) {
    const scope = pendingScopes.pop()!;

    for (const element of scope.querySelectorAll('*')) {
      const shadowRoot = getShadowRoot(element);
      if (!shadowRoot) continue;

      shadowRoots.push(shadowRoot);
      pendingScopes.push(shadowRoot);
    }
  }

  return shadowRoots;
}

export function getAllAnimations(shadowRoots: ShadowRoot[]): Animation[] {
  const animations = new Set(document.getAnimations());

  for (const shadowRoot of shadowRoots) {
    for (const animation of shadowRoot.getAnimations()) {
      animations.add(animation);
    }
  }

  return [...animations];
}

/** Elements that a running, settling-paused infinite, or scroll-driven animation targets. Pseudo-element animations do not count. */
function getAnimatingElements(shadowRoots: ShadowRoot[]): Set<Element> {
  const animatingElements = new Set<Element>();

  for (const animation of getAllAnimations(shadowRoots)) {
    const effect = animation.effect instanceof KeyframeEffect ? animation.effect : null;
    if (!effect?.target || effect.pseudoElement) continue;

    const isScrollDriven = animation.timeline !== null && !(animation.timeline instanceof DocumentTimeline);
    const isPausedInfinite = animation.playState === 'paused' && effect.getComputedTiming().endTime === Infinity;
    if (animation.playState === 'running' || isPausedInfinite || isScrollDriven) {
      animatingElements.add(effect.target);
    }
  }

  return animatingElements;
}

function getMotionRole(element: Element): MeasuredNode['motionRole'] {
  const roleWords = `${element.getAttribute('role') ?? ''} ${element.getAttribute('aria-roledescription') ?? ''}`.toLowerCase();
  if (/\bmarquee\b/.test(roleWords)) {
    return 'marquee';
  }

  return /\bcarousel\b/.test(roleWords) ? 'carousel' : null;
}

function getFlatChildNodes(element: Element): { childNodes: ArrayLike<Node>; isAssigned: boolean } {
  const shadowRoot = getShadowRoot(element);
  if (shadowRoot) {
    return { childNodes: shadowRoot.childNodes, isAssigned: false };
  }

  const assignedNodes = element instanceof HTMLSlotElement ? element.assignedNodes() : [];

  return assignedNodes.length > 0
    ? { childNodes: assignedNodes, isAssigned: true }
    : { childNodes: element.childNodes, isAssigned: false };
}

function collectFlatEntries(element: Element, isSlotted: boolean, flatEntries: FlatEntry[]): void {
  const { childNodes, isAssigned } = getFlatChildNodes(element);
  const isChildSlotted = isSlotted || isAssigned;

  for (let childPosition = 0; childPosition < childNodes.length; childPosition++) {
    const child = childNodes[childPosition];

    if (child.nodeType === Node.TEXT_NODE) {
      if (/\S/.test((child as Text).data)) {
        flatEntries.push({ kind: 'text', node: child as Text });
      }

      continue;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const childElement = child as Element;
    const childTag = childElement.localName;
    if (childTag === 'br' || childTag === 'wbr') continue;

    const childStyle = getComputedStyle(childElement);

    if (childStyle.display === 'contents') {
      collectFlatEntries(childElement, isChildSlotted, flatEntries);
      continue;
    }

    flatEntries.push({ kind: 'element', element: childElement, style: childStyle, isSlotted: isChildSlotted });
  }
}

/** Returns the walked ancestor of an element that is not a node itself, or -1. */
export function getNearestNodeIndex(element: Element, nodeIndexByElement: Map<Element, number>): number {
  const climbedElements: Element[] = [];
  let current: Element | null = element;
  let nodeIndex = -1;

  while (current) {
    const knownIndex = nodeIndexByElement.get(current);

    if (knownIndex !== undefined) {
      nodeIndex = knownIndex;
      break;
    }

    climbedElements.push(current);
    current = getFlatParent(current);
  }

  for (const climbedElement of climbedElements) {
    nodeIndexByElement.set(climbedElement, nodeIndex);
  }

  return nodeIndex;
}

function getFlatParent(element: Element): Element | null {
  const parentNode = element.parentNode;
  const shadowHost = parentNode instanceof ShadowRoot ? parentNode.host : null;

  return element.assignedSlot ?? element.parentElement ?? shadowHost;
}

// ---------- page context ----------

export function createPageContext(): PageContext {
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  const isRootOverflowVisible = rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible';
  const rootOverflowSource = isRootOverflowVisible && document.body ? document.body : root;
  const sourceStyle = rootOverflowSource === root ? rootStyle : getComputedStyle(rootOverflowSource);
  const viewportOverflowYKind = getOverflowKind(sourceStyle.overflowY);
  const viewportWidth = root.clientWidth;
  const viewportHeight = window.innerHeight;

  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    viewportWidth,
    viewportHeight,
    viewportBox: {
      left: window.scrollX,
      top: window.scrollY,
      right: window.scrollX + viewportWidth,
      bottom: window.scrollY + viewportHeight,
    },
    direction: rootStyle.direction === 'rtl' ? 'rtl' : 'ltr',
    rootOverflowSource,
    viewportOverflowXKind: getOverflowKind(sourceStyle.overflowX),
    isScrollLocked: viewportOverflowYKind === 'clip',
  };
}

function createViewportEntry(context: PageContext, shouldClipY: boolean): ClipEntry {
  return {
    left: context.viewportBox.left,
    right: context.viewportBox.right,
    top: shouldClipY ? context.viewportBox.top : -Infinity,
    bottom: shouldClipY ? context.viewportBox.bottom : Infinity,
    xKind: 'clip',
    yKind: shouldClipY ? 'clip' : 'none',
    clipperIndex: 0,
    isViewport: true,
  };
}

// ---------- visibility ----------

/** The only place that decides visibility. Call it only for elements whose checkVisibility() is true. */
function getVisibility(
  element: Element,
  style: CSSStyleDeclaration,
  box: Box,
  clipEntries: ClipEntry[],
  firstChildElement: Element | null,
  context: PageContext,
): { visibility: Visibility; clippedOutByIndex: number | null } {
  if (parseFloat(style.opacity) === 0) {
    return { visibility: 'unpainted-opacity', clippedOutByIndex: null };
  }

  const isContentHidden = style.contentVisibility === 'hidden';
  const isContentAutoSkipped =
    style.contentVisibility === 'auto' &&
    firstChildElement !== null &&
    !firstChildElement.checkVisibility({ contentVisibilityAuto: true });
  if (isContentHidden || isContentAutoSkipped) {
    return { visibility: 'content-skipped', clippedOutByIndex: null };
  }

  if (isScreenReaderOnly(element, style, box)) {
    return { visibility: 'sr-only', clippedOutByIndex: null };
  }

  if (style.visibility === 'hidden' || style.visibility === 'collapse') {
    return { visibility: 'unpainted-visibility', clippedOutByIndex: null };
  }

  const reachableEntries = getReachableClipEntries(clipEntries);
  const ownEntries = reachableEntries.filter((entry) => !entry.isViewport);
  if (!doesBoxReachInto(box, getEntriesIntersection(ownEntries, false))) {
    return { visibility: 'clipped-out', clippedOutByIndex: getClippingEntry(box, ownEntries).clipperIndex };
  }

  if (!doesBoxReachInto(box, getEntriesIntersection(reachableEntries, false))) {
    return { visibility: 'offscreen', clippedOutByIndex: null };
  }

  const isInsideScrollerX = clipEntries.some((entry) => entry.xKind === 'scroll');
  const isInsideScrollerY = clipEntries.some((entry) => entry.yKind === 'scroll');
  const isBeforeDocumentStart = !isInsideScrollerY && box.bottom <= 0 && box.top < 0;
  const isBeforeInlineStart =
    !isInsideScrollerX &&
    (context.direction === 'rtl'
      ? box.left >= context.viewportWidth && box.right > context.viewportWidth
      : box.right <= 0 && box.left < 0);
  if (isBeforeDocumentStart || isBeforeInlineStart) {
    return { visibility: 'offscreen', clippedOutByIndex: null };
  }

  return { visibility: 'shown', clippedOutByIndex: null };
}

function isScreenReaderOnly(element: Element, style: CSSStyleDeclaration, box: Box): boolean {
  const isTinyBox = box.right - box.left <= 1 && box.bottom - box.top <= 1;
  const border = getSides(style, 'border');
  const contentBox = getInsetBox(getInsetBox(box, border), getSides(style, 'padding'));
  const contentWidth = contentBox.right - contentBox.left;
  const contentHeight = contentBox.bottom - contentBox.top;
  const isThinContentAxis = (size: number) => size > 0 && size <= 1;
  const isTinyContentBox =
    (contentWidth <= 1 && contentHeight <= 1) || isThinContentAxis(contentWidth) || isThinContentAxis(contentHeight);
  const hasBoxPaint =
    getColorBytes(style.backgroundColor)[3] > 0 || style.backgroundImage !== 'none' || border.some((width) => width > 0);
  const isOverflowClipped = style.overflowX !== 'visible' || style.overflowY !== 'visible';
  const isAbsolute = style.position === 'absolute' || style.position === 'fixed';

  const isTinyHiddenBox = isTinyBox && (isOverflowClipped || element.childNodes.length === 0);
  const isTinyUnpaintedContent = isTinyContentBox && isOverflowClipped && !hasBoxPaint;
  const isZeroClipped = isAbsolute && isZeroClipRect(style);

  return isTinyHiddenBox || isTinyUnpaintedContent || isZeroClipped || isFullInsetClipPath(style.clipPath);
}

/** Like an intersection test, but a zero-size box on the clip edge still counts as inside. */
function doesBoxReachInto(box: Box, clipBox: Box): boolean {
  const overlapWidth = Math.min(box.right, clipBox.right) - Math.max(box.left, clipBox.left);
  const overlapHeight = Math.min(box.bottom, clipBox.bottom) - Math.max(box.top, clipBox.top);
  const isInsideX = overlapWidth > 0 || (overlapWidth === 0 && box.right === box.left);
  const isInsideY = overlapHeight > 0 || (overlapHeight === 0 && box.bottom === box.top);

  return isInsideX && isInsideY;
}

function getClippingEntry(box: Box, entries: ClipEntry[]): ClipEntry {
  for (let entryPosition = entries.length - 1; entryPosition >= 0; entryPosition--) {
    const entry = entries[entryPosition];
    if (!doesBoxReachInto(box, getEntriesIntersection([entry], false))) {
      return entry;
    }
  }

  return entries[entries.length - 1];
}

// ---------- names ----------

const allowedNamePattern = /^[A-Za-z0-9_-]+$/;
const generatedSuffixPattern = /^(.+?)(?:__|_|-)([A-Za-z0-9]{5,10})$/;
const hashClassPattern = /^[A-Za-z]{1,8}-([A-Za-z0-9_]{5,})$/;

export function getNormalizedClassNames(element: Element): string[] {
  const normalizedClassNames: string[] = [];

  for (const className of element.classList) {
    if (!allowedNamePattern.test(className)) continue;

    const normalizedClassName = stripGeneratedSuffix(className);
    if (normalizedClassName === '' || isHashClassName(normalizedClassName)) continue;

    normalizedClassNames.push(normalizedClassName);
  }

  return normalizedClassNames;
}

function stripGeneratedSuffix(className: string): string {
  const suffixMatch = generatedSuffixPattern.exec(className);
  const isGeneratedSuffix = suffixMatch !== null && isMixedLettersAndDigits(suffixMatch[2]);

  return isGeneratedSuffix ? suffixMatch[1].replace(/[_-]+$/, '') : className;
}

function isMixedLettersAndDigits(segment: string): boolean {
  return /\d/.test(segment) && /[A-Za-z]/.test(segment);
}

function isHashClassName(className: string): boolean {
  const hashSegment = hashClassPattern.exec(className)?.[1];

  return hashSegment !== undefined && (/\d/.test(hashSegment) || /[a-z][A-Z]/.test(hashSegment));
}

export function createClassFrequency(classNameLists: string[][]): Map<string, number> {
  const classFrequency = new Map<string, number>();

  for (const classNames of classNameLists) {
    for (const className of classNames) {
      classFrequency.set(className, (classFrequency.get(className) ?? 0) + 1);
    }
  }

  return classFrequency;
}

export function createNodeName(element: Element, classNames: string[], classFrequency: Map<string, number>): string {
  let name = element.localName;
  const id = element.id;
  if (id && allowedNamePattern.test(id) && !/\d{3,}/.test(id)) {
    name += '#' + id;
  }

  const rarestClassNames = classNames
    .map((className, sourcePosition) => ({ className, sourcePosition, frequency: classFrequency.get(className) ?? 0 }))
    .sort((first, second) => first.frequency - second.frequency || first.sourcePosition - second.sourcePosition)
    .slice(0, 2)
    .sort((first, second) => first.sourcePosition - second.sourcePosition);

  for (const { className } of rarestClassNames) {
    name += '.' + (className.length > 24 ? className.slice(0, 24) + '…' : className);
  }

  return name;
}

function createTextPreview(text: string): string {
  const textWords = text.trim().split(/\s+/).filter(Boolean);
  if (textWords.length === 0) {
    return '';
  }

  let preview = textWords[0].length > 24 ? textWords[0].slice(0, 24) : textWords[0];
  let takenWordCount = 1;

  while (takenWordCount < textWords.length && takenWordCount < 4) {
    const longerPreview = preview + ' ' + textWords[takenWordCount];
    if (longerPreview.length > 24) break;

    preview = longerPreview;
    takenWordCount++;
  }

  const isCut = takenWordCount < textWords.length || preview.length < textWords[0].length;

  return isCut ? preview + '…' : preview;
}

// ---------- the walk ----------

export function walkPage(elementSelector: string | null, maxNodes: number): WalkResult {
  const context = createPageContext();
  const allShadowRoots = getAllShadowRoots();
  const topLayerElements = getTopLayerElements(allShadowRoots);

  const state: WalkState = {
    context,
    walkedNodes: [],
    maxNodes,
    isNodeCapReached: false,
    topLayerElements: new Set(topLayerElements),
    animatingElements: getAnimatingElements(allShadowRoots),
    shadowRootByHost: new Map(),
    range: document.createRange(),
  };

  walkElement(document.body, getComputedStyle(document.body), state, {
    parent: null,
    depth: 0,
    isSlotted: false,
    isTopLayerRoot: false,
  });

  const topLayerIndexes: number[] = [];

  for (const topLayerElement of topLayerElements) {
    if (state.walkedNodes.length >= maxNodes) {
      state.isNodeCapReached = true;
      break;
    }

    if (!topLayerElement.checkVisibility()) continue;

    const rootIndex = walkElement(topLayerElement, getComputedStyle(topLayerElement), state, {
      parent: null,
      depth: 0,
      isSlotted: false,
      isTopLayerRoot: true,
    });

    if (rootIndex !== -1) {
      topLayerIndexes.push(rootIndex);
    }
  }

  const walkedNodes = state.walkedNodes;
  const nodeIndexByElement = new Map<Element, number>();

  for (const walkedNode of walkedNodes) {
    nodeIndexByElement.set(walkedNode.element, walkedNode.record.index);
  }

  const modalIndex = getModalIndex(walkedNodes, topLayerIndexes);
  if (modalIndex !== null) {
    markInertOutsideModal(walkedNodes, topLayerIndexes, modalIndex);
  }

  fillCrossNodeFields(walkedNodes, nodeIndexByElement);

  return {
    context,
    walkedNodes,
    nodeIndexByElement,
    shadowRootByHost: state.shadowRootByHost,
    allShadowRoots,
    topLayerIndexes,
    modalIndex,
    isNodeCapReached: state.isNodeCapReached,
    element: elementSelector === null ? null : getElementMatch(elementSelector, allShadowRoots, nodeIndexByElement),
  };
}

export function getTopLayerElements(allShadowRoots: ShadowRoot[]): Element[] {
  const topLayerElements: Element[] = [...document.querySelectorAll(topLayerSelector)];

  for (const shadowRoot of allShadowRoots) {
    topLayerElements.push(...shadowRoot.querySelectorAll(topLayerSelector));
  }

  return topLayerElements.sort((first, second) =>
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

function getModalIndex(walkedNodes: WalkedNode[], topLayerIndexes: number[]): number | null {
  let modalIndex: number | null = null;

  for (const rootIndex of topLayerIndexes) {
    const topLayer = walkedNodes[rootIndex].record.topLayer;
    if (topLayer === 'modal' || topLayer === 'fullscreen') {
      modalIndex = rootIndex;
    }
  }

  return modalIndex;
}

function markInertOutsideModal(walkedNodes: WalkedNode[], topLayerIndexes: number[], modalIndex: number): void {
  const modalElement = walkedNodes[modalIndex].element;
  const bodySubtreeEnd = walkedNodes[0].record.subtreeEnd;
  const inertRanges: Array<[start: number, end: number]> = [[0, bodySubtreeEnd]];

  for (const rootIndex of topLayerIndexes) {
    const rootElement = walkedNodes[rootIndex].element;
    if (rootIndex !== modalIndex && !modalElement.contains(rootElement)) {
      inertRanges.push([rootIndex, walkedNodes[rootIndex].record.subtreeEnd]);
    }
  }

  for (const [start, end] of inertRanges) {
    for (let nodeIndex = start; nodeIndex <= end; nodeIndex++) {
      walkedNodes[nodeIndex].record.isInert = true;
    }
  }
}

function fillCrossNodeFields(walkedNodes: WalkedNode[], nodeIndexByElement: Map<Element, number>): void {
  const classFrequency = createClassFrequency(walkedNodes.map((walkedNode) => walkedNode.classNames));

  for (const walkedNode of walkedNodes) {
    const record = walkedNode.record;
    record.name = createNodeName(walkedNode.element, walkedNode.classNames, classFrequency);

    if (record.parentIndex !== -1) {
      record.isInlineInText = record.isInline && walkedNodes[record.parentIndex].hasOwnText;
    }

    if (walkedNode.element instanceof HTMLLabelElement && walkedNode.element.control) {
      record.labelForIndex = nodeIndexByElement.get(walkedNode.element.control) ?? null;
    }

    if (record.labelForIndex !== null) {
      walkedNodes[record.labelForIndex].record.labelIndex ??= record.index;
    }
  }
}

function getElementMatch(
  selector: string,
  allShadowRoots: ShadowRoot[],
  nodeIndexByElement: Map<Element, number>,
): ElementMatch {
  const matchedElements = new Set<Element>(document.querySelectorAll(selector));

  for (const shadowRoot of allShadowRoots) {
    for (const matchedElement of shadowRoot.querySelectorAll(selector)) {
      matchedElements.add(matchedElement);
    }
  }

  const matchedIndexes: number[] = [];

  for (const matchedElement of matchedElements) {
    const nodeIndex = nodeIndexByElement.get(matchedElement);
    if (nodeIndex !== undefined) {
      matchedIndexes.push(nodeIndex);
    }
  }

  return { selector, matchedIndexes: matchedIndexes.sort((first, second) => first - second), matchedCount: matchedElements.size };
}

function getKeptClipEntries(style: CSSStyleDeclaration, state: WalkState, inheritance: Inheritance): ClipEntry[] {
  const parent = inheritance.parent;
  const context = state.context;

  if (inheritance.isTopLayerRoot) {
    return [createViewportEntry(context, true)];
  }

  if (!parent) {
    return context.viewportOverflowXKind === 'clip' ? [createViewportEntry(context, false)] : [];
  }

  if (style.position !== 'fixed' && style.position !== 'absolute') {
    return parent.childClipEntries;
  }

  const isFixed = style.position === 'fixed';
  const containerIndex = isFixed ? parent.fixedContainerIndexForChildren : parent.absoluteContainerIndexForChildren;
  if (containerIndex !== -1) {
    return state.walkedNodes[containerIndex].childClipEntries;
  }

  return isFixed ? [createViewportEntry(context, true)] : parent.childClipEntries.filter((entry) => entry.isViewport);
}

/** Walks one element and its flat subtree. Returns its node index, or -1 when it was dropped. */
function walkElement(element: Element, style: CSSStyleDeclaration, state: WalkState, inheritance: Inheritance): number {
  const context = state.context;
  const walkedNodes = state.walkedNodes;
  const parent = inheritance.parent;
  const tag = element.localName;
  const index = walkedNodes.length;
  const box = createBox(element.getBoundingClientRect(), context.scrollX, context.scrollY);
  const position = style.position as MeasuredNode['position'];
  const clipEntries = getKeptClipEntries(style, state, inheritance);

  const isLeaf = leafTags.has(tag);
  const flatEntries: FlatEntry[] = [];

  if (!isLeaf) {
    collectFlatEntries(element, false, flatEntries);
  }

  const firstChildEntry = flatEntries.find((entry) => entry.kind === 'element');
  const firstChildElement = firstChildEntry?.kind === 'element' ? firstChildEntry.element : null;
  const { visibility, clippedOutByIndex } = getVisibility(element, style, box, clipEntries, firstChildElement, context);

  const ownOpacity = parseFloat(style.opacity);
  const cumulativeOpacity = (parent && !inheritance.isTopLayerRoot ? parent.cumulativeOpacity : 1) * ownOpacity;
  const layoutWidth = element instanceof HTMLElement ? element.offsetWidth : roundToHundredth(box.right - box.left);
  const layoutHeight = element instanceof HTMLElement ? element.offsetHeight : roundToHundredth(box.bottom - box.top);
  const ownTransform = getOwnTransform(style, layoutWidth, layoutHeight);
  const isPureTranslate =
    ownTransform.rotateDegrees === 0 &&
    ownTransform.scale === 1 &&
    (Math.abs(ownTransform.translateX) >= 0.5 || Math.abs(ownTransform.translateY) >= 0.5);
  const isParentTransformed = parent !== null && (parent.record.rotateDegrees !== 0 || parent.record.scale !== 1);
  const isInsideTransform = parent !== null && (parent.record.isInsideTransform || isParentTransformed);

  const border = getSides(style, 'border');
  const padding = getSides(style, 'padding');
  const isFixedToViewport =
    position === 'fixed' && (parent === null || parent.fixedContainerIndexForChildren === -1);

  const textBoxes: Box[] = [];
  const textRunBoxes: Array<Box | null> = [];
  let ownText = '';

  for (const entry of flatEntries) {
    if (entry.kind !== 'text') continue;

    state.range.selectNodeContents(entry.node);

    const runBoxes = [...state.range.getClientRects()]
      .filter((domRect) => domRect.width > 0 || domRect.height > 0)
      .map((domRect) => createBox(domRect, context.scrollX, context.scrollY));

    textBoxes.push(...runBoxes);
    textRunBoxes.push(getBoxUnion(runBoxes));

    if (runBoxes.length > 0) {
      ownText += ' ' + entry.node.data;
    }
  }

  const controlText = getControlText(element);

  if (controlText) {
    ownText = controlText;
    textBoxes.push(getControlTextBox(style, box, border, padding, tag));
  }

  const hasOwnText = textBoxes.length > 0;
  const inkDetails = getInkDetails(element, style, tag, border, hasOwnText, cumulativeOpacity);
  const shadowRoot = getShadowRoot(element);
  const isControl = isControlElement(element, tag);
  const display = style.display;

  const record: MeasuredNode = {
    index,
    parentIndex: parent ? parent.record.index : -1,
    depth: inheritance.depth,
    subtreeEnd: index,
    tag,
    name: tag,
    text: createTextPreview(ownText),
    visibility,
    clippedOutByIndex,
    skippedChildCount: 0,
    rect: createRect(box),
    layoutWidth,
    layoutHeight,
    rotateDegrees: ownTransform.rotateDegrees,
    scale: ownTransform.scale,
    translate: isPureTranslate ? { x: ownTransform.translateX, y: ownTransform.translateY } : null,
    isInsideTransform,
    isAnimating: state.animatingElements.has(element),
    motionRole: getMotionRole(element),
    position,
    isViewportFrame: isFixedToViewport || inheritance.isTopLayerRoot,
    isStuck: false,
    isFloat: style.float !== 'none',
    isInFlow: position !== 'absolute' && position !== 'fixed' && style.float === 'none',
    isInline: display.startsWith('inline') || display === 'ruby',
    display,
    direction: style.direction === 'rtl' ? 'rtl' : 'ltr',
    border,
    padding,
    margin: getSides(style, 'margin'),
    clip: getEffectiveClip(box, clipEntries),
    clipsChildren: { x: 'none', y: 'none' },
    scroll: null,
    ink: inkDetails.ink,
    textInfo: null,
    textRuns: [],
    image: getImageInfo(element, tag, style),
    isControl,
    isInteractive: isInteractiveElement(element, tag),
    isDisabled: element.matches(':disabled'),
    isInlineInText: false,
    isInert: (parent !== null && !inheritance.isTopLayerRoot && parent.record.isInert) || element.hasAttribute('inert'),
    isPointerEventsNone: style.pointerEvents === 'none',
    topLayer: inheritance.isTopLayerRoot ? getTopLayerKind(element) : null,
    shadow: shadowRoot ? (element.shadowRoot ? 'open' : 'closed') : null,
    isSlotted: inheritance.isSlotted,
    isFrame: frameTags.has(tag),
    labelForIndex: null,
    labelIndex: null,
    coverage: null,
  };

  const isRootOverflowSource = element === context.rootOverflowSource;
  const childClipEntry = createChildClipEntry(style, box, border, index, isRootOverflowSource);
  const childClipEntries = childClipEntry ? [...clipEntries, childClipEntry] : clipEntries;

  if (hasOwnText) {
    const ownClipBox = getEntriesIntersection(childClipEntry ? [childClipEntry] : [], false);
    record.textInfo = createTextInfo(element, style, box, border, textBoxes, tag, ownClipBox, state);
  }

  if (childClipEntry) {
    record.clipsChildren = { x: childClipEntry.xKind, y: childClipEntry.yKind };
  }

  if (parent === null && !inheritance.isTopLayerRoot && context.viewportOverflowXKind === 'clip') {
    record.clipsChildren.x = 'clip';
  }

  const walkedNode: WalkedNode = {
    record,
    element,
    style,
    box,
    clipEntries,
    childClipEntries,
    textBoxes,
    backgroundBytes: inkDetails.backgroundBytes,
    paintsBox: inkDetails.paintsBox,
    cumulativeOpacity,
    classNames: getNormalizedClassNames(element),
    hasOwnText,
    absoluteContainerIndexForChildren: isContainingBlockForAbsolute(style)
      ? index
      : (parent?.absoluteContainerIndexForChildren ?? -1),
    fixedContainerIndexForChildren: isContainingBlockForFixed(style)
      ? index
      : (parent?.fixedContainerIndexForChildren ?? -1),
  };

  if (inheritance.isTopLayerRoot) {
    walkedNode.absoluteContainerIndexForChildren = index;
  }

  walkedNodes.push(walkedNode);

  if (shadowRoot && !isLeaf) {
    state.shadowRootByHost.set(element, shadowRoot);
  }

  const canChildrenOverflowIntoView = visibility === 'clipped-out' && !childClipEntry;
  const mayHideShownChildren = visibility === 'unpainted-visibility' || canChildrenOverflowIntoView;
  const shouldWalkChildren = visibility === 'shown' || mayHideShownChildren;
  let childNodeCount = 0;
  let textRunPosition = 0;

  for (const entry of flatEntries) {
    if (entry.kind === 'text') {
      const runBox = textRunBoxes[textRunPosition++];
      if (runBox) {
        record.textRuns.push({ rect: createRect(runBox), afterChildCount: childNodeCount });
      }

      continue;
    }

    if (state.topLayerElements.has(entry.element)) continue;

    if (!shouldWalkChildren) {
      if (entry.style.display !== 'none') {
        record.skippedChildCount++;
      }

      continue;
    }

    if (!entry.element.checkVisibility()) continue;

    if (walkedNodes.length >= state.maxNodes) {
      state.isNodeCapReached = true;
      record.skippedChildCount++;
      continue;
    }

    const childIndex = walkElement(entry.element, entry.style, state, {
      parent: walkedNode,
      depth: inheritance.depth + 1,
      isSlotted: entry.isSlotted,
      isTopLayerRoot: false,
    });

    if (childIndex !== -1) {
      childNodeCount++;
    }
  }

  const hasShownChild = hasShownDescendant(walkedNodes, index);

  if (mayHideShownChildren && !hasShownChild) {
    record.skippedChildCount += childNodeCount;
    walkedNodes.length = index + 1;
  }

  record.subtreeEnd = walkedNodes.length - 1;

  const hasZeroSize = box.right - box.left === 0 || box.bottom - box.top === 0;
  const hasInk =
    hasOwnText ||
    inkDetails.paintsBox ||
    inkDetails.ink.borderSides.length > 0 ||
    inkDetails.ink.hasShadow ||
    inkDetails.ink.hasOutline;

  if (visibility === 'shown' && hasZeroSize && !hasInk && !hasShownChild && parent !== null) {
    walkedNodes.length = index;
    return -1;
  }

  record.scroll = getScrollInfo(walkedNode, walkedNodes, isRootOverflowSource);

  return index;
}

function hasShownDescendant(walkedNodes: WalkedNode[], index: number): boolean {
  for (let descendantIndex = index + 1; descendantIndex < walkedNodes.length; descendantIndex++) {
    if (walkedNodes[descendantIndex].record.visibility === 'shown') {
      return true;
    }
  }

  return false;
}

function getEffectiveClip(box: Box, clipEntries: ClipEntry[]): MeasuredNode['clip'] {
  if (clipEntries.length === 0) {
    return null;
  }

  const intersection = getEntriesIntersection(clipEntries, true);
  const reachableEntries = getReachableClipEntries(clipEntries);

  return {
    rect: createRect(getBoundedBox(intersection)),
    clipperIndexX: getAxisClipperIndex(box.left, box.right, reachableEntries, 'x'),
    clipperIndexY: getAxisClipperIndex(box.top, box.bottom, reachableEntries, 'y'),
  };
}

/**
 * The entry that cuts the most off the box on one axis, else the innermost entry on that axis. null for the viewport or no entry.
 * Of entries that cut the same amount, the innermost wins, because nothing outside it can bring back what it cuts.
 * Pass the reachable entries, so that a clipper outside a scroller on that axis never wins.
 */
function getAxisClipperIndex(boxStart: number, boxEnd: number, clipEntries: ClipEntry[], axis: 'x' | 'y'): number | null {
  const axisEntries = clipEntries.filter((entry) => (axis === 'x' ? entry.xKind : entry.yKind) !== 'none');
  let clipperEntry = axisEntries.at(-1);
  let largestCut = 0;

  for (const entry of axisEntries) {
    const entryStart = axis === 'x' ? entry.left : entry.top;
    const entryEnd = axis === 'x' ? entry.right : entry.bottom;
    const cut = Math.max(0, entryStart - boxStart) + Math.max(0, boxEnd - entryEnd);

    if (cut > 0 && cut >= largestCut - 0.5) {
      largestCut = Math.max(largestCut, cut);
      clipperEntry = entry;
    }
  }

  return clipperEntry && !clipperEntry.isViewport ? clipperEntry.clipperIndex : null;
}

/** Axes that no entry clips stay open, as far as a finite number can say. */
const unboundedExtent = 10_000_000;

function getBoundedBox(box: Box): Box {
  return {
    left: Math.max(box.left, -unboundedExtent),
    top: Math.max(box.top, -unboundedExtent),
    right: Math.min(box.right, unboundedExtent),
    bottom: Math.min(box.bottom, unboundedExtent),
  };
}

function getScrollInfo(
  walkedNode: WalkedNode,
  walkedNodes: WalkedNode[],
  isRootOverflowSource: boolean,
): MeasuredNode['scroll'] {
  if (isRootOverflowSource) {
    return null;
  }

  const record = walkedNode.record;
  const element = walkedNode.element;
  const axes: ScrollAxis[] = [];

  if (record.clipsChildren.x === 'scroll' && element.scrollWidth > element.clientWidth) {
    axes.push({
      axis: 'x',
      contentSize: element.scrollWidth,
      visibleSize: element.clientWidth,
      offset: roundToHundredth(Math.abs(element.scrollLeft)),
    });
  }

  if (record.clipsChildren.y === 'scroll' && element.scrollHeight > element.clientHeight) {
    axes.push({
      axis: 'y',
      contentSize: element.scrollHeight,
      visibleSize: element.clientHeight,
      offset: roundToHundredth(element.scrollTop),
    });
  }

  if (axes.length === 0) {
    return null;
  }

  const scrollport = getInsetBox(walkedNode.box, record.border);
  let childCount = 0;
  let childrenOutCount = 0;

  for (let childIndex = record.index + 1; childIndex <= record.subtreeEnd; childIndex++) {
    const child = walkedNodes[childIndex];
    if (child.record.parentIndex !== record.index || child.record.visibility !== 'shown') continue;

    childCount++;

    if (!doesBoxReachInto(child.box, scrollport)) {
      childrenOutCount++;
    }
  }

  return { axes, childCount, childrenOutCount };
}

function getTopLayerKind(element: Element): MeasuredNode['topLayer'] {
  if (element.matches(':fullscreen')) {
    return 'fullscreen';
  }

  return element.matches(':modal') ? 'modal' : 'popover';
}

function isInteractiveElement(element: Element, tag: string): boolean {
  const role = element.getAttribute('role');
  if (role && interactiveRoles.has(role)) {
    return true;
  }

  if (tag === 'a') {
    return element.hasAttribute('href');
  }

  if (tag === 'input') {
    return (element as HTMLInputElement).type !== 'hidden';
  }

  return tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary';
}

function getControlText(element: Element): string {
  if (element instanceof HTMLTextAreaElement) {
    return element.value || element.placeholder;
  }

  if (!(element instanceof HTMLInputElement)) {
    return '';
  }

  if (element.type === 'password') {
    return element.value ? '' : element.placeholder;
  }

  return inputTypesShowingValue.has(element.type) ? element.value || element.placeholder : '';
}

/** Inputs center one line in their content box. Textareas start at its top. */
function getControlTextBox(
  style: CSSStyleDeclaration,
  box: Box,
  border: MeasuredNode['border'],
  padding: MeasuredNode['padding'],
  tag: string,
): Box {
  const contentBox = getInsetBox(getInsetBox(box, border), padding);
  const fontMetrics = getFontMetrics(style);
  const lineHeight = fontMetrics.fontAscent + fontMetrics.fontDescent;
  const top = tag === 'textarea' ? contentBox.top : (contentBox.top + contentBox.bottom - lineHeight) / 2;

  return { left: contentBox.left, top, right: contentBox.right, bottom: top + lineHeight };
}

function createTextInfo(
  element: Element,
  style: CSSStyleDeclaration,
  box: Box,
  border: MeasuredNode['border'],
  textBoxes: Box[],
  tag: string,
  ownClipBox: Box,
  state: WalkState,
): TextInfo {
  const firstTextBox = textBoxes[0];
  const fontSize = parseFloat(style.fontSize);
  const fontWeight = parseFloat(style.fontWeight);
  const fontMetrics = getFontMetrics(style);
  const baseline = firstTextBox.top + fontMetrics.fontAscent;
  const inkBox = getBoxUnion(textBoxes)!;
  const isFormControl = tag === 'input' || tag === 'textarea';

  return {
    fontSize,
    lineHeight:
      style.lineHeight === 'normal'
        ? roundToHundredth(fontMetrics.fontAscent + fontMetrics.fontDescent)
        : parseFloat(style.lineHeight),
    fontWeight,
    lineCount: isFormControl ? 1 : getVisibleLineCount(element, state.range, ownClipBox, state.context),
    inkRect: createRect(inkBox),
    capTop: roundToHundredth(baseline - fontMetrics.capHeight),
    baseline: roundToHundredth(baseline),
    color: '',
    background: null,
    isLarge: fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700),
    truncation: getTruncation(element, style, box, border, textBoxes),
  };
}

/**
 * Rects of the content that sits on the element's own lines. That is its text and its in-flow inline descendants.
 * Absolute, fixed and floating descendants are laid out on their own and are left out.
 */
function getOwnLineRects(element: Element, range: Range): DOMRect[] {
  const lineRects: DOMRect[] = [];
  const { childNodes } = getFlatChildNodes(element);

  for (const child of Array.from(childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      range.selectNodeContents(child);
      lineRects.push(...range.getClientRects());
      continue;
    }

    if (!(child instanceof Element)) continue;

    const childStyle = getComputedStyle(child);
    const isOutOfFlow = childStyle.position === 'absolute' || childStyle.position === 'fixed' || childStyle.float !== 'none';
    if (isOutOfFlow) continue;

    const isScreenReaderOnlyChild =
      childStyle.display !== 'contents' && isScreenReaderOnly(child, childStyle, createBox(child.getBoundingClientRect(), 0, 0));
    if (isScreenReaderOnlyChild) continue;

    const isInlineContainer =
      childStyle.display === 'contents' || (childStyle.display === 'inline' && !leafTags.has(child.localName));

    if (isInlineContainer) {
      lineRects.push(...getOwnLineRects(child, range));
    } else if (childStyle.display.startsWith('inline')) {
      lineRects.push(child.getBoundingClientRect());
    }
  }

  return lineRects;
}

/** Counts lines among the rects that the node's own clip leaves visible. A rect whose middle is above the current line's bottom joins that line. */
function getVisibleLineCount(element: Element, range: Range, ownClipBox: Box, context: PageContext): number {
  const visibleBoxes = getOwnLineRects(element, range)
    .filter((domRect) => domRect.height > 0)
    .map((domRect) => createBox(domRect, context.scrollX, context.scrollY))
    .filter((lineBox) => doesBoxReachInto(lineBox, ownClipBox))
    .sort((first, second) => first.top - second.top);
  let lineCount = 0;
  let lineBottom = -Infinity;

  for (const visibleBox of visibleBoxes) {
    const verticalCenter = (visibleBox.top + visibleBox.bottom) / 2;

    if (verticalCenter > lineBottom) {
      lineCount++;
      lineBottom = visibleBox.bottom;
    } else {
      lineBottom = Math.max(lineBottom, visibleBox.bottom);
    }
  }

  return Math.max(1, lineCount);
}

function getTruncation(
  element: Element,
  style: CSSStyleDeclaration,
  box: Box,
  border: MeasuredNode['border'],
  textBoxes: Box[],
): TextInfo['truncation'] {
  if (style.textOverflow === 'ellipsis' && element.scrollWidth > element.clientWidth + 1) {
    return { kind: 'ellipsis', hiddenPx: element.scrollWidth - element.clientWidth, clampLines: 0 };
  }

  const lineClamp = style.webkitLineClamp;

  if (lineClamp !== 'none' && lineClamp !== '' && element.scrollHeight > element.clientHeight + 1) {
    return {
      kind: 'clamp',
      hiddenPx: element.scrollHeight - element.clientHeight,
      clampLines: parseInt(lineClamp, 10) || 0,
    };
  }

  const isOverflowClipped = style.overflowX !== 'visible' || style.overflowY !== 'visible';
  if (!isOverflowClipped) {
    return null;
  }

  const paddingBox = getInsetBox(box, border);
  const textInkBox = getBoxUnion(textBoxes)!;
  const hiddenPx = Math.max(
    paddingBox.top - textInkBox.top,
    textInkBox.right - paddingBox.right,
    textInkBox.bottom - paddingBox.bottom,
    paddingBox.left - textInkBox.left,
  );

  return hiddenPx > 1 ? { kind: 'cut', hiddenPx: roundToHundredth(hiddenPx), clampLines: 0 } : null;
}

function getImageInfo(element: Element, tag: string, style: CSSStyleDeclaration): MeasuredNode['image'] {
  if (element instanceof HTMLImageElement) {
    const source = element.currentSrc || element.getAttribute('src') || '';

    return {
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      isComplete: element.complete,
      hasSource: element.hasAttribute('src') || element.hasAttribute('srcset'),
      isVector: /\.svg(?:[?#]|$)/i.test(source) || source.startsWith('data:image/svg'),
      objectFit: style.objectFit,
    };
  }

  if (tag === 'video' && element instanceof HTMLVideoElement) {
    return {
      naturalWidth: element.videoWidth,
      naturalHeight: element.videoHeight,
      isComplete: element.readyState >= HTMLMediaElement.HAVE_METADATA,
      hasSource: element.hasAttribute('src') || element.querySelector('source') !== null,
      isVector: false,
      objectFit: style.objectFit,
    };
  }

  return null;
}
