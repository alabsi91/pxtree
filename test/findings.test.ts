import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { analyze, getContrastRatio } from '../src/findings/findings.ts';
import { getNodeLayouts } from '../src/findings/layout.ts';
import type { Ink, MeasuredNode, PageMeasurement, Rect, TextInfo } from '../src/types.ts';

type NodeSpec = Partial<Omit<MeasuredNode, 'index' | 'depth' | 'subtreeEnd'>> & { parentIndex: number; rect: Rect };

function createRect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function createInk(overrides: Partial<Ink> = {}): Ink {
  return {
    background: null,
    hasBackgroundImage: false,
    borderSides: [],
    borderColor: null,
    hasShadow: false,
    hasOutline: false,
    replaced: null,
    pseudoInk: null,
    hasText: false,
    opacity: 1,
    ...overrides,
  };
}

const backgroundInk = createInk({ background: '#eeeeee' });

function createTextInfo(inkRect: Rect, overrides: Partial<TextInfo> = {}): TextInfo {
  return {
    fontSize: 16,
    lineHeight: inkRect.height,
    fontWeight: 400,
    lineCount: 1,
    inkRect,
    capTop: inkRect.y + 4,
    baseline: inkRect.y + inkRect.height - 4,
    color: '#111111',
    background: '#ffffff',
    isLarge: false,
    truncation: null,
    ...overrides,
  };
}

function createNode(index: number, spec: NodeSpec): MeasuredNode {
  const tag = spec.tag ?? spec.name?.split(/[.#]/)[0] ?? 'div';

  return {
    tag,
    name: tag,
    text: '',
    visibility: 'shown',
    clippedOutByIndex: null,
    skippedChildCount: 0,
    layoutWidth: spec.rect.width,
    layoutHeight: spec.rect.height,
    rotateDegrees: 0,
    scale: 1,
    translate: null,
    isInsideTransform: false,
    isAnimating: false,
    motionRole: null,
    position: 'static',
    isViewportFrame: false,
    isStuck: false,
    isFloat: false,
    isInFlow: true,
    isInline: false,
    display: 'block',
    direction: 'ltr',
    border: [0, 0, 0, 0],
    padding: [0, 0, 0, 0],
    margin: [0, 0, 0, 0],
    clip: null,
    clipsChildren: { x: 'none', y: 'none' },
    scroll: null,
    ink: createInk(),
    textInfo: null,
    textRuns: [],
    image: null,
    isControl: false,
    isInteractive: false,
    isDisabled: false,
    isInlineInText: false,
    isInert: false,
    topLayer: null,
    shadow: null,
    isSlotted: false,
    isFrame: false,
    labelForIndex: null,
    labelIndex: null,
    coverage: null,
    ...spec,
    rect: { ...spec.rect },
    index,
    depth: 0,
    subtreeEnd: index,
  };
}

/** Builds a page from preorder node specs. Depth and subtreeEnd are derived from parentIndex. */
function createPage(nodeSpecs: NodeSpec[], overrides: Partial<PageMeasurement> = {}): PageMeasurement {
  const nodes = nodeSpecs.map((spec, index) => createNode(index, spec));

  for (const node of nodes) {
    node.depth = node.parentIndex >= 0 ? nodes[node.parentIndex].depth + 1 : 0;
  }

  for (const node of [...nodes].reverse()) {
    if (node.parentIndex >= 0) {
      const parent = nodes[node.parentIndex];
      parent.subtreeEnd = Math.max(parent.subtreeEnd, node.subtreeEnd);
    }
  }

  return {
    url: 'file:///test.html',
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
    page: { width: 1280, height: 800, paintedTo: 800 },
    devicePixelRatio: 1,
    direction: 'ltr',
    colorScheme: 'light',
    isScrollLocked: false,
    modalIndex: null,
    failedFontFamilies: [],
    isNodeCapReached: false,
    nodes,
    topLayerIndexes: [],
    element: null,
    sampling: { gridStep: 9, pointCount: 0, isCapped: false },
    ...overrides,
  };
}

const bodySpec: NodeSpec = { parentIndex: -1, tag: 'body', rect: createRect(0, 0, 1280, 800) };

function getFindingTexts(page: PageMeasurement): string[] {
  return analyze(page).findings.map((finding) => `${page.nodes[finding.nodeIndex].name}: ${finding.text}`);
}

describe('layout', () => {
  test('@x,y is measured from the parent content box', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, rect: createRect(100, 50, 400, 300), border: [2, 2, 2, 2], padding: [10, 10, 10, 10] },
      { parentIndex: 1, rect: createRect(117, 70, 50, 20) },
      { parentIndex: 1, rect: createRect(112, 62, 50, 20) },
    ]);
    const layouts = getNodeLayouts(page);

    assert.deepEqual([layouts[2].x, layouts[2].y], [5, 8]);
    assert.deepEqual([layouts[3].x, layouts[3].y], [0, 0]);
  });

  test('rtl parents measure x from the right edge of the content box', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, rect: createRect(0, 0, 400, 300), padding: [0, 16, 0, 16], direction: 'rtl' },
      { parentIndex: 1, rect: createRect(300, 0, 77, 20), direction: 'rtl' },
    ]);

    assert.equal(getNodeLayouts(page)[2].x, 7);
  });

  test('viewport frames are measured from the viewport at the current scroll', () => {
    const page = createPage(
      [bodySpec, { parentIndex: 0, rect: createRect(10, 420, 100, 40), position: 'fixed', isViewportFrame: true, isInFlow: false }],
      { scroll: { x: 0, y: 400, maxX: 0, maxY: 1000 } },
    );
    const layout = getNodeLayouts(page)[1];

    assert.deepEqual([layout.x, layout.y], [10, 20]);
  });

  test('stacked gaps with free space at the end', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, rect: createRect(0, 0, 100, 200) },
      { parentIndex: 1, rect: createRect(0, 0, 100, 20) },
      { parentIndex: 1, rect: createRect(0, 36, 100, 20) },
    ]);

    assert.deepEqual(getNodeLayouts(page)[1].gaps, { arrangement: 'stacked', gaps: [16], columnGaps: [], freeStart: 0, freeEnd: 144 });
  });

  test('no gaps for a plain stack with zero gaps and no free space', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, rect: createRect(0, 0, 100, 40) },
      { parentIndex: 1, rect: createRect(0, 0, 100, 20) },
      { parentIndex: 1, rect: createRect(0, 20, 100, 20) },
      { parentIndex: 0, rect: createRect(0, 40, 100, 60) },
      { parentIndex: 4, rect: createRect(0, 40, 100, 20) },
      { parentIndex: 4, rect: createRect(0, 60, 100, 20) },
    ]);
    const layouts = getNodeLayouts(page);

    assert.equal(layouts[1].gaps, null);
    assert.deepEqual(layouts[4].gaps, { arrangement: 'stacked', gaps: [0], columnGaps: [], freeStart: 0, freeEnd: 20 });
  });

  test('across gaps with a text run and free space at the start', () => {
    const page = createPage([
      bodySpec,
      {
        parentIndex: 0,
        rect: createRect(0, 0, 400, 40),
        textRuns: [{ rect: createRect(200, 10, 60, 20), afterChildCount: 0 }],
      },
      { parentIndex: 1, rect: createRect(272, 0, 128, 40) },
    ]);

    assert.deepEqual(getNodeLayouts(page)[1].gaps, { arrangement: 'across', gaps: [12], columnGaps: [], freeStart: 200, freeEnd: 0 });
  });

  test('own text with inline children is a text flow and has no gaps', () => {
    const page = createPage([
      bodySpec,
      {
        parentIndex: 0,
        tag: 'p',
        rect: createRect(0, 0, 1232, 24),
        textRuns: [
          { rect: createRect(0, 0, 140, 24), afterChildCount: 0 },
          { rect: createRect(223, 0, 10, 24), afterChildCount: 1 },
        ],
      },
      { parentIndex: 1, tag: 'a', rect: createRect(140, 0, 83, 24), isInline: true },
    ]);

    assert.equal(getNodeLayouts(page)[1].gaps, null);
  });

  test('rtl across gaps run from the right', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, rect: createRect(0, 0, 400, 40), direction: 'rtl' },
      { parentIndex: 1, rect: createRect(300, 0, 100, 40) },
      { parentIndex: 1, rect: createRect(180, 0, 100, 40) },
    ]);

    assert.deepEqual(getNodeLayouts(page)[1].gaps, { arrangement: 'across', gaps: [20], columnGaps: [], freeStart: 0, freeEnd: 180 });
  });

  test('grid gaps list rows and columns', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, rect: createRect(0, 0, 216, 216) },
      { parentIndex: 1, rect: createRect(0, 0, 100, 100) },
      { parentIndex: 1, rect: createRect(116, 0, 100, 100) },
      { parentIndex: 1, rect: createRect(0, 116, 100, 100) },
      { parentIndex: 1, rect: createRect(116, 116, 100, 100) },
    ]);

    assert.deepEqual(getNodeLayouts(page)[1].gaps, { arrangement: 'grid', gaps: [16], columnGaps: [16, 16], freeStart: 0, freeEnd: 0 });
  });

  test('no gaps for one child or an out-of-order pile', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, rect: createRect(0, 0, 200, 200) },
      { parentIndex: 1, rect: createRect(0, 0, 100, 100) },
      { parentIndex: 0, rect: createRect(0, 200, 200, 200) },
      { parentIndex: 3, rect: createRect(50, 250, 100, 100) },
      { parentIndex: 3, rect: createRect(0, 220, 100, 100) },
    ]);
    const layouts = getNodeLayouts(page);

    assert.equal(layouts[1].gaps, null);
    assert.equal(layouts[3].gaps, null);
  });

});

