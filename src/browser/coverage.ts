import type { PageMeasurement } from '../types.ts';
import {
  type Box,
  type ColorAccumulator,
  type ColorBytes,
  addLayerBelow,
  blendColorOver,
  createColorAccumulator,
  doBoxesIntersect,
  finishOverBase,
  formatHex,
  getBoxUnion,
  getColorBytes,
  getEntriesIntersection,
  getInsetBox,
  isAccumulatorOpaque,
  isPointInBox,
} from './geometry.ts';
import { type WalkResult, type WalkedNode, getNearestNodeIndex } from './walk.ts';

/**
 * An important rule in a layer beats an unlayered important rule of any specificity. It still loses to an important
 * rule in an earlier author layer and to an important inline style.
 */
const probeSheetText = `
@layer pxtree-probe {
  *, *::before, *::after { pointer-events: auto !important; }
  html::before { background-color: Canvas !important; }
}
`;

interface Candidate {
  nodeIndex: number;
  inkBoxes: Box[];
  sampleCount: number;
  coveredSampleCount: number;
  sampleCountByCovererIndex: Map<number, number>;
  opaqueSampleCountByCovererIndex: Map<number, number>;
  lastPointId: number;
}

interface CanvasLayer {
  bytes: ColorBytes;
  hasImage: boolean;
  isBodyPropagated: boolean;
}

interface SamplingState {
  walk: WalkResult;
  candidateByNodeIndex: Array<Candidate | undefined>;
  stackNodeIndexes: number[];
  pointId: number;
}

/**
 * Samples paint order over the viewport and fills coverage, text colors and text backgrounds.
 * The page never renders a frame with the probe sheet, because it is removed in the same task.
 */
export function measureCoverageAndColors(walk: WalkResult, maxSamples: number): PageMeasurement['sampling'] {
  const probeSheet = new CSSStyleSheet();
  probeSheet.replaceSync(probeSheetText);

  const styleScopes: Array<Document | ShadowRoot> = [document, ...walk.shadowRootByHost.values()];
  const savedSheetLists = styleScopes.map((scope) => [...scope.adoptedStyleSheets]);

  for (const scope of styleScopes) {
    scope.adoptedStyleSheets = [...scope.adoptedStyleSheets, probeSheet];
  }

  try {
    const baseBytes = getColorBytes(getComputedStyle(document.documentElement, '::before').backgroundColor);
    const sampling = sampleCoverage(walk, maxSamples);
    const stackBackgrounds = getStackBackgrounds(walk, getCanvasLayer());
    fillTextColors(walk, stackBackgrounds, getCanvasLayer(), baseBytes);

    return sampling;
  } finally {
    styleScopes.forEach((scope, scopePosition) => {
      scope.adoptedStyleSheets = savedSheetLists[scopePosition];
    });
  }
}

function getCanvasLayer(): CanvasLayer {
  const rootStyle = getComputedStyle(document.documentElement);
  const rootBytes = getColorBytes(rootStyle.backgroundColor);
  const isRootPainted = rootBytes[3] > 0 || rootStyle.backgroundImage !== 'none';
  if (isRootPainted || !document.body) {
    return { bytes: rootBytes, hasImage: rootStyle.backgroundImage !== 'none', isBodyPropagated: false };
  }

  const bodyStyle = getComputedStyle(document.body);

  return {
    bytes: getColorBytes(bodyStyle.backgroundColor),
    hasImage: bodyStyle.backgroundImage !== 'none',
    isBodyPropagated: true,
  };
}

// ---------- stacks ----------

function getExpandedStack(walk: WalkResult, clientX: number, clientY: number): Element[] {
  const stack = document.elementsFromPoint(clientX, clientY);

  return walk.shadowRootByHost.size === 0 ? stack : expandShadowHosts(walk, stack, clientX, clientY);
}

function expandShadowHosts(walk: WalkResult, stack: Element[], clientX: number, clientY: number): Element[] {
  const expandedStack: Element[] = [];

  for (const element of stack) {
    const shadowRoot = walk.shadowRootByHost.get(element);

    if (shadowRoot) {
      const innerStack = shadowRoot
        .elementsFromPoint(clientX, clientY)
        .filter((innerElement) => innerElement.getRootNode() === shadowRoot);
      expandedStack.push(...expandShadowHosts(walk, innerStack, clientX, clientY));
    }

    expandedStack.push(element);
  }

  return expandedStack;
}

function getNodeIndex(walk: WalkResult, element: Element): number {
  return walk.nodeIndexByElement.get(element) ?? getNearestNodeIndex(element, walk.nodeIndexByElement);
}

// ---------- ink at a point ----------

