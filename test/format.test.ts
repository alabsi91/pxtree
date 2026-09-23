import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createSnapshot, formatDiff, getNodePaths } from '../src/format/diff.ts';
import { format } from '../src/format/format.ts';
import type {
  Analysis,
  Finding,
  FindingKind,
  FormatOptions,
  Gaps,
  Ink,
  MeasuredNode,
  PageMeasurement,
  RunResult,
  Snapshot,
  TextInfo,
} from '../src/types.ts';

interface FindingSpec {
  kind: FindingKind;
  text: string;
  summaryText?: string;
  amount?: number;
  textColor?: string;
}

interface NodeSpec {
  name: string;
  size: [width: number, height: number];
  at?: [x: number, y: number];
  text?: string;
  node?: Partial<MeasuredNode>;
  ink?: Partial<Ink>;
  textInfo?: Partial<TextInfo>;
  gaps?: Partial<Gaps>;
  findings?: FindingSpec[];
  children?: NodeSpec[];
}

interface PageSpec {
  roots: NodeSpec[];
  page?: Partial<PageMeasurement>;
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

function createTextInfo(overrides: Partial<TextInfo>): TextInfo {
  return {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 400,
    lineCount: 1,
    inkRect: { x: 0, y: 0, width: 0, height: 0 },
    capTop: 0,
    baseline: 0,
    color: '#111111',
    background: '#ffffff',
    isLarge: false,
    truncation: null,
    ...overrides,
  };
}

function createTextSpec(fontSize: number, lineHeight: number, lineCount = 1): Partial<TextInfo> {
  return { fontSize, lineHeight, lineCount };
}

function createPaddingSpec(vertical: number, horizontal = vertical): Partial<MeasuredNode> {
  return { padding: [vertical, horizontal, vertical, horizontal] };
}

const background: Partial<Ink> = { background: '#ffffff' };
const allBorders: Partial<Ink> = { borderSides: ['top', 'right', 'bottom', 'left'], borderColor: '#dddddd' };

function createPage(spec: PageSpec): { page: PageMeasurement; analysis: Analysis } {
  const nodes: MeasuredNode[] = [];
  const analysis: Analysis = { layouts: [], findings: [] };
  const topLayerIndexes: number[] = [];
  const pageDirection = spec.page?.direction ?? 'ltr';

  function addNode(nodeSpec: NodeSpec, parentIndex: number, depth: number, parentX: number, parentY: number): void {
    const index = nodes.length;
    const [x, y] = nodeSpec.at ?? [0, 0];
    const [width, height] = nodeSpec.size;
    const hasText = nodeSpec.text !== undefined;
    const node: MeasuredNode = {
      index,
      parentIndex,
      depth,
      subtreeEnd: index,
      tag: nodeSpec.name.split(/[#.]/)[0],
      name: nodeSpec.name,
      text: nodeSpec.text ?? '',
      visibility: 'shown',
      clippedOutByIndex: null,
      skippedChildCount: 0,
      rect: { x: parentX + x, y: parentY + y, width, height },
      layoutWidth: width,
      layoutHeight: height,
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
      direction: pageDirection,
      border: [0, 0, 0, 0],
      padding: [0, 0, 0, 0],
      margin: [0, 0, 0, 0],
      clip: null,
      clipsChildren: { x: 'none', y: 'none' },
      scroll: null,
      ink: createInk({ hasText, ...nodeSpec.ink }),
      textInfo: nodeSpec.textInfo === undefined ? null : createTextInfo(nodeSpec.textInfo),
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
      ...nodeSpec.node,
    };
    const gaps: Gaps | null =
      nodeSpec.gaps === undefined
        ? null
        : { arrangement: 'stacked', gaps: [], columnGaps: [], freeStart: 0, freeEnd: 0, ...nodeSpec.gaps };

    nodes.push(node);
    analysis.layouts.push({ index, x, y, gaps });

    if (node.topLayer !== null) {
      topLayerIndexes.push(index);
    }

    for (const findingSpec of nodeSpec.findings ?? []) {
      const finding: Finding = {
        kind: findingSpec.kind,
        nodeIndex: index,
        text: findingSpec.text,
        summaryText: findingSpec.summaryText ?? findingSpec.text,
        amount: findingSpec.amount ?? null,
        relatedIndex: null,
        textColor: findingSpec.textColor ?? null,
      };

      analysis.findings.push(finding);
    }

    for (const childSpec of nodeSpec.children ?? []) {
      addNode(childSpec, index, depth + 1, node.rect.x, node.rect.y);
    }

    node.subtreeEnd = nodes.length - 1;
  }

  for (const rootSpec of spec.roots) {
    addNode(rootSpec, -1, 0, 0, 0);
  }

  const page: PageMeasurement = {
    url: 'http://localhost:5173/',
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
    page: { width: 1280, height: 800, paintedTo: 800 },
    devicePixelRatio: 1,
    direction: pageDirection,
    colorScheme: 'light',
    isScrollLocked: false,
    modalIndex: null,
    failedFontFamilies: [],
    isNodeCapReached: false,
    nodes,
    topLayerIndexes,
    element: null,
    sampling: { gridStep: 9, pointCount: 12000, isCapped: false },
    ...spec.page,
  };

  return { page, analysis };
}

function createRun(page: PageMeasurement, analysis: Analysis, overrides: Partial<RunResult> = {}): RunResult {
  return {
    viewport: { width: page.viewport.width, height: page.viewport.height },
    colorScheme: page.colorScheme,
    status: 200,
    settle: { stillMovingName: null },
    page,
    analysis,
    previousSnapshot: null,
    isCacheEnabled: false,
    screenshotPath: null,
    shouldIncludeChildren: true,
    ...overrides,
  };
}

function formatPage(spec: PageSpec, overrides: Partial<RunResult> = {}): string[] {
  const { page, analysis } = createPage(spec);

  return format({ target: page.url, runs: [createRun(page, analysis, overrides)], error: null }).split('\n');
}

function getTreeLines(reportLines: string[]): string[] {
  const bodyPosition = reportLines.findIndex((line) => line.startsWith('body') || line.startsWith('no element'));

  return reportLines.slice(bodyPosition);
}

function createSnapshotWith(page: PageMeasurement, analysis: Analysis, change: (snapshot: Snapshot) => void): Snapshot {
  const snapshot = createSnapshot(page, analysis);

  change(snapshot);

  return snapshot;
}

function createPlan(children: NodeSpec[], at: [number, number]): NodeSpec {
  return {
    name: 'li.plan',
    size: [325, 640],
    at,
    node: createPaddingSpec(32),
    gaps: { gaps: [16, 16] },
    ink: { ...background, ...allBorders, hasShadow: true },
    children,
  };
}

function createPlanChildren(noteWidth: number, findings: FindingSpec[] = []): NodeSpec[] {
  return [
    { name: 'h3', text: 'Starter', size: [261, 32], textInfo: createTextSpec(24, 32) },
    { name: 'p.price', text: '$9', size: [261, 56], at: [0, 48], textInfo: createTextSpec(48, 56) },
    { name: 'span.plan-note', text: 'billed yearly, cancel…', size: [noteWidth, 20], at: [0, 120], textInfo: createTextSpec(14, 20), findings },
  ];
}

function createSimplePageSpec(): PageSpec {
  const createNavLinkSpec = (label: string, width: number, x: number): NodeSpec => ({
    name: 'a',
    text: label,
    size: [width, 40],
    at: [x, 0],
    textInfo: createTextSpec(15, 40),
  });

  return {
    page: {
      scroll: { x: 0, y: 536, maxX: 0, maxY: 1450 },
      page: { width: 1280, height: 2250, paintedTo: 2210 },
    },
    roots: [
      {
        name: 'body',
        size: [1280, 2250],
        children: [
          {
            name: 'header.site',
            size: [1280, 64],
            node: { ...createPaddingSpec(12, 24), isViewportFrame: true, position: 'fixed', isInFlow: false },
            gaps: { arrangement: 'across', gaps: [48], freeEnd: 604 },
            ink: { ...background, borderSides: ['bottom'] },
            children: [
              { name: 'a.logo', text: 'Acme', size: [88, 40], textInfo: createTextSpec(20, 40) },
              {
                name: 'nav',
                size: [492, 40],
                at: [136, 0],
                gaps: { arrangement: 'across', gaps: [32, 32, 32, 32] },
                children: [
                  createNavLinkSpec('Features', 66, 0),
                  createNavLinkSpec('Pricing', 57, 98),
                  createNavLinkSpec('Customers', 84, 187),
                  createNavLinkSpec('Docs', 60, 303),
                  createNavLinkSpec('Changelog', 80, 395),
                ],
              },
            ],
          },
          {
            name: 'main',
            size: [1280, 2186],
            at: [0, 64],
            children: [
              {
                name: 'section.hero',
                size: [1280, 472],
                node: createPaddingSpec(96, 280),
                gaps: { gaps: [24, 24] },
                ink: background,
                children: [
                  { name: 'h1', text: 'Ship faster with fewer…', size: [720, 128], textInfo: createTextSpec(56, 64, 2) },
                  { name: 'p.lead', text: 'Measure every layout in…', size: [720, 56], at: [0, 152], textInfo: createTextSpec(18, 28, 2) },
                  {
                    name: 'div.actions',
                    size: [720, 48],
                    at: [0, 232],
                    gaps: { arrangement: 'across', gaps: [16], freeEnd: 404 },
                    children: [
                      {
                        name: 'a.btn.primary',
                        text: 'Start free',
                        size: [148, 48],
                        node: createPaddingSpec(12, 24),
                        textInfo: createTextSpec(16, 24),
                        ink: background,
                      },
                      {
                        name: 'a.btn',
                        text: 'Book a demo',
                        size: [152, 48],
                        at: [164, 0],
                        node: createPaddingSpec(12, 24),
                        textInfo: createTextSpec(16, 24),
                        ink: allBorders,
                      },
                    ],
                  },
                ],
              },
              {
                name: 'section#pricing',
                size: [1280, 812],
                at: [0, 472],
                node: createPaddingSpec(40, 120),
                gaps: { gaps: [48] },
                children: [
                  {
                    name: 'h2.section-title',
                    text: 'Pricing',
                    size: [1040, 44],
                    textInfo: createTextSpec(36, 44),
                    findings: [
                      { kind: 'covered', text: 'covered top 24 by header.site', summaryText: 'covered top {n} by header.site', amount: 24 },
                    ],
                  },
                  {
                    name: 'ul.plans',
                    size: [1040, 640],
                    at: [0, 92],
                    gaps: { arrangement: 'across', gaps: [32, 32] },
                    children: [
                      createPlan(
                        createPlanChildren(275, [
                          { kind: 'clipped', text: 'clipped right 14 by li.plan', summaryText: 'clipped right {n} by li.plan', amount: 14 },
                        ]),
                        [0, 0],
                      ),
                      createPlan(createPlanChildren(261), [357, 0]),
                      createPlan(createPlanChildren(261), [714, 0]),
                    ],
                  },
                ],
              },
              {
                name: 'footer',
                size: [1280, 96],
                at: [0, 1284],
                node: createPaddingSpec(24, 120),
                ink: { borderSides: ['top'] },
                children: [
                  {
                    name: 'p.meta',
                    text: '© 2026 Acme Inc.',
                    size: [1040, 20],
                    textInfo: createTextSpec(13, 20),
                    findings: [
                      { kind: 'contrast', text: 'contrast 2.8', summaryText: 'contrast {n}', amount: 2.8, textColor: '#9ca3af' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function createCard(heading: string, headingLines: number, linkText: string, linkWidth: number, at: [number, number], findings: FindingSpec[] = []): NodeSpec {
  const headingHeight = headingLines * 24;

  return {
    name: 'li.card',
    size: [358, 212 + headingHeight - 24],
    at,
    node: createPaddingSpec(16),
    gaps: { gaps: [8, 8] },
    ink: { ...background, ...allBorders },
    children: [
      { name: 'img', size: [326, 120], ink: { replaced: 'img' } },
      { name: 'h3', text: heading, size: [326, headingHeight], at: [0, 128], textInfo: createTextSpec(18, 24, headingLines) },
      { name: 'a.more', text: linkText, size: [linkWidth, 24], at: [0, 136 + headingHeight], textInfo: createTextSpec(15, 24), findings },
    ],
  };
}

function createRtlPageSpec(): PageSpec {
  const cards: NodeSpec[] = [
    createCard('سماعات لاسلكية', 1, 'عرض التفاصيل', 132, [0, 0]),
    createCard('ساعة ذكية بشاشة كبيرة…', 2, 'عرض التفاصيل الكاملة', 372, [0, 228], [
      { kind: 'past-viewport', text: 'past viewport end 14', summaryText: 'past viewport end {n}', amount: 14 },
    ]),
  ];

  for (let position = 2; position < 8; position++) {
    cards.push(createCard('منتج', position % 2 === 0 ? 1 : 2, 'عرض', 60, [0, position * 240]));
  }

  return {
    page: {
      viewport: { width: 390, height: 844 },
      colorScheme: 'dark',
      devicePixelRatio: 2,
      direction: 'rtl',
      scroll: { x: 0, y: 0, maxX: 14, maxY: 1210 },
      page: { width: 390, height: 2054, paintedTo: 2054 },
    },
    roots: [
      {
        name: 'body',
        size: [390, 2054],
        children: [
          {
            name: 'header.bar',
            size: [390, 56],
            node: { ...createPaddingSpec(8, 16), position: 'sticky', isStuck: true },
            gaps: { arrangement: 'across', gaps: [12], freeEnd: 262 },
            ink: background,
            children: [
              {
                name: 'button.menu',
                size: [40, 40],
                node: { isControl: true },
                ink: background,
                findings: [
                  { kind: 'off-center', text: 'off center 3 down', summaryText: 'off center {n} down', amount: 3 },
                ],
                children: [{ name: 'svg', size: [24, 21], at: [8, 11], ink: { replaced: 'svg' } }],
              },
              { name: 'a.brand', text: 'متجر', size: [44, 40], at: [52, 0], textInfo: createTextSpec(20, 40) },
            ],
          },
          {
            name: 'main',
            size: [390, 1998],
            at: [0, 56],
            node: createPaddingSpec(16),
            gaps: { gaps: [16] },
            children: [
              { name: 'h1', text: 'أحدث المنتجات', size: [358, 36], textInfo: createTextSpec(28, 36) },
              { name: 'ul.cards', size: [358, 1914], at: [0, 52], gaps: { gaps: [16] }, children: cards },
            ],
          },
        ],
      },
    ],
  };
}

function createModalPageSpec(): PageSpec {
  const hiddenPageNodes: NodeSpec[] = [];

  for (let position = 0; position < 214; position++) {
    hiddenPageNodes.push({ name: 'div', size: [1280, 8], at: [0, position * 8], node: { isInert: true } });
  }

  return {
    page: {
      scroll: { x: 0, y: 0, maxX: 0, maxY: 940 },
      page: { width: 1280, height: 1740, paintedTo: 1702 },
      isScrollLocked: true,
      modalIndex: 215,
    },
    roots: [
      { name: 'body', size: [1280, 1740], children: hiddenPageNodes },
      {
        name: 'dialog#confirm-delete',
        size: [480, 200],
        at: [400, 300],
        node: { ...createPaddingSpec(24), topLayer: 'modal', isViewportFrame: true, position: 'fixed', isInFlow: false },
        gaps: { gaps: [16, 16] },
        ink: { ...background, ...allBorders, hasShadow: true },
        children: [
          {
            name: 'div.head',
            size: [432, 32],
            gaps: { arrangement: 'across', gaps: [8] },
            children: [
              { name: 'h2', text: 'Delete project?', size: [404, 32], textInfo: createTextSpec(24, 32) },
              {
                name: 'button.close',
                size: [20, 20],
                at: [412, 6],
                node: { isControl: true, isInteractive: true },
              },
            ],
          },
          { name: 'p', text: 'This removes the project…', size: [432, 48], at: [0, 48], textInfo: createTextSpec(16, 24, 2) },
          {
            name: 'div.actions',
            size: [432, 40],
            at: [0, 112],
            gaps: { arrangement: 'across', gaps: [12], freeStart: 220 },
            children: [
              {
                name: 'button.ghost',
                text: 'Cancel',
                size: [96, 40],
                at: [220, 0],
                node: { ...createPaddingSpec(8, 16), isControl: true },
                textInfo: createTextSpec(16, 24),
                ink: allBorders,
              },
              {
                name: 'button.danger',
                text: 'Delete',
                size: [104, 40],
                at: [328, 0],
                node: { ...createPaddingSpec(8, 16), isControl: true },
                textInfo: createTextSpec(16, 24),
                ink: background,
                findings: [
                  { kind: 'text-off-center', text: 'text off center 3 down', summaryText: 'text off center {n} down', amount: 3 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('design examples', () => {
  test('5.2 simple page', () => {
    const { page, analysis } = createPage(createSimplePageSpec());
    const previousSnapshot = createSnapshotWith(page, analysis, (snapshot) => {
      snapshot.nodes['body>main>section#pricing>ul.plans>li.plan[0]>span.plan-note'].width = 261;
    });
    const run = createRun(page, analysis, { previousSnapshot, isCacheEnabled: true });
    const expected = `1280x800 light dpr 1 ltr scroll 536/1450 page 1280x2250 painted to 2210
since last run: 1 changed
  ~ body>main>section#pricing>ul.plans>li.plan[0]>span.plan-note 275x20 was 261x20
summary: 3 findings
  clipped right 14 by li.plan: span.plan-note
  covered top 24 by header.site: h2.section-title
  contrast 2.8, text #9ca3af: p.meta
body 1280x2250
  header.site 1280x64 [fixed][pad 12 24][gaps across 48, free 604 at end][renders background, border-bottom]
    a.logo "Acme" 88x40 [text 20/40]
    nav 492x40 @136,0 [gaps across 32]
      a "Features" 66x40 [text 15/40]
      …×4 similar a 57x40..84x40
  main 1280x2186 @0,64
    section.hero 1280x472 [pad 96 280][gaps 24][renders background]
      h1 "Ship faster with fewer…" 720x128 [text 56/64, 2 lines]
      p.lead "Measure every layout in…" 720x56 @0,152 [text 18/28, 2 lines]
      div.actions 720x48 @0,232 [gaps across 16, free 404 at end]
        a.btn.primary "Start free" 148x48 [pad 12 24][text 16/24][renders background]
        a.btn "Book a demo" 152x48 @164,0 [pad 12 24][text 16/24][renders border]
    section#pricing 1280x812 @0,472 [pad 40 120][gaps 48]
      h2.section-title "Pricing" 1040x44 [text 36/44][!! covered top 24 by header.site]
      ul.plans 1040x640 @0,92 [gaps across 32]
        li.plan 325x640 [pad 32][gaps 16][renders background, border, shadow]
          h3 "Starter" 261x32 [text 24/32]
          p.price "$9" 261x56 @0,48 [text 48/56]
          span.plan-note "billed yearly, cancel…" 275x20 @0,120 [text 14/20][!! clipped right 14 by li.plan]
        …×2 similar li.plan 325x640
    footer 1280x96 @0,1284 [pad 24 120][renders border-top]
      p.meta "© 2026 Acme Inc." 1040x20 [text 13/20][!! contrast 2.8]`;

    assert.equal(format({ target: page.url, runs: [run], error: null }), expected);
  });

  test('5.3 rtl page, mobile, dark', () => {
    const { page, analysis } = createPage(createRtlPageSpec());
    const previousSnapshot = createSnapshotWith(page, analysis, (snapshot) => {
      snapshot.nodes['body>main>ul.cards>li.card[1]'].height = 212;
      delete snapshot.nodes['body>main>ul.cards>li.card[1]>a.more'];
    });
    const run = createRun(page, analysis, { previousSnapshot, isCacheEnabled: true });
    const expected = `390x844 dark dpr 2 rtl (start is right) scroll 0/1210 page 390x2054 painted to 2054 sideways 14 by a.more
since last run: 1 changed, 1 new
  ~ body>main>ul.cards>li.card[1] 358x236 was 358x212
  + body>main>ul.cards>li.card[1]>a.more 372x24 [!! past viewport end 14]
summary: 2 findings
  past viewport end 14: a.more
  off center 3 down: button.menu
body 390x2054
  header.bar 390x56 [stuck][pad 8 16][gaps across 12, free 262 at end][renders background]
    button.menu 40x40 [renders background][!! off center 3 down]
      svg 24x21 @8,11 [renders image]
    a.brand "متجر" 44x40 @52,0 [text 20/40]
  main 390x1998 @0,56 [pad 16][gaps 16]
    h1 "أحدث المنتجات" 358x36 [text 28/36]
    ul.cards 358x1914 @0,52 [gaps 16]
      li.card 358x212 [pad 16][gaps 8][renders background, border]
        img 326x120 [renders image]
        h3 "سماعات لاسلكية" 326x24 @0,128 [text 18/24]
        a.more "عرض التفاصيل" 132x24 @0,160 [text 15/24]
      li.card 358x236 @0,228 [pad 16][gaps 8][renders background, border]
        img 326x120 [renders image]
        h3 "ساعة ذكية بشاشة كبيرة…" 326x48 @0,128 [text 18/24, 2 lines]
        a.more "عرض التفاصيل الكاملة" 372x24 @0,184 [text 15/24][!! past viewport end 14]
      …×6 similar li.card 358x212..358x236`;

    assert.equal(format({ target: page.url, runs: [run], error: null }), expected);
  });

  test('5.4 modal dialog open', () => {
    const { page, analysis } = createPage(createModalPageSpec());
    const previousSnapshot = createSnapshotWith(page, analysis, (snapshot) => {
      snapshot.nodes['dialog#confirm-delete>div.actions>button.danger'].width = 96;
    });
    const run = createRun(page, analysis, { previousSnapshot, isCacheEnabled: true });
    const expected = `1280x800 light dpr 1 ltr scroll 0/940 page 1280x1740 painted to 1702 scroll locked modal dialog#confirm-delete
since last run: 1 changed
  ~ dialog#confirm-delete>div.actions>button.danger 104x40 was 96x40
summary: 1 finding
  text off center 3 down: button.danger
body 1280x1740 [behind modal, 214 elements not printed]
dialog#confirm-delete 480x200 @400,300 [top layer modal][pad 24][gaps 16][renders background, border, shadow]
  div.head 432x32 [gaps across 8]
    h2 "Delete project?" 404x32 [text 24/32]
    button.close 20x20 @412,6 [renders control]
  p "This removes the project…" 432x48 @0,48 [text 16/24, 2 lines]
  div.actions 432x40 @0,112 [gaps across 12, free 220 at start]
    button.ghost "Cancel" 96x40 @220,0 [pad 8 16][text 16/24][renders border]
    button.danger "Delete" 104x40 @328,0 [pad 8 16][text 16/24][renders background][!! text off center 3 down]`;

    assert.equal(format({ target: page.url, runs: [run], error: null }), expected);
  });

  test('--element into the modal page prints the collapsed part normally', () => {
    const spec = createModalPageSpec();

    spec.page = { ...spec.page, element: { selector: 'div', matchedIndexes: [1], matchedCount: 1 } };

    const treeLines = getTreeLines(formatPage(spec));

    assert.deepEqual(treeLines, ['body 1280x1740', '  div 1280x8']);
  });
});

describe('folding', () => {
  const createItemSpec = (at: [number, number], findings: FindingSpec[] = []): NodeSpec => ({
    name: 'li.item',
    text: 'Item',
    size: [300, 40],
    at,
    textInfo: createTextSpec(16, 24),
    findings,
  });

  test('identical siblings print once with ×N', () => {
    const itemSpecs = [createItemSpec([0, 0]), createItemSpec([0, 40]), createItemSpec([0, 80])];
    const treeLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: itemSpecs }] }));

    assert.deepEqual(treeLines, ['body 1280x800', '  li.item "Item" 300x40 [text 16/24] ×3']);
  });

  test('two identical siblings fold, two different ones do not', () => {
    const different: NodeSpec = { name: 'li.item', size: [300, 50], at: [0, 40] };
    const identicalLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: [createItemSpec([0, 0]), createItemSpec([0, 40])] }] }));
    const differentLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: [createItemSpec([0, 0]), different] }] }));

    assert.equal(identicalLines[1], '  li.item "Item" 300x40 [text 16/24] ×2');
    assert.equal(differentLines.length, 3);
  });

  test('a finding inside an identical sibling stops the fold and similar folding keeps it', () => {
    const findings: FindingSpec[] = [{ kind: 'contrast', text: 'contrast 2.1', summaryText: 'contrast {n}', amount: 2.1, textColor: '#aaaaaa' }];
    const itemSpecs = [
      createItemSpec([0, 0]),
      createItemSpec([0, 40]),
      createItemSpec([0, 80], findings),
      createItemSpec([0, 120]),
      createItemSpec([0, 160]),
    ];
    const treeLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: itemSpecs }] }));

    assert.deepEqual(treeLines, [
      'body 1280x800',
      '  li.item "Item" 300x40 [text 16/24]',
      '  li.item "Item" 300x40 @0,80 [text 16/24][!! contrast 2.1]',
      '  …×3 similar li.item 300x40',
    ]);
  });

  test('a run of three with one finding prints the single leftover in full', () => {
    const findings: FindingSpec[] = [{ kind: 'image-not-loaded', text: 'image not loaded' }];
    const itemSpecs = [createItemSpec([0, 0]), createItemSpec([0, 40], findings), { ...createItemSpec([0, 80]), size: [300, 44] as [number, number] }];
    const treeLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: itemSpecs }] }));

    assert.equal(treeLines.length, 4);
    assert.ok(!treeLines.some((line) => line.includes('similar')));
  });

  test('wrapper chains print on the child line, over three names as first › … › last', () => {
    const link: NodeSpec = { name: 'a.link', text: 'Home', size: [100, 20], textInfo: createTextSpec(14, 20) };
    const createWrapperSpec = (name: string, child: NodeSpec, at: [number, number] = [0, 0]): NodeSpec => ({ name, size: [100, 20], at, children: [child] });
    const shortChain = createWrapperSpec('div.a', createWrapperSpec('div.b', link), [10, 20]);
    const longChain = createWrapperSpec('div.a', createWrapperSpec('div.b', createWrapperSpec('div.c', link)));
    const shortLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: [shortChain] }] }));
    const longLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: [longChain] }] }));

    assert.equal(shortLines[1], '  div.a › div.b › a.link "Home" 100x20 @10,20 [text 14/20]');
    assert.equal(longLines[1], '  div.a › … › a.link "Home" 100x20 [text 14/20]');
  });

  test('a wrapper with ink, tags or a different size is not folded', () => {
    const link: NodeSpec = { name: 'a.link', size: [100, 20] };
    const painted: NodeSpec = { name: 'div.painted', size: [100, 20], ink: background, children: [link] };
    const larger: NodeSpec = { name: 'div.larger', size: [100, 30], children: [link] };
    const treeLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: [painted, larger] }] }));

    assert.ok(!treeLines.some((line) => line.includes('›')));
  });

  test('a finding on the child keeps the chain and prints the finding', () => {
    const link: NodeSpec = {
      name: 'a.link',
      size: [10, 10],
      findings: [{ kind: 'small-target', text: 'small target 10x10' }],
    };
    const treeLines = getTreeLines(formatPage({ roots: [{ name: 'body', size: [1280, 800], children: [{ name: 'div.a', size: [10, 10], children: [link] }] }] }));

    assert.equal(treeLines[1], '  div.a › a.link 10x10 [!! small target 10x10]');
  });
});