describe('clipped', () => {
  function createClippedPage(panelOverrides: Partial<NodeSpec> = {}, spanOverrides: Partial<NodeSpec> = {}): PageMeasurement {
    const clip = { rect: createRect(0, 0, 200, 100), clipperIndexX: 1, clipperIndexY: 1 };

    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.panel', rect: createRect(0, 0, 200, 100), clipsChildren: { x: 'clip', y: 'clip' }, ...panelOverrides },
      { parentIndex: 1, name: 'span', rect: createRect(0, 0, 214, 20), clip, textInfo: createTextInfo(createRect(0, 0, 214, 20)), ...spanOverrides },
      { parentIndex: 2, name: 'b', rect: createRect(100, 0, 120, 20), clip, textInfo: createTextInfo(createRect(100, 0, 120, 20)) },
    ]);
  }

  test('fires on text past a clip, said once down a branch', () => {
    assert.deepEqual(getFindingTexts(createClippedPage()), ['span: clipped right 14 by div.panel']);
  });

  test('does not fire when the clipper scrolls on that axis', () => {
    assert.deepEqual(getFindingTexts(createClippedPage({ clipsChildren: { x: 'scroll', y: 'clip' } })), []);
  });

  test('does not fire on a box without text or control', () => {
    const texts = getFindingTexts(createClippedPage({}, { textInfo: null }));

    assert.deepEqual(texts, ['b: clipped right 20 by div.panel']);
  });

  test('each axis names its own clipper, and the viewport by name', () => {
    const clip = { rect: createRect(0, 0, 200, 800), clipperIndexX: 1, clipperIndexY: null };
    const page = createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.panel', rect: createRect(0, 600, 200, 200), clipsChildren: { x: 'clip', y: 'scroll' } },
      { parentIndex: 1, name: 'span', rect: createRect(0, 780, 214, 40), clip, textInfo: createTextInfo(createRect(0, 780, 214, 40)) },
    ]);

    assert.deepEqual(getFindingTexts(page), ['span: clipped right 14 by div.panel', 'span: clipped bottom 20 by viewport']);
  });

  function createClippedOutPage(panelRect = createRect(0, 0, 300, 60), parentVisibility: MeasuredNode['visibility'] = 'shown'): PageMeasurement {
    const clip = { rect: panelRect, clipperIndexX: 1, clipperIndexY: 1 };
    const clippedOut = { visibility: 'clipped-out' as const, clippedOutByIndex: 1, clip };

    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'form.body', rect: panelRect, clipsChildren: { x: 'clip', y: 'clip' }, visibility: parentVisibility },
      { parentIndex: 1, name: 'label', rect: createRect(0, 80, 300, 20), textInfo: createTextInfo(createRect(0, 80, 60, 20)), ...clippedOut },
      { parentIndex: 1, name: 'input#size', rect: createRect(0, 104, 300, 40), isControl: true, ...clippedOut },
      { parentIndex: 1, name: 'div.actions', rect: createRect(0, 150, 300, 40), skippedChildCount: 2, ...clippedOut },
      { parentIndex: 1, name: 'div.spacer', rect: createRect(0, 190, 300, 10), ...clippedOut },
    ]);
  }

  test('clipped out fires on text, controls and boxes whose unwalked children may hold them', () => {
    assert.deepEqual(getFindingTexts(createClippedOutPage()), [
      'label: clipped out by form.body',
      'input#size: clipped out by form.body',
      'div.actions: clipped out by form.body',
    ]);
  });

  test('clipped out fires under a clipper collapsed to zero height', () => {
    assert.equal(getFindingTexts(createClippedOutPage(createRect(0, 0, 300, 0))).length, 3);
  });

  test('clipped out does not fire inside an unpainted parent', () => {
    assert.deepEqual(getFindingTexts(createClippedOutPage(undefined, 'unpainted-visibility')), []);
  });
});