function isPointOnPaintedBorder(walkedNode: WalkedNode, x: number, y: number): boolean {
  const { box, record } = walkedNode;
  const [borderTop, borderRight, borderBottom, borderLeft] = record.border;

  return record.ink.borderSides.some(
    (side) =>
      (side === 'top' && y <= box.top + borderTop) ||
      (side === 'right' && x >= box.right - borderRight) ||
      (side === 'bottom' && y >= box.bottom - borderBottom) ||
      (side === 'left' && x <= box.left + borderLeft),
  );
}

function hasInkAtPoint(walkedNode: WalkedNode, x: number, y: number): boolean {
  if (walkedNode.record.visibility !== 'shown') {
    return false;
  }

  const hasBoxInkAtPoint =
    isPointInBox(walkedNode.box, x, y) && (walkedNode.paintsBox || isPointOnPaintedBorder(walkedNode, x, y));

  return hasBoxInkAtPoint || walkedNode.textBoxes.some((textBox) => isPointInBox(textBox, x, y));
}

function getFillAlpha(walkedNode: WalkedNode): number {
  const ink = walkedNode.record.ink;
  const isOpaqueFill = ink.hasBackgroundImage || ink.replaced !== null || walkedNode.record.isControl;
  const fillAlpha = isOpaqueFill ? 1 : (walkedNode.backgroundBytes?.[3] ?? 0) / 255;

  return fillAlpha * walkedNode.cumulativeOpacity;
}

/** True when the layers from the coverer down to just above the covered node hide it. Their fills must stack to 0.9 alpha or more. */
function isCoverOpaque(walkedNodes: WalkedNode[], stackNodeIndexes: number[], covererPosition: number, coveredPosition: number): boolean {
  let hiddenShare = 0;

  for (let stackPosition = covererPosition; stackPosition < coveredPosition; stackPosition++) {
    hiddenShare += (1 - hiddenShare) * getFillAlpha(walkedNodes[stackNodeIndexes[stackPosition]]);
  }

  return hiddenShare >= 0.9;
}

// ---------- coverage ----------

function createCandidates(walk: WalkResult): Candidate[] {
  const candidates: Candidate[] = [];
  const viewportBox = walk.context.viewportBox;

  for (const walkedNode of walk.walkedNodes) {
    const record = walkedNode.record;
    const isTextOrControl = record.textInfo !== null || record.isControl;
    const box = walkedNode.box;
    const isInViewport = doBoxesIntersect(box, viewportBox);
    if (record.visibility !== 'shown' || record.isInert || !isTextOrControl || !isInViewport) continue;

    const inkBoxes = [...walkedNode.textBoxes];

    if (record.isControl) {
      inkBoxes.push(getInsetBox(getInsetBox(box, record.border), record.padding));
    }

    candidates.push({
      nodeIndex: record.index,
      inkBoxes,
      sampleCount: 0,
      coveredSampleCount: 0,
      sampleCountByCovererIndex: new Map(),
      opaqueSampleCountByCovererIndex: new Map(),
      lastPointId: -1,
    });
  }

  return candidates;
}

function sampleCoverage(walk: WalkResult, maxSamples: number): PageMeasurement['sampling'] {
  const { viewportWidth, viewportHeight } = walk.context;
  const gridStep = Math.max(4, Math.ceil(Math.sqrt((viewportWidth * viewportHeight) / 15000)));
  const candidates = createCandidates(walk);
  const state: SamplingState = {
    walk,
    candidateByNodeIndex: new Array(walk.walkedNodes.length),
    stackNodeIndexes: [],
    pointId: 0,
  };

  for (const candidate of candidates) {
    state.candidateByNodeIndex[candidate.nodeIndex] = candidate;
  }

  let pointCount = 0;
  let isCapped = false;

  if (candidates.length > 0) {
    gridLoop: for (let clientY = gridStep / 2; clientY < viewportHeight; clientY += gridStep) {
      for (let clientX = gridStep / 2; clientX < viewportWidth; clientX += gridStep) {
        if (pointCount >= maxSamples) {
          isCapped = true;
          break gridLoop;
        }

        samplePoint(state, clientX, clientY);
        pointCount++;
      }
    }

    const maxTopUpCount = Math.min(6000, maxSamples - pointCount);
    let topUpCount = 0;

    topUpLoop: for (const candidate of candidates) {
      if (candidate.sampleCount >= 3) continue;

      for (const [clientX, clientY] of getTopUpPoints(walk, candidate)) {
        if (topUpCount >= maxTopUpCount) {
          isCapped = true;
          break topUpLoop;
        }

        samplePoint(state, clientX, clientY);
        topUpCount++;
      }
    }

    pointCount += topUpCount;
  }

  for (const candidate of candidates) {
    const coverers = [...candidate.sampleCountByCovererIndex]
      .map(([covererIndex, sampleCount]) => ({
        index: covererIndex,
        sampleCount,
        isTranslucent: 2 * (candidate.opaqueSampleCountByCovererIndex.get(covererIndex) ?? 0) < sampleCount,
      }))
      .sort((first, second) => second.sampleCount - first.sampleCount);

    walk.walkedNodes[candidate.nodeIndex].record.coverage = {
      sampleCount: candidate.sampleCount,
      coveredSampleCount: candidate.coveredSampleCount,
      coverers,
    };
  }

  return { gridStep, pointCount, isCapped };
}

