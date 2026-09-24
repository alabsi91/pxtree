import type { FontRequest, MeasurePageOptions, PageMeasurement, PxtreeInPage } from '../types.ts';
import { measureCoverageAndColors } from './coverage.ts';
import { getEntriesIntersection, getStuckStates, roundToHundredth } from './geometry.ts';
import { revealByScrolling, settlePage } from './settle.ts';
import { type WalkResult, closedShadowRoots, walkPage } from './walk.ts';

const maxStickyProbeCount = 20;

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
  const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

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
    isNodeCapReached: walk.isNodeCapReached,
    nodes: walk.walkedNodes.map((walkedNode) => walkedNode.record),
    topLayerIndexes: walk.topLayerIndexes,
    element: walk.element,
    sampling,
  };
}

if (!globalThis.__pxtree) {
  installAttachShadowHook();
  globalThis.__pxtree = { measurePage, settlePage, revealByScrolling, getFontSampleElements, getFontRequests };
}