describe('overflows', () => {
  function createOverflowPage(childOverrides: Partial<NodeSpec> = {}, parentOverrides: Partial<NodeSpec> = {}): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.parent', rect: createRect(100, 0, 200, 100), ...parentOverrides },
      { parentIndex: 1, name: 'div.child', rect: createRect(100, 0, 214, 20), ...childOverrides },
    ]);
  }

  test('fires on the end side', () => {
    assert.deepEqual(getFindingTexts(createOverflowPage()), ['div.child: overflows parent end 14']);
  });

  test('maps the left side to end in an rtl parent', () => {
    const page = createOverflowPage({ rect: createRect(86, 0, 214, 20) }, { direction: 'rtl' });

    assert.deepEqual(getFindingTexts(page), ['div.child: overflows parent end 14']);
  });

  test('equal overhang on both sides prints as one finding', () => {
    assert.deepEqual(getFindingTexts(createOverflowPage({ rect: createRect(76, 0, 248, 20) })), ['div.child: overflows parent start and end 24']);
  });

  test('parent scroll container does not fire', () => {
    assert.deepEqual(getFindingTexts(createOverflowPage({}, { clipsChildren: { x: 'scroll', y: 'none' } })), []);
  });

  test('absolute children do not fire', () => {
    assert.deepEqual(getFindingTexts(createOverflowPage({ position: 'absolute', isInFlow: false })), []);
  });

  test('clipped overflow does not fire', () => {
    const clip = { rect: createRect(100, 0, 200, 100), clipperIndexX: 1, clipperIndexY: 1 };

    assert.deepEqual(getFindingTexts(createOverflowPage({ clip }, { clipsChildren: { x: 'clip', y: 'clip' } })), []);
  });

  test('reported only where it begins', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.parent', rect: createRect(100, 0, 200, 100) },
      { parentIndex: 1, name: 'div.child', rect: createRect(100, 0, 214, 20) },
      { parentIndex: 2, name: 'div.grandchild', rect: createRect(100, 0, 214, 20) },
    ]);

    assert.deepEqual(getFindingTexts(page), ['div.child: overflows parent end 14']);
  });

  test('a descendant that overflows its own overflowing parent also fires', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.parent', rect: createRect(100, 0, 200, 100) },
      { parentIndex: 1, name: 'div.child', rect: createRect(100, 0, 214, 20) },
      { parentIndex: 2, name: 'div.grandchild', rect: createRect(100, 0, 234, 20) },
    ]);

    assert.deepEqual(getFindingTexts(page), ['div.child: overflows parent end 14', 'div.grandchild: overflows parent end 20']);
  });

  test('an inline box overhanging on the block axis does not fire, an inline-block does', () => {
    const inlineBox = { rect: createRect(100, -6, 56, 36), isInline: true, display: 'inline' };
    const inlineBlock = { ...inlineBox, display: 'inline-block' };

    assert.deepEqual(getFindingTexts(createOverflowPage(inlineBox, { rect: createRect(100, 0, 200, 24) })), []);
    assert.deepEqual(getFindingTexts(createOverflowPage(inlineBlock, { rect: createRect(100, 0, 200, 24) })), [
      'div.child: overflows parent top and bottom 6',
    ]);
  });

  test('top and bottom stay separate when their amounts differ by more than 1 px', () => {
    const tallChild = { rect: createRect(100, -6, 56, 40), display: 'inline-block' };

    assert.deepEqual(getFindingTexts(createOverflowPage(tallChild, { rect: createRect(100, 0, 200, 24) })), [
      'div.child: overflows parent top 6',
      'div.child: overflows parent bottom 10',
    ]);
  });

  test('a child of an inline box overhanging on the block axis does not fire', () => {
    const page = createOverflowPage({ rect: createRect(100, -2, 13, 13), isInline: true, display: 'inline-block' }, { rect: createRect(100, 0, 40, 14), isInline: true, display: 'inline' });

    assert.deepEqual(getFindingTexts(page), []);
  });

  test('past viewport on the same side replaces it', () => {
    const page = createOverflowPage();
    page.viewport.width = 300;
    page.nodes[0].rect.width = 300;

    assert.deepEqual(getFindingTexts(page), ['div.child: past viewport end 14']);
  });
});

describe('text overflows', () => {
  function createTextPage(textOverrides: Partial<TextInfo> = {}, nodeOverrides: Partial<NodeSpec> = {}): PageMeasurement {
    return createPage([
      bodySpec,
      {
        parentIndex: 0,
        name: 'p',
        rect: createRect(0, 0, 100, 20),
        textInfo: createTextInfo(createRect(0, 0, 130, 20), textOverrides),
        ...nodeOverrides,
      },
    ]);
  }

  test('fires when own text runs past the box', () => {
    assert.deepEqual(getFindingTexts(createTextPage()), ['p: text overflows end 30']);
  });

  test('truncation replaces it', () => {
    const truncation = { kind: 'ellipsis' as const, hiddenPx: 30, clampLines: 0 };

    assert.deepEqual(getFindingTexts(createTextPage({ truncation })), ['p: text truncated ellipsis 30']);
  });

  test('a node that clips its text does not fire', () => {
    assert.deepEqual(getFindingTexts(createTextPage({}, { clipsChildren: { x: 'clip', y: 'none' } })), []);
  });

  test('tight line height does not fire', () => {
    const page = createPage([
      bodySpec,
      {
        parentIndex: 0,
        name: 'h1',
        rect: createRect(0, 0, 400, 48),
        textInfo: createTextInfo(createRect(0, -5, 300, 58), { lineHeight: 48 }),
      },
    ]);

    assert.deepEqual(getFindingTexts(page), []);
  });
});