/** The center and the four 25% / 75% points of the visible ink, in client coordinates. */
function getTopUpPoints(walk: WalkResult, candidate: Candidate): Array<[number, number]> {
  const walkedNode = walk.walkedNodes[candidate.nodeIndex];
  const { viewportBox, scrollX, scrollY } = walk.context;
  const inkBox = getBoxUnion(candidate.inkBoxes);
  if (!inkBox) {
    return [];
  }

  const clipBox = getEntriesIntersection(walkedNode.clipEntries, true);
  const left = Math.max(inkBox.left, viewportBox.left, clipBox.left);
  const top = Math.max(inkBox.top, viewportBox.top, clipBox.top);
  const right = Math.min(inkBox.right, viewportBox.right, clipBox.right);
  const bottom = Math.min(inkBox.bottom, viewportBox.bottom, clipBox.bottom);
  if (right <= left || bottom <= top) {
    return [];
  }

  const width = right - left;
  const height = bottom - top;
  const pointFractions: Array<[number, number]> = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];

  return pointFractions.map(([fractionX, fractionY]) => [
    left + width * fractionX - scrollX,
    top + height * fractionY - scrollY,
  ]);
}

function samplePoint(state: SamplingState, clientX: number, clientY: number): void {
  const walk = state.walk;
  const walkedNodes = walk.walkedNodes;
  const x = clientX + walk.context.scrollX;
  const y = clientY + walk.context.scrollY;
  const stackNodeIndexes = state.stackNodeIndexes;
  const pointId = state.pointId++;
  let previousNodeIndex = -1;
  let hasCandidate = false;

  stackNodeIndexes.length = 0;

  for (const element of getExpandedStack(walk, clientX, clientY)) {
    const nodeIndex = getNodeIndex(walk, element);
    if (nodeIndex === -1 || nodeIndex === previousNodeIndex) continue;

    stackNodeIndexes.push(nodeIndex);
    previousNodeIndex = nodeIndex;
    hasCandidate ||= state.candidateByNodeIndex[nodeIndex] !== undefined;
  }

  if (!hasCandidate) return;

  for (let stackPosition = 0; stackPosition < stackNodeIndexes.length; stackPosition++) {
    const candidateIndex = stackNodeIndexes[stackPosition];
    const candidate = state.candidateByNodeIndex[candidateIndex];
    if (!candidate || candidate.lastPointId === pointId) continue;
    if (!candidate.inkBoxes.some((inkBox) => isPointInBox(inkBox, x, y))) continue;

    candidate.lastPointId = pointId;
    candidate.sampleCount++;

    const subtreeEnd = walkedNodes[candidateIndex].record.subtreeEnd;

    for (let abovePosition = 0; abovePosition < stackPosition; abovePosition++) {
      const aboveIndex = stackNodeIndexes[abovePosition];
      const aboveNode = walkedNodes[aboveIndex];
      const isSelfOrDescendant = aboveIndex >= candidateIndex && aboveIndex <= subtreeEnd;
      if (isSelfOrDescendant || aboveNode.record.labelForIndex === candidateIndex) continue;
      if (!hasInkAtPoint(aboveNode, x, y)) continue;

      candidate.coveredSampleCount++;
      candidate.sampleCountByCovererIndex.set(aboveIndex, (candidate.sampleCountByCovererIndex.get(aboveIndex) ?? 0) + 1);

      if (isCoverOpaque(walkedNodes, stackNodeIndexes, abovePosition, stackPosition)) {
        candidate.opaqueSampleCountByCovererIndex.set(aboveIndex, (candidate.opaqueSampleCountByCovererIndex.get(aboveIndex) ?? 0) + 1);
      }

      break;
    }
  }
}

// ---------- text backgrounds and colors ----------

