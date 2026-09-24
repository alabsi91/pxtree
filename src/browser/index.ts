import type { FontRequest, MeasurePageOptions, PageMeasurement, PxtreeInPage } from '../types.ts';
import { measureCoverageAndColors } from './coverage.ts';
import { getEntriesIntersection, getStuckStates, roundToHundredth } from './geometry.ts';
import { revealByScrolling, settlePage } from './settle.ts';
import {
  type WalkResult,
  type WalkedNode,
  closedShadowRoots,
  getAllShadowRoots,
  getDeepMatches,
  getSingleLineWidths,
  getTopLayerElements,
  hasForcedLineBreak,
  modalOpenOrderByElement,
  walkPage,
} from './walk.ts';

const maxStickyProbeCount = 20;
const maxSingleLineProbeCount = 200;

declare global {
  var __pxtree: PxtreeInPage | undefined;
}

function installAttachShadowHook(): void {
  const originalAttachShadow = Element.prototype.attachShadow;

  Element.prototype.attachShadow = function attachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
    const shadowRoot = originalAttachShadow.call(this, init);

    if (init.mode === 'closed') {
      closedShadowRoots.set(this, shadowRoot);
    }

    return shadowRoot;
  };
}

function installModalOpenHooks(): void {
  const originalShowModal = HTMLDialogElement.prototype.showModal;
  const originalRequestFullscreen = Element.prototype.requestFullscreen;
  let modalOpenCount = 0;

  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    originalShowModal.call(this);
    modalOpenOrderByElement.set(this, ++modalOpenCount);
  };

  Element.prototype.requestFullscreen = function requestFullscreen(this: Element, options?: FullscreenOptions): Promise<void> {
    modalOpenOrderByElement.set(this, ++modalOpenCount);

    return originalRequestFullscreen.call(this, options);
  };
}

function markStuckNodes(walk: WalkResult): void {
  const stickyNodes = walk.walkedNodes
    .filter((walkedNode) => walkedNode.record.position === 'sticky')
    .slice(0, maxStickyProbeCount);
  if (stickyNodes.length === 0) return;

  const stuckStates = getStuckStates(stickyNodes.map((walkedNode) => walkedNode.element));

  stickyNodes.forEach((walkedNode, stickyPosition) => {
    walkedNode.record.isStuck = stuckStates[stickyPosition];
  });
}

function fillSingleLineWidths(walk: WalkResult): void {
  const wrappedNodes: WalkedNode[] = [];

  for (const walkedNode of walk.walkedNodes) {
    if (wrappedNodes.length >= maxSingleLineProbeCount) break;

    const isWrapped = (walkedNode.record.textInfo?.lineCount ?? 0) >= 2;
    if (isWrapped && !hasForcedLineBreak(walkedNode.element, walkedNode.style)) {
      wrappedNodes.push(walkedNode);
    }
  }

  if (wrappedNodes.length === 0) return;

  const singleLineWidths = getSingleLineWidths(wrappedNodes.map((walkedNode) => walkedNode.element));

  wrappedNodes.forEach((walkedNode, wrappedPosition) => {
    walkedNode.record.textInfo!.singleLineWidth = singleLineWidths[wrappedPosition];
  });
}

function getPaintedTo(walk: WalkResult): number {
  let paintedTo = 0;

  for (const walkedNode of walk.walkedNodes) {
    const record = walkedNode.record;
    const ink = record.ink;
    const hasInk =
      walkedNode.paintsBox || walkedNode.hasOwnText || ink.borderSides.length > 0 || ink.hasShadow || ink.hasOutline;
    if (record.visibility !== 'shown' || !hasInk) continue;

    const clipBottom = getEntriesIntersection(walkedNode.clipEntries, true).bottom;
    paintedTo = Math.max(paintedTo, Math.min(walkedNode.box.bottom, clipBottom));
  }

  return roundToHundredth(paintedTo);
}

function getUnquotedFamily(family: string): string {
  return family.trim().replace(/^["']|["']$/g, '');
}

function getFailedFontFamilies(): string[] {
  const failedFamilies = new Set<string>();

  for (const fontFace of document.fonts) {
    if (fontFace.status === 'error') {
      failedFamilies.add(getUnquotedFamily(fontFace.family));
    }
  }

  return [...failedFamilies];
}

const genericFamilyPattern = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|math|emoji|fangsong)$/i;

/** Apple's names for system-ui. Other platforms skip them. */
const appleSystemFamilyPattern = /^(-apple-system|BlinkMacSystemFont)$/i;

function getFontSampleElements(options: { maxStackCount: number }): Element[] {
  const elementByStack = new Map<string, Element>();
  const textWalker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);

  while (textWalker.nextNode() && elementByStack.size < options.maxStackCount) {
    const textNode = textWalker.currentNode as Text;
    const parentElement = textNode.parentElement;
    if (!parentElement || !/\S/.test(textNode.data)) continue;

    const fontStack = getComputedStyle(parentElement).fontFamily;
    if (!elementByStack.has(fontStack) && parentElement.checkVisibility()) {
      elementByStack.set(fontStack, parentElement);
    }
  }

  return [...elementByStack.values()];
}