describe('past viewport', () => {
  function createWidePage(childOverrides: Partial<NodeSpec> = {}, parentOverrides: Partial<NodeSpec> = {}): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.row', rect: createRect(0, 0, 1294, 40), ...parentOverrides },
      { parentIndex: 1, name: 'a.more', rect: createRect(0, 0, 1294, 40), ...childOverrides },
    ]);
  }

  test('fires where it begins only', () => {
    assert.deepEqual(getFindingTexts(createWidePage()), ['div.row: past viewport end 14']);
  });

  test('a descendant that extends past its own parent past the viewport also fires', () => {
    const page = createWidePage({ rect: createRect(0, 0, 1330, 40) });

    assert.deepEqual(getFindingTexts(page), ['div.row: past viewport end 14', 'a.more: past viewport end 50']);
  });

  test('clipped at the viewport does not fire', () => {
    const clip = { rect: createRect(0, 0, 1280, 800), clipperIndexX: null, clipperIndexY: null };

    assert.deepEqual(getFindingTexts(createWidePage({ clip }, { clip })), []);
  });

  test('inside a horizontal scroll container does not fire', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.scroller', rect: createRect(0, 0, 1280, 40), clipsChildren: { x: 'scroll', y: 'clip' } },
      { parentIndex: 1, name: 'div.track', rect: createRect(0, 0, 1294, 40) },
    ]);

    assert.deepEqual(getFindingTexts(page), []);
  });

  test('rtl pages measure past the left edge', () => {
    const page = createPage(
      [bodySpec, { parentIndex: 0, name: 'a.more', rect: createRect(-14, 0, 200, 40), isInFlow: false, position: 'absolute' }],
      { direction: 'rtl' },
    );

    assert.deepEqual(getFindingTexts(page), ['a.more: past viewport end 14']);
  });

  test('own text ink past the viewport counts, not only the box', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.hero', rect: createRect(0, 0, 1280, 60) },
      { parentIndex: 1, name: 'h1', rect: createRect(16, 0, 1248, 60), textInfo: createTextInfo(createRect(16, 0, 1414, 60)) },
    ]);

    assert.deepEqual(getFindingTexts(page), ['h1: text overflows end 166', 'h1: past viewport end 150']);
  });

  test('fixed nodes compare against the scrolled viewport', () => {
    const page = createPage(
      [bodySpec, { parentIndex: 0, name: 'header', rect: createRect(500, 0, 1280, 40), isViewportFrame: true, position: 'fixed', isInFlow: false }],
      { scroll: { x: 500, y: 0, maxX: 600, maxY: 0 } },
    );

    assert.deepEqual(getFindingTexts(page), []);
  });
});

describe('covered', () => {
  function createCoveredPage(options: { isControl?: boolean; covererSamples?: number; coverer?: Partial<NodeSpec> } = {}): PageMeasurement {
    const covererSamples = options.covererSamples ?? 3;

    return createPage([
      bodySpec,
      {
        parentIndex: 0,
        name: 'header.site',
        rect: createRect(0, 0, 1280, 64),
        position: 'fixed',
        isViewportFrame: true,
        isInFlow: false,
        ink: backgroundInk,
        ...options.coverer,
      },
      { parentIndex: 0, name: 'main', rect: createRect(0, 40, 1280, 400) },
      {
        parentIndex: 2,
        name: 'h2',
        rect: createRect(0, 40, 1280, 44),
        textInfo: createTextInfo(createRect(0, 40, 300, 44)),
        isControl: options.isControl ?? false,
        coverage: { sampleCount: 20, coveredSampleCount: covererSamples, coverers: [{ index: 1, sampleCount: covererSamples, isTranslucent: false }] },
      },
      {
        parentIndex: 3,
        name: 'span',
        rect: createRect(0, 40, 100, 44),
        textInfo: createTextInfo(createRect(0, 40, 100, 44)),
        coverage: { sampleCount: 5, coveredSampleCount: 2, coverers: [{ index: 1, sampleCount: 2, isTranslucent: false }] },
      },
    ]);
  }

  test('fires with a side, said once down a branch', () => {
    assert.deepEqual(getFindingTexts(createCoveredPage()), ['h2: covered top 24 by header.site']);
  });

  test('a coverer in the top layer fires like any other', () => {
    assert.deepEqual(getFindingTexts(createCoveredPage({ coverer: { topLayer: 'popover' } })), ['h2: covered top 24 by header.site']);
  });

  test('controls need 10% of samples', () => {
    assert.deepEqual(getFindingTexts(createCoveredPage({ isControl: true, covererSamples: 1 })), ['span: covered top 24 by header.site']);
    assert.deepEqual(getFindingTexts(createCoveredPage({ isControl: true, covererSamples: 2 })), ['h2: covered top 24 by header.site']);
  });

  test('partial overlap prints a percentage and translucency', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, name: 'p', rect: createRect(0, 100, 200, 100), textInfo: createTextInfo(createRect(0, 100, 200, 100)), coverage: {
        sampleCount: 40,
        coveredSampleCount: 16,
        coverers: [{ index: 2, sampleCount: 16, isTranslucent: true }],
      } },
      { parentIndex: 0, name: 'div.toast', rect: createRect(50, 120, 100, 80), position: 'absolute', isInFlow: false, ink: backgroundInk },
    ]);

    assert.deepEqual(getFindingTexts(page), ['p: covered 40% by div.toast (translucent)']);
  });

  function createAncestorCoverPage(ancestorInk: Ink): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.intro', rect: createRect(0, 0, 1280, 800), ink: ancestorInk },
      {
        parentIndex: 1,
        name: 'h1',
        rect: createRect(0, 100, 900, 60),
        textInfo: createTextInfo(createRect(0, 100, 900, 60)),
        coverage: { sampleCount: 20, coveredSampleCount: 20, coverers: [{ index: 1, sampleCount: 20, isTranslucent: false }] },
      },
    ]);
  }

  test('an ancestor above its own text fires', () => {
    assert.deepEqual(getFindingTexts(createAncestorCoverPage(backgroundInk)), ['h1: covered 100% by div.intro']);
  });

  test('an ancestor with pseudo ink does not fire, its pseudo-element geometry is unknown', () => {
    assert.deepEqual(getFindingTexts(createAncestorCoverPage(createInk({ hasBackgroundImage: true, pseudoInk: 'after' }))), []);
  });

  test('a coverer inside another coverer of the same node is dropped', () => {
    const page = createCoveredPage();
    const heading = page.nodes[3];

    page.nodes.push({ ...page.nodes[1], index: 5, parentIndex: 1, depth: 1, subtreeEnd: 5, name: 'a.logo', rect: createRect(0, 0, 80, 64) });
    page.nodes[1].subtreeEnd = 5;
    heading.coverage!.coverers.push({ index: 5, sampleCount: 2, isTranslucent: true });

    assert.deepEqual(getFindingTexts(page), ['h2: covered top 24 by header.site']);
  });

  test('summary text keeps the amount out', () => {
    const [finding] = analyze(createCoveredPage()).findings;

    assert.equal(finding.summaryText, 'covered top {n} by header.site');
    assert.equal(finding.amount, 24);
    assert.equal(finding.relatedIndex, 1);
  });
});

