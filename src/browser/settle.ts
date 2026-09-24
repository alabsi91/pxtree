import type { SettleReport } from '../types.ts';
import {
  createClassFrequency,
  createNodeName,
  createPageContext,
  getAllAnimations,
  getAllShadowRoots,
  getNormalizedClassNames,
} from './walk.ts';

const signatureElementLimit = 3000;

function waitForFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForFrames(frameCount: number): Promise<void> {
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    await waitForFrame();
  }
}

/**
 * Finishes time-based animations and parks infinite ones at 0. Scroll-driven ones stay where the scroll put them.
 * Paused ones stay at the frame where the page or the script paused them.
 */
function settleNewAnimations(settledAnimations: WeakSet<Animation>): void {
  for (const animation of getAllAnimations(getAllShadowRoots())) {
    if (settledAnimations.has(animation)) continue;

    settledAnimations.add(animation);

    const isTimeBased = animation.timeline instanceof DocumentTimeline;
    if (!isTimeBased || animation.playState === 'paused') continue;

    try {
      const endTime = animation.effect?.getComputedTiming().endTime ?? 0;

      if (endTime === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      } else {
        animation.finish();
      }
    } catch {
      // An animation can refuse to finish, for example with a zero playback rate.
    }
  }
}

function getSignatureElements(): Element[] {
  return [...document.querySelectorAll('body *')].slice(0, signatureElementLimit);
}

function getSignature(signatureElements: Element[]): number[] {
  const signature: number[] = [];

  for (const element of signatureElements) {
    const domRect = element.getBoundingClientRect();
    signature.push(Math.round(domRect.x), Math.round(domRect.y), Math.round(domRect.width), Math.round(domRect.height));
  }

  return signature;
}

function getMostMovedElementIndex(previousSignature: number[], signature: number[]): number {
  let mostMovedIndex = -1;
  let largestMovement = 0;

  for (let valueIndex = 0; valueIndex < signature.length; valueIndex += 4) {
    let movement = 0;

    for (let offset = 0; offset < 4; offset++) {
      movement += Math.abs(signature[valueIndex + offset] - (previousSignature[valueIndex + offset] ?? 0));
    }

    if (movement > largestMovement) {
      largestMovement = movement;
      mostMovedIndex = valueIndex / 4;
    }
  }

  return mostMovedIndex;
}

function createElementName(element: Element, signatureElements: Element[]): string {
  const classFrequency = createClassFrequency(signatureElements.map(getNormalizedClassNames));

  return createNodeName(element, getNormalizedClassNames(element), classFrequency);
}

export async function settlePage(options: { maxWaitMs: number }): Promise<SettleReport> {
  const startTime = performance.now();
  const settledAnimations = new WeakSet<Animation>();

  settleNewAnimations(settledAnimations);
  await waitForFrames(2);

  let previousElements = getSignatureElements();
  let previousSignature = getSignature(previousElements);

  while (performance.now() - startTime < options.maxWaitMs) {
    await waitForFrame();
    settleNewAnimations(settledAnimations);

    const currentElements = getSignatureElements();
    const signature = getSignature(currentElements);
    const isSameElementList =
      currentElements.length === previousElements.length &&
      currentElements.every((element, index) => element === previousElements[index]);

    if (isSameElementList && signature.every((value, index) => value === previousSignature[index])) {
      return { stillMovingName: null };
    }

    if (isSameElementList && performance.now() - startTime >= options.maxWaitMs) {
      const mostMovedIndex = getMostMovedElementIndex(previousSignature, signature);
      if (mostMovedIndex !== -1) {
        return { stillMovingName: createElementName(currentElements[mostMovedIndex], currentElements) };
      }
    }

    previousElements = currentElements;
    previousSignature = signature;
  }

  return { stillMovingName: null };
}

async function waitForPendingImages(maxWaitMs: number): Promise<void> {
  const startTime = performance.now();
  const pageImages: HTMLImageElement[] = [...document.images];

  for (const shadowRoot of getAllShadowRoots()) {
    pageImages.push(...shadowRoot.querySelectorAll('img'));
  }

  while (pageImages.some((image) => !image.complete) && performance.now() - startTime < maxWaitMs) {
    await waitForFrame();
  }
}

/** Scrolls down one screen at a time and then scrolls back. Reveal-on-scroll and lazy loading fire on the way down. */
export async function revealByScrolling(options: { maxSteps: number; maxImageWaitMs: number }): Promise<void> {
  const scrollingElement = document.scrollingElement ?? document.documentElement;
  const pageHeight = scrollingElement.scrollHeight;
  const screenHeight = window.innerHeight;
  if (createPageContext().isScrollLocked || pageHeight <= screenHeight) return;

  const startX = window.scrollX;
  const startY = window.scrollY;
  const maxScrollY = pageHeight - screenHeight;

  for (let step = 1; step <= options.maxSteps; step++) {
    const top = Math.min(step * screenHeight, maxScrollY);
    window.scrollTo({ left: startX, top, behavior: 'instant' });
    await waitForFrames(2);

    if (top >= maxScrollY) break;
  }

  window.scrollTo({ left: startX, top: startY, behavior: 'instant' });
  await waitForPendingImages(options.maxImageWaitMs);
}