describe('tags', () => {
  function formatNode(nodeSpec: NodeSpec, shouldShowColors = false): string {
    const { page, analysis } = createPage({ roots: [{ name: 'body', size: [1280, 800], children: [nodeSpec] }] });
    const output = format({ target: page.url, runs: [createRun(page, analysis)], error: null }, { shouldShowColors });

    return output.split('\n').find((line) => line.startsWith('  '))!.trim();
  }

  test('transform, scroll, padding shorthand and shadow tags in order', () => {
    const line = formatNode({
      name: 'div.box',
      size: [110, 60],
      node: {
        rotateDegrees: 30.4,
        layoutWidth: 100,
        layoutHeight: 20,
        padding: [1, 2, 3, 2],
        shadow: 'open',
        scroll: { axes: [{ axis: 'y', contentSize: 568, visibleSize: 300, offset: 120 }], childCount: 25, childrenOutCount: 15 },
      },
    });

    assert.equal(line, 'div.box 110x60 [rotated 30° from 100x20][scroll y 568 in 300 at 120, 15 of 25 out][pad 1 2 3][shadow root]');
  });

  test('a box over 100000 px on one axis says so', () => {
    assert.equal(formatNode({ name: 'div.list', size: [300, 120000] }), 'div.list 300x120000 [over 100000 px]');
  });

  test('colors print only with the option', () => {
    const nodeSpec: NodeSpec = {
      name: 'p',
      text: 'Hi',
      size: [100, 20],
      textInfo: { ...createTextSpec(16, 20), color: '#e6edf3', background: '#1e2530' },
      ink: { background: '#1e2530', ...allBorders, borderColor: '#3a4250' },
    };

    assert.equal(formatNode(nodeSpec), 'p "Hi" 100x20 [text 16/20][renders background, border]');
    assert.equal(formatNode(nodeSpec, true), 'p "Hi" 100x20 [text 16/20, #e6edf3 on #1e2530][renders background #1e2530, border #3a4250]');
  });

  test('pseudo ink names the pseudo-element that paints', () => {
    assert.equal(formatNode({ name: 'a', size: [100, 20], ink: { pseudoInk: 'before' } }), 'a 100x20 [renders ::before]');
    assert.equal(formatNode({ name: 'a', size: [100, 20], ink: { pseudoInk: 'after' } }), 'a 100x20 [renders ::after]');
    assert.equal(formatNode({ name: 'a', size: [100, 20], ink: { pseudoInk: 'both' } }), 'a 100x20 [renders ::before, ::after]');
  });

  test('unknown text background prints on image', () => {
    const line = formatNode({ name: 'p', text: 'Hi', size: [100, 20], textInfo: { ...createTextSpec(16, 20), background: null } });

    assert.equal(line, 'p "Hi" 100x20 [text 16/20, on image]');
  });

  test('unequal gaps list up to six values and grid gaps name both axes', () => {
    const unevenLine = formatNode({ name: 'ul', size: [100, 400], gaps: { gaps: [16, 16, 24, 16, 16, 16, 16] } });
    const gridLine = formatNode({ name: 'div.grid', size: [100, 400], gaps: { arrangement: 'grid', gaps: [24, 24], columnGaps: [16] } });

    assert.equal(unevenLine, 'ul 100x400 [gaps 16 16 24 16 16 16 …]');
    assert.equal(gridLine, 'div.grid 100x400 [gaps 24 across 16]');
  });

  test('a hidden node without shown descendants prints as one line', () => {
    const { page, analysis } = createPage({
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            {
              name: 'ul.menu',
              size: [200, 100],
              node: { visibility: 'unpainted-visibility' },
              children: [
                { name: 'li', size: [200, 50], node: { visibility: 'unpainted-visibility' } },
                { name: 'li', size: [200, 50], at: [0, 50], node: { visibility: 'unpainted-visibility' } },
              ],
            },
          ],
        },
      ],
    });
    const treeLines = format({ target: page.url, runs: [createRun(page, analysis)], error: null }).split('\n');

    assert.deepEqual(getTreeLines(treeLines), ['body 1280x800', '  ul.menu 200x100 [not painted: visibility hidden][children skipped 2]']);
  });

  test('page facts print in grammar order', () => {
    const { page, analysis } = createPage({
      page: {
        scroll: { x: 0, y: 0, maxX: 3, maxY: 0 },
        failedFontFamilies: ['Inter'],
        isNodeCapReached: true,
        sampling: { gridStep: 9, pointCount: 21000, isCapped: true },
      },
      roots: [{ name: 'body', size: [1280, 800] }],
    });
    const run = createRun(page, analysis, { status: 404, settle: { stillMovingName: 'div.spinner' } });
    const factsLine = format({ target: page.url, runs: [run], error: null }).split('\n')[0];

    assert.equal(
      factsLine,
      '1280x800 light dpr 1 ltr scroll 0/0 page 1280x800 painted to 800 status 404 sideways 3 still moving div.spinner font failed Inter coverage sampled partly stopped at 20000 elements',
    );
  });

  test('sideways names the widest past-viewport node, and a screenshot prints its path and pixel size last', () => {
    const createPastViewportFinding = (amount: number): FindingSpec => ({ kind: 'past-viewport', text: `past viewport end ${amount}`, summaryText: 'past viewport end {n}', amount });
    const { page, analysis } = createPage({
      page: { scroll: { x: 0, y: 0, maxX: 150, maxY: 0 }, devicePixelRatio: 2 },
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            { name: 'a.cta', size: [10, 10], findings: [createPastViewportFinding(42)] },
            { name: 'section#hero', size: [10, 10], children: [{ name: 'h1', size: [10, 10], findings: [createPastViewportFinding(150)] }] },
          ],
        },
      ],
    });
    const run = createRun(page, analysis, { screenshotPath: '/tmp/shot.png' });
    const factsLine = format({ target: page.url, runs: [run], error: null }).split('\n')[0];

    assert.equal(factsLine, '1280x800 light dpr 2 ltr scroll 0/0 page 1280x800 painted to 800 sideways 150 by section#hero h1 screenshot /tmp/shot.png 2560x1600');
  });

  test('translate, animation, role and clipped-children facts', () => {
    const { page, analysis } = createPage({
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            {
              name: 'div.viewport',
              size: [320, 120],
              node: { clipsChildren: { x: 'clip', y: 'clip' }, motionRole: 'carousel' },
              children: [
                {
                  name: 'ul.track',
                  size: [320, 120],
                  at: [-320, 0],
                  node: {
                    translate: { x: -320, y: 0 },
                    isAnimating: true,
                    clip: { rect: { x: 0, y: 0, width: 320, height: 120 }, clipperIndexX: 1, clipperIndexY: 1 },
                  },
                },
                { name: 'p', size: [100, 20] },
                { name: 'span.escaping', size: [100, 20], at: [0, 130], node: { position: 'absolute', isInFlow: false } },
              ],
            },
          ],
        },
      ],
    });
    const reportLines = format({ target: page.url, runs: [createRun(page, analysis)], error: null }).split('\n');

    assert.ok(reportLines.includes('  div.viewport 320x120 [role carousel][clips 1 of 3 children]'), reportLines.join('\n'));
    assert.ok(reportLines.includes('    ul.track 320x120 @-320,0 [translated x -320][animating]'), reportLines.join('\n'));
  });

  test('a clipped-out node with a clipped finding prints the finding instead of the tag', () => {
    const reportLines = formatPage({
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            {
              name: 'label',
              size: [100, 20],
              node: { visibility: 'clipped-out', clippedOutByIndex: 0 },
              findings: [{ kind: 'clipped', text: 'clipped out by body' }],
            },
          ],
        },
      ],
    });

    assert.equal(reportLines.at(-1), '  label 100x20 [!! clipped out by body]');
  });
});