describe('overlaps', () => {
  function createOverlapPage(secondOverrides: Partial<NodeSpec> = {}, parentOverrides: Partial<NodeSpec> = {}): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.row', rect: createRect(0, 0, 1000, 600), ...parentOverrides },
      { parentIndex: 1, name: 'div.first', rect: createRect(0, 0, 200, 100), ink: backgroundInk },
      { parentIndex: 1, name: 'div.second', rect: createRect(150, 50, 200, 100), ink: backgroundInk, ...secondOverrides },
    ]);
  }

  test('fires on the later sibling with the intersection size', () => {
    const [finding] = analyze(createOverlapPage()).findings;

    assert.equal(finding.nodeIndex, 3);
    assert.equal(finding.text, 'overlaps div.first 50x50');
    assert.equal(finding.relatedIndex, 2);
  });

  test('absolute siblings count', () => {
    assert.deepEqual(getFindingTexts(createOverlapPage({ position: 'absolute', isInFlow: false })), ['div.second: overlaps div.first 50x50']);
  });

  test('exclusions do not fire', () => {
    const exclusions: Array<Partial<NodeSpec>> = [
      { position: 'fixed', isInFlow: false, isViewportFrame: true },
      { isFloat: true, isInFlow: false },
      { isInline: true },
      { ink: createInk() },
      { rect: createRect(10, 10, 100, 50) },
      { rect: createRect(199, 50, 200, 100) },
      { rect: createRect(150, 99, 200, 100) },
    ];

    for (const exclusion of exclusions) {
      assert.deepEqual(getFindingTexts(createOverlapPage(exclusion)), [], JSON.stringify(exclusion));
    }
  });

  test('replaced elements and borders count as box ink', () => {
    assert.equal(getFindingTexts(createOverlapPage({ ink: createInk({ replaced: 'img' }) })).length, 1);
    assert.equal(getFindingTexts(createOverlapPage({ ink: createInk({ borderSides: ['top'] }) })).length, 1);
  });

  test('rotated or scaled parent or ancestor does not fire', () => {
    assert.deepEqual(getFindingTexts(createOverlapPage({}, { rotateDegrees: 10 })), []);
    assert.deepEqual(getFindingTexts(createOverlapPage({}, { isInsideTransform: true })), []);
  });

  test('a pair already linked by covered does not repeat', () => {
    const page = createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.row', rect: createRect(0, 0, 1000, 600) },
      { parentIndex: 1, name: 'div.first', rect: createRect(0, 0, 200, 100), ink: backgroundInk },
      {
        parentIndex: 2,
        name: 'p',
        rect: createRect(0, 0, 200, 100),
        textInfo: createTextInfo(createRect(0, 0, 200, 100)),
        coverage: { sampleCount: 40, coveredSampleCount: 10, coverers: [{ index: 4, sampleCount: 10, isTranslucent: false }] },
      },
      { parentIndex: 1, name: 'div.second', rect: createRect(150, 50, 200, 100), ink: backgroundInk },
    ]);

    assert.deepEqual(getFindingTexts(page), ['p: covered 13% by div.second']);
  });

  function createAvatarPage(avatarStarts: number[]): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'div.avatars', rect: createRect(0, 0, 400, 40) },
      ...avatarStarts.map((start) => ({
        parentIndex: 1,
        name: 'img.avatar',
        rect: createRect(start, 0, 40, 40),
        ink: createInk({ replaced: 'img' }),
      })),
    ]);
  }

  test('a stack of equal overlaps fires on each overlapping sibling', () => {
    assert.deepEqual(getFindingTexts(createAvatarPage([0, 30, 60])), [
      'img.avatar: overlaps img.avatar 10x40',
      'img.avatar: overlaps img.avatar 10x40',
    ]);
  });

  test('a run with a different overlap fires', () => {
    assert.deepEqual(getFindingTexts(createAvatarPage([0, 30, 45])), [
      'img.avatar: overlaps img.avatar 10x40',
      'img.avatar: overlaps img.avatar 25x40',
    ]);
  });
});

describe('off-center', () => {
  function createButtonPage(buttonOverrides: Partial<NodeSpec> = {}, iconRect = createRect(8, 11, 24, 21)): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'button.menu', rect: createRect(0, 0, 40, 40), ink: backgroundInk, ...buttonOverrides },
      { parentIndex: 1, name: 'svg', rect: iconRect, ink: createInk({ replaced: 'svg' }) },
    ]);
  }

  test('fires on the block axis', () => {
    assert.deepEqual(getFindingTexts(createButtonPage()), ['button.menu: off center 3 down']);
  });

  test('fires on the inline axis in rtl', () => {
    const page = createButtonPage({ direction: 'rtl' }, createRect(4, 8, 24, 24));

    assert.deepEqual(getFindingTexts(page), ['button.menu: off center 8 end']);
  });

  test('does not fire', () => {
    const cases: Array<[Partial<NodeSpec>, Rect?]> = [
      [{ padding: [3, 0, 0, 0] }],
      [{ padding: [8, 8, 8, 8] }],
      [{ ink: createInk() }],
      [{ isInsideTransform: true }],
      [{ clipsChildren: { x: 'none', y: 'scroll' } }],
      [{}, createRect(8, -2, 24, 21)],
      [{}, createRect(8, 2, 24, 8)],
      [{ ink: createInk({ background: '#eeeeee', pseudoInk: 'after' }) }],
    ];

    for (const [buttonOverrides, iconRect] of cases) {
      const offCenterFindings = analyze(createButtonPage(buttonOverrides, iconRect)).findings.filter((finding) => finding.kind === 'off-center');

      assert.deepEqual(offCenterFindings, [], JSON.stringify(buttonOverrides));
    }
  });

  function createCardPage(headingMarginTop: number, paragraphMarginBottom: number): PageMeasurement {
    const headingTop = 16 + headingMarginTop;
    const paragraphBottom = 200 - 16 - paragraphMarginBottom;

    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'li.card', rect: createRect(0, 0, 200, 200), padding: [16, 16, 16, 16], ink: backgroundInk },
      { parentIndex: 1, name: 'h3', rect: createRect(16, headingTop, 168, 24), margin: [headingMarginTop, 0, 0, 0] },
      { parentIndex: 1, name: 'p', rect: createRect(16, headingTop + 24, 168, paragraphBottom - headingTop - 24), margin: [0, 0, paragraphMarginBottom, 0] },
    ]);
  }

  test('block free space is measured from the border boxes, so a margin that pushes the children down fires', () => {
    assert.deepEqual(getFindingTexts(createCardPage(20, 16)), ['li.card: off center 4 down']);
  });

  test('equal margins above and below do not fire', () => {
    assert.deepEqual(getFindingTexts(createCardPage(20, 20)), []);
  });

  test('children against one edge of the content box are past the upper bound', () => {
    const page = createCardPage(0, 48);
    page.nodes[3].margin = [0, 0, 0, 0];

    assert.deepEqual(getFindingTexts(page), []);
  });
});