/** Paint-truth backgrounds at the center of each text ink in the viewport. null means an image is behind. */
function getStackBackgrounds(walk: WalkResult, canvasLayer: CanvasLayer): Map<number, ColorAccumulator | null> {
  const backgroundByNodeIndex = new Map<number, ColorAccumulator | null>();
  const { viewportBox, scrollX, scrollY } = walk.context;

  for (const walkedNode of walk.walkedNodes) {
    const record = walkedNode.record;
    if (!record.textInfo || record.visibility !== 'shown' || record.isInert) continue;

    const inkRect = record.textInfo.inkRect;
    const centerX = inkRect.x + inkRect.width / 2;
    const centerY = inkRect.y + inkRect.height / 2;
    if (!isPointInBox(viewportBox, centerX, centerY)) continue;

    const stack = getExpandedStack(walk, centerX - scrollX, centerY - scrollY);
    const ownPosition = stack.indexOf(walkedNode.element);
    if (ownPosition === -1) continue;

    const accumulator = createColorAccumulator();
    let hasImageBehind = false;

    for (let stackPosition = ownPosition; stackPosition < stack.length; stackPosition++) {
      const layer = getStackLayer(walk, stack[stackPosition], canvasLayer);

      if (layer === 'image') {
        hasImageBehind = true;
        break;
      }

      if (layer) {
        addLayerBelow(accumulator, layer.bytes, layer.opacity);
      }

      if (isAccumulatorOpaque(accumulator)) break;
    }

    backgroundByNodeIndex.set(record.index, hasImageBehind ? null : accumulator);
  }

  return backgroundByNodeIndex;
}

function getStackLayer(
  walk: WalkResult,
  element: Element,
  canvasLayer: CanvasLayer,
): { bytes: ColorBytes; opacity: number } | 'image' | null {
  if (element === document.documentElement) {
    return canvasLayer.hasImage ? 'image' : { bytes: canvasLayer.bytes, opacity: 1 };
  }

  if (element === document.body && canvasLayer.isBodyPropagated) {
    return null;
  }

  const nodeIndex = getNodeIndex(walk, element);
  const walkedNode = nodeIndex === -1 ? null : walk.walkedNodes[nodeIndex];

  if (walkedNode && walkedNode.element === element) {
    const ink = walkedNode.record.ink;
    if (ink.replaced || ink.hasBackgroundImage) {
      return 'image';
    }

    return walkedNode.backgroundBytes ? { bytes: walkedNode.backgroundBytes, opacity: walkedNode.cumulativeOpacity } : null;
  }

  const style = getComputedStyle(element);
  if (walkedNode?.record.ink.replaced || style.backgroundImage !== 'none') {
    return 'image';
  }

  const inheritedOpacity = walkedNode ? walkedNode.cumulativeOpacity : 1;

  return { bytes: getColorBytes(style.backgroundColor), opacity: inheritedOpacity * parseFloat(style.opacity) };
}

function fillTextColors(
  walk: WalkResult,
  stackBackgrounds: Map<number, ColorAccumulator | null>,
  canvasLayer: CanvasLayer,
  baseBytes: ColorBytes,
): void {
  for (const walkedNode of walk.walkedNodes) {
    const textInfo = walkedNode.record.textInfo;
    if (!textInfo) continue;

    const partialBackground = stackBackgrounds.has(walkedNode.record.index)
      ? stackBackgrounds.get(walkedNode.record.index)!
      : getAncestorBackground(walk, walkedNode, canvasLayer);
    const background = partialBackground ? finishOverBase(partialBackground, baseBytes) : null;
    const fillBytes = getColorBytes(walkedNode.style.webkitTextFillColor);
    const isFillTransparent = fillBytes[3] === 0;

    textInfo.color = isFillTransparent ? null : formatHex(blendColorOver(fillBytes, walkedNode.cumulativeOpacity, background ?? baseBytes));
    textInfo.background = background ? formatHex(background) : null;
  }
}

/** Composites backgrounds up the flat ancestor chain, for text that no stack reached. */
function getAncestorBackground(
  walk: WalkResult,
  walkedNode: WalkedNode,
  canvasLayer: CanvasLayer,
): ColorAccumulator | null {
  const accumulator = createColorAccumulator();
  let current: WalkedNode | null = walkedNode;

  while (current && !isAccumulatorOpaque(accumulator)) {
    const ink = current.record.ink;
    const isPropagatedBody = current.element === document.body && canvasLayer.isBodyPropagated;
    if (!isPropagatedBody && (ink.replaced || ink.hasBackgroundImage)) {
      return null;
    }

    if (!isPropagatedBody && current.backgroundBytes) {
      addLayerBelow(accumulator, current.backgroundBytes, current.cumulativeOpacity);
    }

    current = current.record.parentIndex === -1 ? null : walk.walkedNodes[current.record.parentIndex];
  }

  if (isAccumulatorOpaque(accumulator)) {
    return accumulator;
  }

  if (canvasLayer.hasImage) {
    return null;
  }

  addLayerBelow(accumulator, canvasLayer.bytes, 1);

  return accumulator;
}