describe('summary', () => {
  test('groups by summary text with ranges, three names and +N, contrast by text color', () => {
    const createClippedFinding = (amount: number): FindingSpec => ({
      kind: 'clipped',
      text: `clipped right ${amount} by li.plan`,
      summaryText: 'clipped right {n} by li.plan',
      amount,
    });
    const createContrastFinding = (amount: number, textColor: string): FindingSpec => ({
      kind: 'contrast',
      text: `contrast ${amount}`,
      summaryText: 'contrast {n}',
      amount,
      textColor,
    });
    const reportLines = formatPage({
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            { name: 'p.meta', size: [10, 10], findings: [createContrastFinding(2.8, '#9ca3af')] },
            { name: 'span.a', size: [10, 10], findings: [createClippedFinding(18)] },
            { name: 'span.b', size: [10, 10], findings: [createClippedFinding(12)] },
            { name: 'a.more', size: [10, 10], findings: [createClippedFinding(14)] },
            { name: 'span.c', size: [10, 10], findings: [createClippedFinding(12)] },
            { name: 'span.date', size: [10, 10], findings: [createContrastFinding(2.6, '#9ca3af')] },
            { name: 'span.dim', size: [10, 10], findings: [createContrastFinding(3.1, '#777777')] },
          ],
        },
      ],
    });

    assert.deepEqual(reportLines.slice(1, 5), [
      'summary: 7 findings',
      '  clipped right 12..18 by li.plan ×4: span.a, span.b, a.more +1',
      '  contrast 2.6..2.8 ×2, text #9ca3af: p.meta, span.date',
      '  contrast 3.1, text #777777: span.dim',
    ]);
  });

  test('a bare or utility-only name gets the nearest uniquely named ancestor in front', () => {
    const contrast: FindingSpec = { kind: 'contrast', text: 'contrast 2.1', summaryText: 'contrast {n}', amount: 2.1, textColor: '#4a4f58' };
    const utilityItems: NodeSpec[] = Array.from({ length: 10 }, () => ({ name: 'li.flex', size: [10, 10] }));
    const reportLines = formatPage({
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            { name: 'div.column', size: [10, 10], children: [{ name: 'ul', size: [10, 10], children: [{ name: 'li', size: [10, 10] }] }] },
            { name: 'div.column', size: [10, 10], children: [{ name: 'ul', size: [10, 10], children: [{ name: 'li', size: [10, 10] }] }] },
            {
              name: 'div.footer-legal',
              size: [10, 10],
              children: [{ name: 'ul', size: [10, 10], children: [{ name: 'li', size: [10, 10], findings: [contrast] }, ...utilityItems.slice(0, 1).map((item) => ({ ...item, findings: [contrast] }))] }],
            },
            { name: 'ul', size: [10, 10], children: utilityItems.slice(1) },
          ],
        },
      ],
    });

    assert.equal(reportLines[2], '  contrast 2.1 ×2, text #4a4f58: div.footer-legal li, div.footer-legal li.flex');
  });

  test('no findings', () => {
    const reportLines = formatPage({ roots: [{ name: 'body', size: [1280, 800] }] });

    assert.equal(reportLines[1], 'summary: no findings');
  });
});