describe('text off-center', () => {
  function createTextButtonPage(buttonOverrides: Partial<NodeSpec> = {}, textOverrides: Partial<TextInfo> = {}): PageMeasurement {
    return createPage([
      bodySpec,
      {
        parentIndex: 0,
        name: 'button.danger',
        rect: createRect(0, 0, 100, 40),
        padding: [8, 16, 8, 16],
        ink: backgroundInk,
        textInfo: createTextInfo(createRect(16, 8, 68, 24), { capTop: 16, baseline: 27, ...textOverrides }),
        ...buttonOverrides,
      },
    ]);
  }

  test('fires on low text', () => {
    assert.deepEqual(getFindingTexts(createTextButtonPage()), ['button.danger: text off center 3 down']);
  });

  test('does not fire', () => {
    assert.deepEqual(getFindingTexts(createTextButtonPage({ isInsideTransform: true })), []);
    assert.deepEqual(getFindingTexts(createTextButtonPage({ padding: [9, 16, 8, 16] })), []);
    assert.deepEqual(getFindingTexts(createTextButtonPage({}, { lineCount: 2 })), []);
    assert.deepEqual(getFindingTexts(createTextButtonPage({}, { capTop: 14, baseline: 27 })), []);
  });

  test('2 px from the font ascent and descent split does not fire', () => {
    assert.deepEqual(getFindingTexts(createTextButtonPage({}, { capTop: 15, baseline: 27 })), []);
  });

  test('one line at the top of a tall box does not fire', () => {
    const tallBox = { rect: createRect(0, 0, 100, 200) };

    assert.deepEqual(getFindingTexts(createTextButtonPage(tallBox, { capTop: 12, baseline: 24 })), []);
  });
});

describe('tops across siblings and wider', () => {
  function createCardRow(buttonTops: number[], cardWidths = buttonTops.map(() => 100), shouldAddPrice = false): PageMeasurement {
    const nodeSpecs: NodeSpec[] = [bodySpec, { parentIndex: 0, name: 'ul.cards', rect: createRect(0, 0, 1000, 200) }];

    buttonTops.forEach((buttonTop, position) => {
      const cardIndex = nodeSpecs.length;
      const cardStart = position * 120;

      nodeSpecs.push(
        { parentIndex: 1, name: 'li.card', rect: createRect(cardStart, 0, cardWidths[position], 200) },
        { parentIndex: cardIndex, name: 'a.button', rect: createRect(cardStart, buttonTop, 80, 20) },
        { parentIndex: cardIndex + 1, name: 'span', rect: createRect(cardStart, buttonTop, 40, 20) },
      );

      if (shouldAddPrice) {
        nodeSpecs.push({ parentIndex: cardIndex, name: 'span.price', rect: createRect(cardStart, buttonTop + 30, 60, 20) });
      }
    });

    return createPage(nodeSpecs);
  }

  test('tops across siblings fires once on the row parent', () => {
    assert.deepEqual(getFindingTexts(createCardRow([100, 100, 116])), ['ul.cards: a.button tops 100..116 across siblings']);
  });

  test('tops across siblings fires once per row when several descendants move', () => {
    const texts = getFindingTexts(createCardRow([100, 100, 116], undefined, true));

    assert.deepEqual(texts, ['ul.cards: a.button tops 100..116 across siblings']);
  });

  test('cousins pair by tag and position, not by full name', () => {
    const page = createCardRow([100, 124, 112]);
    page.nodes[6].name = 'a.button.button-primary';

    assert.deepEqual(getFindingTexts(page), ['ul.cards: a.button tops 100..124 across siblings']);
  });

  test('aligned cousins do not fire', () => {
    assert.deepEqual(getFindingTexts(createCardRow([100, 101, 100])), []);
  });

  test('wider fires on the odd one', () => {
    assert.deepEqual(getFindingTexts(createCardRow([100, 100, 100], [100, 100, 112])), ['li.card: 12 wider than li.card']);
  });

  test('wider does not fire without a shared width or with two siblings', () => {
    assert.deepEqual(getFindingTexts(createCardRow([100, 100, 100], [100, 108, 116])), []);
    assert.deepEqual(getFindingTexts(createCardRow([100, 100], [100, 112])), []);
  });

  test('a state class on one card does not split the row', () => {
    const page = createCardRow([100, 100, 116], [100, 100, 112]);
    page.nodes[8].name = 'li.card.featured';

    assert.deepEqual(getFindingTexts(page), [
      'ul.cards: a.button tops 100..116 across siblings',
      'li.card.featured: 12 wider than li.card',
    ]);
  });

  test('a card pushed down in its row fires with its own top, measured in the parent', () => {
    const page = createCardRow([100, 100, 100, 100]);
    page.nodes[8].name = 'li.card.alert';
    page.nodes[1].rect.height = 220;

    for (const index of [8, 9, 10]) {
      page.nodes[index].rect.y += 6;
    }

    assert.deepEqual(getFindingTexts(page), ['ul.cards: li.card tops 0..6 across siblings']);
  });

  test('siblings that share a center line do not fire', () => {
    const page = createCardRow([100, 100, 100]);
    page.nodes[8].rect = createRect(240, 10, 100, 180);
    page.nodes[9].rect.y += 10;
    page.nodes[10].rect.y += 10;

    assert.deepEqual(getFindingTexts(page), []);
  });

  test('wider does not fire inside a transform', () => {
    const page = createCardRow([100, 100, 100], [100, 100, 112]);
    page.nodes[8].isInsideTransform = true;

    assert.deepEqual(getFindingTexts(page), []);
  });
});