function getFontRequests(elements: Element[]): FontRequest[] {
  const fontFaces = [...document.fonts];

  return elements.map((element) => {
    const stackFamilies = getComputedStyle(element).fontFamily.split(',').map(getUnquotedFamily);
    const firstFamily = stackFamilies.find((family) => !appleSystemFamilyPattern.test(family)) ?? '';
    const requestedFamily = firstFamily === '' || genericFamilyPattern.test(firstFamily) ? null : firstFamily;
    const requestedFaces =
      requestedFamily === null ? [] : fontFaces.filter((fontFace) => getUnquotedFamily(fontFace.family).toLowerCase() === requestedFamily.toLowerCase());

    return {
      requestedFamily,
      isWebFont: requestedFaces.length > 0,
      isWebFontLoaded: requestedFaces.some((fontFace) => fontFace.status === 'loaded'),
    };
  });
}

function measurePage(options: MeasurePageOptions): PageMeasurement {
  const walk = walkPage(options.elementSelector, options.maxNodes);
  markStuckNodes(walk);
  fillSingleLineWidths(walk);

  const sampling = measureCoverageAndColors(walk, options.maxSamples);
  const context = walk.context;
  const scrollingElement = document.scrollingElement ?? document.documentElement;

  return {
    url: location.href,
    viewport: { width: context.viewportWidth, height: context.viewportHeight },
    scroll: {
      x: roundToHundredth(context.scrollX),
      y: roundToHundredth(context.scrollY),
      maxX: scrollingElement.scrollWidth - scrollingElement.clientWidth,
      maxY: scrollingElement.scrollHeight - scrollingElement.clientHeight,
    },
    page: {
      width: scrollingElement.scrollWidth,
      height: scrollingElement.scrollHeight,
      paintedTo: getPaintedTo(walk),
    },
    devicePixelRatio: window.devicePixelRatio,
    direction: context.direction,
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    isScrollLocked: context.isScrollLocked,
    modalIndex: walk.modalIndex,
    failedFontFamilies: getFailedFontFamilies(),
    cappedElementCount: walk.cappedElementCount,
    nodes: walk.walkedNodes.map((walkedNode) => walkedNode.record),
    topLayerIndexes: walk.topLayerIndexes,
    element: walk.element,
    sampling,
  };
}

/**
 * The page's state as one string: the DOM with its shadow roots, form control values, the top layer, and the scroll
 * offsets of the window and of every element. Hover and focus are not part of it.
 */
function getPageStateText(): string {
  const allShadowRoots = getAllShadowRoots();
  const root = document.documentElement;
  const rootAttributeTexts = [...root.attributes].map((attribute) => `${attribute.name}=${attribute.value}`);
  const positionByElement = new Map<Element, number>();
  const controlValueTexts: string[] = [];
  const scrollOffsetTexts: string[] = [`window ${window.scrollX},${window.scrollY}`];

  for (const scope of [document, ...allShadowRoots]) {
    for (const element of scope.querySelectorAll('*')) {
      const position = positionByElement.size;
      positionByElement.set(element, position);

      if (element instanceof HTMLInputElement) {
        controlValueTexts.push(`${position} ${element.value} ${element.checked}`);
      } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        controlValueTexts.push(`${position} ${element.value}`);
      }

      if (element.scrollLeft !== 0 || element.scrollTop !== 0) {
        scrollOffsetTexts.push(`${position} ${element.scrollLeft},${element.scrollTop}`);
      }
    }
  }

  const topLayerPositions = getTopLayerElements(allShadowRoots).map((element) => positionByElement.get(element));

  return JSON.stringify([
    rootAttributeTexts,
    root.getHTML({ shadowRoots: allShadowRoots }),
    controlValueTexts,
    topLayerPositions,
    scrollOffsetTexts,
  ]);
}

function scrollToElement(selector: string): boolean {
  const [firstMatch] = getDeepMatches(selector, getAllShadowRoots());
  firstMatch?.scrollIntoView({ block: 'start', behavior: 'instant' });

  return firstMatch !== undefined;
}

if (!globalThis.__pxtree) {
  installAttachShadowHook();
  installModalOpenHooks();
  globalThis.__pxtree = {
    measurePage,
    settlePage,
    revealByScrolling,
    getFontSampleElements,
    getFontRequests,
    getPageStateText,
    scrollToElement,
  };
}