describe('report detail', () => {
  function formatWithDetail(formatOptions: FormatOptions): string[] {
    const pastViewport: FindingSpec = { kind: 'past-viewport', text: 'past viewport end 42', summaryText: 'past viewport end {n}', amount: 42 };
    const { page, analysis } = createPage({
      roots: [{ name: 'body', size: [1280, 800], children: [{ name: 'a.cta', size: [10, 10], findings: [pastViewport] }] }],
    });
    const run = createRun(page, analysis, { isCacheEnabled: true });

    return format({ target: page.url, runs: [run, run], error: null }, formatOptions).split('\n');
  }

  test('summary prints the facts line, since last run and the summary, and no tree', () => {
    const reportLines = formatWithDetail({ isSummaryOnly: true });

    assert.deepEqual(reportLines.slice(1, 4), ['since last run: first run', 'summary: 1 finding', '  past viewport end 42: a.cta']);
    assert.ok(!reportLines.some((line) => line.startsWith('body') || line.startsWith('tree:')), reportLines.join('\n'));
  });

  test('changes prints only the facts line and since last run', () => {
    const reportLines = formatWithDetail({ isSummaryOnly: true, isChangesOnly: true });

    assert.equal(reportLines.length, 5, reportLines.join('\n'));
    assert.deepEqual([reportLines[1], reportLines[2], reportLines[4]], ['since last run: first run', '', 'since last run: first run']);
  });
});