describe('sibling gaps', () => {
  function createList(gaps: number[]): PageMeasurement {
    const nodeSpecs: NodeSpec[] = [bodySpec, { parentIndex: 0, name: 'ul', rect: createRect(0, 0, 200, 400) }];
    let top = 0;

    nodeSpecs.push({ parentIndex: 1, name: 'li', rect: createRect(0, top, 200, 20) });

    for (const gap of gaps) {
      top += 20 + gap;
      nodeSpecs.push({ parentIndex: 1, name: 'li', rect: createRect(0, top, 200, 20) });
    }

    return createPage(nodeSpecs);
  }

  test('fires on the parent', () => {
    assert.deepEqual(getFindingTexts(createList([16, 16, 24, 16])), ['ul: gaps 16 16 24 16 between li']);
  });

  test('a class that fewer than half of the siblings carry does not split the run', () => {
    const page = createList([16, 28, 16, 16]);
    page.nodes[4].name = 'li.active';

    assert.deepEqual(getFindingTexts(page), ['ul: gaps 16 28 16 16 between li']);
  });

  test('a class that half of the siblings carry splits the run', () => {
    const page = createList([16, 28, 16]);
    page.nodes[4].name = 'li.active';
    page.nodes[5].name = 'li.active';

    assert.deepEqual(getFindingTexts(page), []);
  });

  test('even gaps or fewer than 3 gaps do not fire', () => {
    assert.deepEqual(getFindingTexts(createList([16, 16, 17, 16])), []);
    assert.deepEqual(getFindingTexts(createList([16, 24])), []);
  });
});

describe('text truncated', () => {
  function createTruncatedPage(truncation: TextInfo['truncation']): PageMeasurement {
    return createPage([
      bodySpec,
      {
        parentIndex: 0,
        name: 'p',
        rect: createRect(0, 0, 100, 20),
        clipsChildren: { x: 'clip', y: 'clip' },
        textInfo: createTextInfo(createRect(0, 0, 140, 20), { truncation }),
      },
    ]);
  }

  test('prints each kind', () => {
    assert.deepEqual(getFindingTexts(createTruncatedPage({ kind: 'ellipsis', hiddenPx: 40, clampLines: 0 })), ['p: text truncated ellipsis 40']);
    assert.deepEqual(getFindingTexts(createTruncatedPage({ kind: 'clamp', hiddenPx: 48, clampLines: 3 })), ['p: text clamped 3 lines']);
    assert.deepEqual(getFindingTexts(createTruncatedPage({ kind: 'cut', hiddenPx: 40, clampLines: 0 })), ['p: text cut 40']);
  });

  test('no truncation does not fire', () => {
    assert.deepEqual(getFindingTexts(createTruncatedPage(null)), []);
  });
});

describe('contrast', () => {
  function createContrastPage(textOverrides: Partial<TextInfo>, nodeOverrides: Partial<NodeSpec> = {}): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, name: 'p.meta', rect: createRect(0, 0, 200, 20), textInfo: createTextInfo(createRect(0, 0, 200, 20), textOverrides), ...nodeOverrides },
    ]);
  }

  test('ratio matches WCAG', () => {
    assert.equal(getContrastRatio('#000000', '#ffffff'), 21);
    assert.equal(Math.round(getContrastRatio('#767676', '#ffffff') * 100) / 100, 4.54);
  });

  test('fires below 4.5 and rounds down', () => {
    const [finding] = analyze(createContrastPage({ color: '#777777' })).findings;

    assert.equal(finding.text, 'contrast 4.4');
    assert.equal(finding.summaryText, 'contrast {n}');
    assert.equal(finding.textColor, '#777777');
  });

  test('does not fire', () => {
    assert.deepEqual(getFindingTexts(createContrastPage({ color: '#767676' })), []);
    assert.deepEqual(getFindingTexts(createContrastPage({ color: '#949494', isLarge: true })), []);
    assert.deepEqual(getFindingTexts(createContrastPage({ color: '#9ca3af', background: null })), []);
    assert.deepEqual(getFindingTexts(createContrastPage({ color: '#9ca3af' }, { isDisabled: true })), []);
  });

  test('large text needs 3', () => {
    assert.deepEqual(getFindingTexts(createContrastPage({ color: '#aaaaaa', isLarge: true })), ['p.meta: contrast 2.3']);
  });
});

describe('small target', () => {
  const neighborSpec: NodeSpec = { parentIndex: 0, tag: 'a', name: 'a.next', rect: createRect(20, 0, 100, 40), isInteractive: true };

  function createTargetPage(targetOverrides: Partial<NodeSpec>, neighborOverrides: Partial<NodeSpec> = {}): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, tag: 'button', name: 'button.close', rect: createRect(0, 0, 20, 20), isInteractive: true, ...targetOverrides },
      { ...neighborSpec, ...neighborOverrides },
    ]);
  }

  test('fires under 24 px next to another target', () => {
    assert.deepEqual(getFindingTexts(createTargetPage({})), ['button.close: small target 20x20']);
  });

  test('does not fire', () => {
    assert.deepEqual(getFindingTexts(createTargetPage({ rect: createRect(0, 0, 24, 24) }, { rect: createRect(24, 0, 100, 40) })), []);
    assert.deepEqual(getFindingTexts(createTargetPage({ tag: 'a', name: 'a', rect: createRect(0, 0, 60, 18), isInlineInText: true }, { rect: createRect(60, 0, 100, 40) })), []);
    assert.deepEqual(getFindingTexts(createTargetPage({ isInteractive: false })), []);
  });

  test('a spaced target passes: its 24 px circle touches no other target', () => {
    assert.deepEqual(getFindingTexts(createTargetPage({}, { rect: createRect(22, 0, 100, 40) })), []);
  });

  test('two undersized targets whose circles overlap both fire', () => {
    const page = createTargetPage({}, { tag: 'button', name: 'button.open', rect: createRect(23, 0, 20, 20) });

    assert.deepEqual(getFindingTexts(page), ['button.close: small target 20x20', 'button.open: small target 20x20']);
  });

  test('summary text keeps the size out', () => {
    const [finding] = analyze(createTargetPage({})).findings;

    assert.equal(finding.summaryText, 'small target {n}');
    assert.equal(finding.amount, 20);
  });

  function createLabelledCheckboxPage(labelRect: Rect): PageMeasurement {
    return createPage([
      bodySpec,
      { parentIndex: 0, tag: 'label', name: 'label', rect: labelRect, labelForIndex: 2 },
      { parentIndex: 1, tag: 'input', name: 'input', rect: createRect(4, 4, 13, 13), isInteractive: true, isControl: true, labelIndex: 1 },
      { ...neighborSpec, rect: createRect(4, 17, 100, 40) },
    ]);
  }

  test('a label of 24 px or more on both axes makes the target big enough', () => {
    assert.deepEqual(getFindingTexts(createLabelledCheckboxPage(createRect(0, 0, 120, 24))), []);
  });

  test('a small label does not help', () => {
    assert.deepEqual(getFindingTexts(createLabelledCheckboxPage(createRect(0, 0, 120, 20))), ['input: small target 13x13']);
  });
});