describe('--element', () => {
  function createElementSpec(matchedIndexes: number[], matchedCount = matchedIndexes.length): PageSpec {
    return {
      page: { element: { selector: '.card', matchedIndexes, matchedCount } },
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            { name: 'header', size: [1280, 64], ink: background, children: [{ name: 'a.logo', size: [80, 40] }] },
            {
              name: 'main',
              size: [1280, 600],
              at: [0, 64],
              children: [
                { name: 'h1', size: [1280, 40] },
                {
                  name: 'div.card',
                  size: [300, 200],
                  at: [0, 60],
                  ink: background,
                  findings: [{ kind: 'wider', text: '12 wider than div.card', summaryText: '{n} wider than div.card', amount: 12 }],
                  children: [
                    { name: 'h3', size: [300, 30] },
                    { name: 'p', size: [300, 60], at: [0, 40] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  test('prints the match under its ancestors with its children', () => {
    const treeLines = getTreeLines(formatPage(createElementSpec([5])));

    assert.deepEqual(treeLines, [
      'body 1280x800',
      '  main 1280x600 @0,64',
      '    div.card 300x200 @0,60 [renders background][!! 12 wider than div.card]',
      '      h3 300x30',
      '      p 300x60 @0,40',
    ]);
  });

  test('--no-children drops the inside of the match', () => {
    const treeLines = getTreeLines(formatPage(createElementSpec([5]), { shouldIncludeChildren: false }));

    assert.deepEqual(treeLines, ['body 1280x800', '  main 1280x600 @0,64', '    div.card 300x200 @0,60 [renders background][!! 12 wider than div.card]']);
  });

  test('no match and matches without a box', () => {
    const noMatchLines = formatPage(createElementSpec([], 0));
    const partlyRenderedLines = formatPage(createElementSpec([5], 3), { shouldIncludeChildren: false });

    assert.equal(noMatchLines[noMatchLines.length - 1], 'no element matches .card');
    assert.ok(partlyRenderedLines.includes('.card: 3 matched, 2 not rendered'));
    assert.ok(partlyRenderedLines.includes('    div.card 300x200 @0,60 [renders background][!! 12 wider than div.card]'));
  });

  test('summary stays page-wide', () => {
    const reportLines = formatPage(createElementSpec([2]));

    assert.ok(reportLines.includes('  12 wider than div.card: div.card'));
  });
});

describe('since last run', () => {
  function createListPage(itemCount: number, itemHeight = 20): { page: PageMeasurement; analysis: Analysis } {
    const listItemSpecs: NodeSpec[] = [];

    for (let position = 0; position < itemCount; position++) {
      listItemSpecs.push({ name: 'li', size: [100, itemHeight], at: [0, position * itemHeight], children: [{ name: 'span', size: [50, 10] }] });
    }

    return createPage({ roots: [{ name: 'body', size: [1280, 800], children: [{ name: 'ul', size: [100, 400], children: listItemSpecs }] }] });
  }

  test('node paths index repeated names and start top-layer roots fresh', () => {
    const { page } = createPage(createModalPageSpec());
    const nodePaths = getNodePaths(page);

    assert.equal(nodePaths[0], 'body');
    assert.equal(nodePaths[1], 'body>div[0]');
    assert.equal(nodePaths[214], 'body>div[213]');
    assert.equal(nodePaths[215], 'dialog#confirm-delete');
    assert.equal(nodePaths[217], 'dialog#confirm-delete>div.head>h2');
  });

  test('first run, no changes, cache off', () => {
    const { page, analysis } = createListPage(2);
    const snapshot = createSnapshot(page, analysis);

    assert.deepEqual(formatDiff(null, snapshot, true), ['since last run: first run']);
    assert.deepEqual(formatDiff(snapshot, createSnapshot(page, analysis), true), ['since last run: no changes']);
    assert.deepEqual(formatDiff(null, snapshot, false), []);
  });

  test('new and gone nodes hide their descendants', () => {
    const twoItems = createListPage(2);
    const previous = createSnapshot(twoItems.page, twoItems.analysis);
    const threeItems = createListPage(3);
    const oneItem = createListPage(1);

    assert.deepEqual(formatDiff(previous, createSnapshot(threeItems.page, threeItems.analysis), true), [
      'since last run: 1 new',
      '  + body>ul>li[2] 100x20',
    ]);
    assert.deepEqual(formatDiff(previous, createSnapshot(oneItem.page, oneItem.analysis), true), [
      'since last run: 1 new, 2 gone',
      '  - body>ul>li[0] 100x20',
      '  - body>ul>li[1] 100x20',
      '  + body>ul>li 100x20',
    ]);
  });

  test('pure moves that share one delta print as one line, in document order', () => {
    const previous: Snapshot = {
      version: 1,
      nodes: {
        'body': { width: 390, height: 900, x: 0, y: 0, tags: '', findings: [] },
        'body>h1': { width: 358, height: 44, x: 0, y: 0, tags: '', findings: ['text overflows end 166'] },
        'body>p': { width: 358, height: 60, x: 0, y: 64, tags: '', findings: [] },
        'body>section.pricing': { width: 390, height: 400, x: 0, y: 140, tags: '', findings: [] },
        'body>footer': { width: 390, height: 100, x: 0, y: 540, tags: '', findings: [] },
      },
    };
    const current: Snapshot = {
      version: 1,
      nodes: {
        'body': { width: 390, height: 944, x: 0, y: 0, tags: '', findings: [] },
        'body>h1': { width: 358, height: 88, x: 0, y: 0, tags: '', findings: [] },
        'body>p': { width: 358, height: 60, x: 0, y: 108, tags: '', findings: [] },
        'body>section.pricing': { width: 390, height: 400, x: 0, y: 184, tags: '', findings: [] },
        'body>footer': { width: 390, height: 100, x: 0, y: 584, tags: '', findings: [] },
      },
    };

    assert.deepEqual(formatDiff(previous, current, true), [
      'since last run: 5 changed',
      '  ~ body 390x944 was 390x900',
      '  ~ body>h1 358x88 was 358x44, findings gone: text overflows end 166',
      '  ~ 3 boxes from body>p down moved 44 down',
    ]);
  });

  test('changes describe size, position, tags and findings', () => {
    const previous: Snapshot = {
      version: 1,
      nodes: { body: { width: 100, height: 20, x: 0, y: 0, tags: '[pad 8] [stuck]', findings: ['contrast 2.1'] } },
    };
    const current: Snapshot = {
      version: 1,
      nodes: { body: { width: 110, height: 20, x: 0, y: 4, tags: '[pad 8] [fixed]', findings: [] } },
    };

    assert.deepEqual(formatDiff(previous, current, true), [
      'since last run: 1 changed',
      '  ~ body 110x20 was 100x20, @0,4 was @0,0, [fixed] was [stuck], findings gone: contrast 2.1',
    ]);
  });

  test('caps at 20 lines in document order', () => {
    const shortItems = createListPage(25, 20);
    const tallItems = createListPage(25, 30);
    const diffLines = formatDiff(createSnapshot(shortItems.page, shortItems.analysis), createSnapshot(tallItems.page, tallItems.analysis), true);

    assert.equal(diffLines[0], 'since last run: 25 changed');
    assert.equal(diffLines.length, 22);
    assert.equal(diffLines[1], '  ~ body>ul>li[0] 100x30 was 100x20');
    assert.equal(diffLines[2], '  ~ body>ul>li[1] 100x30 was 100x20, @0,30 was @0,20');
    assert.equal(diffLines[21], '  … 5 more');
  });
});

describe('across runs', () => {
  test('one run prints no across block', () => {
    const reportLines = formatPage({ roots: [{ name: 'body', size: [1280, 800] }] });

    assert.ok(!reportLines.includes('across runs:'));
  });

  test('two runs list findings that only some runs have', () => {
    const createSpec = (hasPastViewport: boolean): PageSpec => ({
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            {
              name: 'a.more',
              size: [10, 10],
              findings: [
                { kind: 'small-target', text: 'small target 10x10' },
                ...(hasPastViewport ? [{ kind: 'past-viewport' as const, text: 'past viewport end 14', summaryText: 'past viewport end {n}', amount: 14 }] : []),
              ],
            },
          ],
        },
      ],
    });
    const mobile = createPage(createSpec(true));
    const desktop = createPage(createSpec(false));
    const runs = [
      createRun(mobile.page, mobile.analysis, { viewport: { width: 390, height: 844 } }),
      createRun(desktop.page, desktop.analysis, { colorScheme: 'dark' }),
    ];
    const output = format({ target: mobile.page.url, runs, error: null });
    const runBlocks = output.split('\n\n');

    assert.equal(runBlocks.length, 3);
    assert.equal(runBlocks[2], 'across runs:\n  390x844 light only: a.more past viewport end 14\n  all runs: 1 finding shared');
  });

  test('a second scheme with the same tree prints only the lines whose findings differ', () => {
    const createSpec = (hasContrast: boolean): PageSpec => ({
      roots: [
        {
          name: 'body',
          size: [1280, 800],
          children: [
            { name: 'h1', text: 'Title', size: [300, 40] },
            { name: 'li', text: 'Privacy', size: [100, 20], at: [0, 40], findings: hasContrast ? [{ kind: 'contrast', text: 'contrast 2.1' }] : [] },
          ],
        },
      ],
    });
    const light = createPage(createSpec(false));
    const dark = createPage({ ...createSpec(true), page: { colorScheme: 'dark' } });
    const runs = [createRun(light.page, light.analysis), createRun(dark.page, dark.analysis)];
    const runBlocks = format({ target: light.page.url, runs, error: null }).split('\n\n');

    assert.equal(runBlocks[1], [
      '1280x800 dark dpr 1 ltr scroll 0/0 page 1280x800 painted to 800',
      'summary: 1 finding',
      '  contrast 2.1: li',
      'tree: same as light, differences:',
      '  li "Privacy" 100x20 @0,40 [!! contrast 2.1]',
    ].join('\n'));
  });

  test('a second scheme whose tree differs prints in full', () => {
    const light = createPage({ roots: [{ name: 'body', size: [1280, 800] }] });
    const dark = createPage({ roots: [{ name: 'body', size: [1280, 900] }], page: { colorScheme: 'dark' } });
    const runs = [createRun(light.page, light.analysis), createRun(dark.page, dark.analysis)];
    const runBlocks = format({ target: light.page.url, runs, error: null }).split('\n\n');

    assert.equal(runBlocks[1].split('\n').at(-1), 'body 1280x900');
  });

  test('runs with the same findings print no across block', () => {
    const spec: PageSpec = {
      roots: [{ name: 'body', size: [1280, 800], children: [{ name: 'a.more', size: [10, 10], findings: [{ kind: 'small-target', text: 'small target 10x10' }] }] }],
    };
    const mobile = createPage(spec);
    const desktop = createPage(spec);
    const runs = [
      createRun(mobile.page, mobile.analysis, { viewport: { width: 390, height: 844 } }),
      createRun(desktop.page, desktop.analysis),
    ];

    assert.ok(!format({ target: mobile.page.url, runs, error: null }).includes('across runs:'));
  });
});