describe('images', () => {
  function createImagePage(imageOverrides: Partial<NonNullable<MeasuredNode['image']>>, nodeOverrides: Partial<NodeSpec> = {}, devicePixelRatio = 1): PageMeasurement {
    const image = { naturalWidth: 100, naturalHeight: 100, isComplete: true, hasSource: true, isVector: false, objectFit: 'fill', ...imageOverrides };

    return createPage(
      [bodySpec, { parentIndex: 0, tag: 'img', name: 'img', rect: createRect(0, 0, 100, 100), ink: createInk({ replaced: 'img' }), image, ...nodeOverrides }],
      { devicePixelRatio },
    );
  }

  test('image not loaded', () => {
    assert.deepEqual(getFindingTexts(createImagePage({ naturalWidth: 0, naturalHeight: 0 })), ['img: image not loaded']);
    assert.deepEqual(getFindingTexts(createImagePage({ naturalWidth: 0, naturalHeight: 0, isComplete: false })), []);
    assert.deepEqual(getFindingTexts(createImagePage({})), []);
  });

  test('image aspect', () => {
    assert.deepEqual(getFindingTexts(createImagePage({}, { rect: createRect(0, 0, 130, 100) })), ['img: image aspect 1.30 of natural', 'img: image upscaled 1.3']);
    assert.deepEqual(getFindingTexts(createImagePage({ objectFit: 'cover', naturalWidth: 400, naturalHeight: 400 }, { rect: createRect(0, 0, 130, 100) })), []);
    assert.deepEqual(getFindingTexts(createImagePage({ naturalWidth: 0, naturalHeight: 0, isComplete: false }, { rect: createRect(0, 0, 130, 100) })), []);
  });

  test('a spacer image of 2x2 or less gets no aspect or upscale finding', () => {
    assert.deepEqual(getFindingTexts(createImagePage({ naturalWidth: 1, naturalHeight: 1 }, { rect: createRect(0, 0, 14, 1) })), []);
  });

  test('image upscaled', () => {
    assert.deepEqual(getFindingTexts(createImagePage({ naturalWidth: 100, naturalHeight: 48 }, { rect: createRect(0, 0, 210, 100) })), ['img: image upscaled 2.1']);
    assert.deepEqual(getFindingTexts(createImagePage({}, {}, 2)), ['img: image upscaled 2.0']);
    assert.deepEqual(getFindingTexts(createImagePage({ isVector: true }, {}, 2)), []);
    assert.deepEqual(getFindingTexts(createImagePage({ naturalWidth: 200, naturalHeight: 200 }, {}, 2)), []);
  });
});

describe('scroll range', () => {
  function createScrollPage(contentSize: number): PageMeasurement {
    const scroll = { axes: [{ axis: 'y' as const, contentSize, visibleSize: 300, offset: 0 }], childCount: 3, childrenOutCount: 0 };

    return createPage([bodySpec, { parentIndex: 0, name: 'div.box', rect: createRect(0, 0, 200, 300), clipsChildren: { x: 'clip', y: 'scroll' }, scroll }]);
  }

  test('fires on a small excess', () => {
    assert.deepEqual(getFindingTexts(createScrollPage(303)), ['div.box: scroll range y 3']);
  });

  test('a real scroll does not fire', () => {
    assert.deepEqual(getFindingTexts(createScrollPage(568)), []);
  });
});

describe('ordering', () => {
  test('findings are sorted by node, then by the table order', () => {
    const page = createPage([
      bodySpec,
      {
        parentIndex: 0,
        tag: 'button',
        name: 'button',
        rect: createRect(0, 0, 20, 20),
        isInteractive: true,
        textInfo: createTextInfo(createRect(0, 0, 20, 20), { color: '#aaaaaa' }),
      },
      { parentIndex: 0, tag: 'a', name: 'a.next', rect: createRect(20, 0, 100, 40), isInteractive: true },
    ]);

    assert.deepEqual(getFindingTexts(page), ['button: contrast 2.3', 'button: small target 20x20']);
  });
});

describe('performance', () => {
  test('analyze runs under 200 ms on 20000 nodes with a 5000-child parent', () => {
    const nodeSpecs: NodeSpec[] = [{ ...bodySpec, rect: createRect(0, 0, 1280, 200000) }];

    nodeSpecs.push({ parentIndex: 0, name: 'ul.big', rect: createRect(0, 0, 1280, 100000) });

    for (let position = 0; position < 5000; position++) {
      nodeSpecs.push({ parentIndex: 1, name: 'li.item', rect: createRect(0, position * 19, 200, 20), ink: backgroundInk });
    }

    while (nodeSpecs.length < 20000) {
      const sectionIndex = nodeSpecs.length;
      const top = 100000 + sectionIndex * 30;

      nodeSpecs.push({ parentIndex: 0, name: 'section.card', rect: createRect(0, top, 600, 100), padding: [16, 16, 16, 16], ink: backgroundInk });
      nodeSpecs.push({
        parentIndex: sectionIndex,
        name: 'h3',
        rect: createRect(16, top + 16, 568, 24),
        textInfo: createTextInfo(createRect(16, top + 16, 300, 24)),
        textRuns: [{ rect: createRect(16, top + 16, 300, 24), afterChildCount: 0 }],
      });
      nodeSpecs.push({ parentIndex: sectionIndex, name: 'p', rect: createRect(16, top + 48, 568, 20), textInfo: createTextInfo(createRect(16, top + 48, 500, 20)) });
      nodeSpecs.push({ parentIndex: sectionIndex, tag: 'a', name: 'a.more', rect: createRect(16, top + 76, 80, 20), isInteractive: true });
    }

    const page = createPage(nodeSpecs.slice(0, 20000));
    const startTime = performance.now();
    const analysis = analyze(page);
    const elapsedMs = performance.now() - startTime;

    console.log(`analyze on ${page.nodes.length} nodes: ${elapsedMs.toFixed(1)} ms, ${analysis.findings.length} findings`);
    assert.equal(analysis.layouts.length, 20000);
    assert.ok(elapsedMs < 200, `analyze took ${elapsedMs} ms`);
  });
});
