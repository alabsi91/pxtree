// ---------- measured in the page ----------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Sides = [top: number, right: number, bottom: number, left: number];

export type Visibility =
  | 'shown'
  | 'unpainted-opacity'
  | 'unpainted-visibility'
  | 'content-skipped'
  | 'sr-only'
  | 'clipped-out'
  | 'offscreen';

export interface MeasurePageOptions {
  elementSelector: string | null;
  maxNodes: number;
  maxSamples: number;
}

export interface PageMeasurement {
  /** The page URL after redirects. */
  url: string;
  /** documentElement.clientWidth and innerHeight. */
  viewport: { width: number; height: number };
  /** Window scroll and its maximum on both axes. */
  scroll: { x: number; y: number; maxX: number; maxY: number };
  /** Scroll size of the page, and the bottom of the lowest painted box. */
  page: { width: number; height: number; paintedTo: number };
  devicePixelRatio: number;
  /** Direction of the root element. */
  direction: 'ltr' | 'rtl';
  /** The prefers-color-scheme value that the page saw. */
  colorScheme: 'light' | 'dark';
  /** True when the root scroller hides its vertical overflow. */
  isScrollLocked: boolean;
  /** Node index of the open :modal or :fullscreen root. null when there is none. */
  modalIndex: number | null;
  /** Font families that failed to load. */
  failedFontFamilies: string[];
  /** True when the walk stopped at the node limit. */
  isNodeCapReached: boolean;
  /** Nodes in preorder. nodes[0] is body. Top-layer roots follow the body subtree. */
  nodes: MeasuredNode[];
  /** Node indexes of the top-layer roots. */
  topLayerIndexes: number[];
  /** The selector matches. Set only when an element selector was given. */
  element: ElementMatch | null;
  /** The grid that coverage sampling used. */
  sampling: { gridStep: number; pointCount: number; isCapped: boolean };
}

export interface ElementMatch {
  /** The selector as given. */
  selector: string;
  /** Node indexes of the matches that were measured. */
  matchedIndexes: number[];
  /** Every match, including the ones without a box. */
  matchedCount: number;
}

export interface MeasuredNode {
  /** Position in PageMeasurement.nodes. */
  index: number;
  /** -1 for body and top-layer roots. */
  parentIndex: number;
  depth: number;
  /** Index of the last descendant. A node d is a descendant when index < d <= subtreeEnd. */
  subtreeEnd: number;
  tag: string;
  /** `tag#id.class1.class2`, see docs/DESIGN.md section 4.11. */
  name: string;
  /** Preview of the node's own text. '' when it has none. */
  text: string;
  visibility: Visibility;
  /** Node index of the clipper when visibility is 'clipped-out'. */
  clippedOutByIndex: number | null;
  /** Children that were not walked. */
  skippedChildCount: number;
  /** Visual border box in document coordinates. */
  rect: Rect;
  /** offsetWidth, before transforms. */
  layoutWidth: number;
  /** offsetHeight, before transforms. */
  layoutHeight: number;
  /** 0 when not rotated. */
  rotateDegrees: number;
  /** 1 when not scaled. */
  scale: number;
  /** Own transform when it only translates. null when it does not move the node or when it also rotates or scales. */
  translate: { x: number; y: number } | null;
  /** True when an ancestor rotates or scales. */
  isInsideTransform: boolean;
  /** True when a running animation, an infinite one that settling paused, or a scroll-driven one targets the node. */
  isAnimating: boolean;
  /** Taken from role or aria-roledescription. */
  motionRole: 'carousel' | 'marquee' | null;
  position: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
  /** Fixed to the viewport, or a top-layer root. */
  isViewportFrame: boolean;
  /** A sticky node that sits away from its flow position. */
  isStuck: boolean;
  isFloat: boolean;
  /** Not absolute, fixed or float. */
  isInFlow: boolean;
  /** The outer display is inline. */
  isInline: boolean;
  /** Computed display, like 'inline', 'inline-block' or 'flex'. */
  display: string;
  direction: 'ltr' | 'rtl';
  border: Sides;
  padding: Sides;
  margin: Sides;
  /**
   * Intersected ancestor clips that apply to this node. A clipper index is null when the viewport clips that axis.
   * null when nothing clips the node.
   */
  clip: { rect: Rect; clipperIndexX: number | null; clipperIndexY: number | null } | null;
  /** What the node does with overflowing children on each axis. */
  clipsChildren: { x: 'none' | 'clip' | 'scroll'; y: 'none' | 'clip' | 'scroll' };
  /** Set for a scroll container that has something to scroll. */
  scroll: ScrollInfo | null;
  /** What the node paints. */
  ink: Ink;
  /** Set when the node has its own text. */
  textInfo: TextInfo | null;
  /** Own text nodes, for gaps and centering. */
  textRuns: TextRun[];
  /** Set for img and video. */
  image: ImageInfo | null;
  /** input, select, textarea, button, progress or meter. */
  isControl: boolean;
  /** A link, a form control or an element with an interactive role. */
  isInteractive: boolean;
  isDisabled: boolean;
  /** An inline element with sibling text in the same parent. */
  isInlineInText: boolean;
  isInert: boolean;
  /** Set for a top-layer root. */
  topLayer: 'modal' | 'popover' | 'fullscreen' | null;
  /** Set when this node hosts a walked shadow root. */
  shadow: 'open' | 'closed' | null;
  isSlotted: boolean;
  /** iframe, frame, object or embed. */
  isFrame: boolean;
  /** For a label, the node index of its control. */
  labelForIndex: number | null;
  /** For a labelable control, the node index of the label that wraps it or names it with `for`. */
  labelIndex: number | null;
  /** Set only for text and controls in the viewport. */
  coverage: Coverage | null;
}

export interface TextRun {
  /** Union of the text node's rects. */
  rect: Rect;
  /** How many element children come before it. */
  afterChildCount: number;
}

export interface ScrollAxis {
  axis: 'x' | 'y';
  contentSize: number;
  visibleSize: number;
  offset: number;
}

export interface ScrollInfo {
  axes: ScrollAxis[];
  childCount: number;
  childrenOutCount: number;
}

export interface Ink {
  /** '#rrggbb' or '#rrggbbaa'. null when the background is transparent. */
  background: string | null;
  hasBackgroundImage: boolean;
  /** Border sides that paint. */
  borderSides: Array<'top' | 'right' | 'bottom' | 'left'>;
  /** Color of the first painted side. */
  borderColor: string | null;
  hasShadow: boolean;
  hasOutline: boolean;
  /** The replaced element that the node is. */
  replaced: 'img' | 'svg' | 'video' | 'canvas' | 'iframe' | 'object' | 'embed' | 'math' | null;
  /** The pseudo-elements that paint. */
  pseudoInk: 'before' | 'after' | 'both' | null;
  hasText: boolean;
  /** Opacity of the node times that of its ancestors. */
  opacity: number;
}

export interface TextInfo {
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  /** Lines of the node's own text and in-flow inline descendants. */
  lineCount: number;
  /** Union of the own text rects. */
  inkRect: Rect;
  /** Top of the capital letters on the first line. */
  capTop: number;
  /** Baseline of the first line. */
  baseline: number;
  /** '#rrggbb', blended as drawn. null when the text fill is transparent, like gradient text or `color: transparent`. */
  color: string | null;
  /** '#rrggbb'. null when an image or a replaced element is behind the text. */
  background: string | null;
  /** Large text in the WCAG sense. */
  isLarge: boolean;
  /** Set when the text is cut off. */
  truncation: { kind: 'ellipsis' | 'clamp' | 'cut'; hiddenPx: number; clampLines: number } | null;
}

export interface ImageInfo {
  naturalWidth: number;
  naturalHeight: number;
  isComplete: boolean;
  hasSource: boolean;
  isVector: boolean;
  objectFit: string;
}

export interface Coverage {
  sampleCount: number;
  coveredSampleCount: number;
  coverers: Array<{ index: number; sampleCount: number; isTranslucent: boolean }>;
}

export interface SettleReport {
  stillMovingName: string | null;
}

/** The font that a sampled text element asks for, as the page declares it. */
export interface FontRequest {
  /** The first family of the computed font-family stack that is not generic. null when the stack starts with a generic family. */
  requestedFamily: string | null;
  /** True when a FontFace of the page carries the requested family. */
  isWebFont: boolean;
  /** True when such a FontFace loaded. */
  isWebFontLoaded: boolean;
}

export interface PxtreeInPage {
  measurePage(options: MeasurePageOptions): PageMeasurement;
  settlePage(options: { maxWaitMs: number }): Promise<SettleReport>;
  revealByScrolling(options: { maxSteps: number; maxImageWaitMs: number }): Promise<void>;
  /** One element with own text per distinct computed font-family stack, in document order. */
  getFontSampleElements(options: { maxStackCount: number }): Element[];
  getFontRequests(elements: Element[]): FontRequest[];
}

// ---------- findings ----------

export type FindingKind =
  | 'clipped'
  | 'overflows'
  | 'text-overflows'
  | 'past-viewport'
  | 'covered'
  | 'off-center'
  | 'text-off-center'
  | 'overlaps'
  | 'tops-across-siblings'
  | 'starts-across-siblings'
  | 'wider'
  | 'taller'
  | 'shorter'
  | 'sibling-gaps'
  | 'text-truncated'
  | 'contrast'
  | 'small-target'
  | 'image-not-loaded'
  | 'image-aspect'
  | 'image-upscaled'
  | 'scroll-range';

export interface Finding {
  kind: FindingKind;
  /** The node that the finding is printed on. */
  nodeIndex: number;
  /** As printed after '!! ', like 'clipped right 12 by div.panel'. */
  text: string;
  /** The text with its amount replaced by '{n}', like 'clipped right {n} by div.panel'. Equal to text when there is no amount. */
  summaryText: string;
  /** The amount, for summary ranges. */
  amount: number | null;
  /** The clipper, coverer or sibling that the finding names. */
  relatedIndex: number | null;
  /** Text color, for grouping contrast findings. */
  textColor: string | null;
}

export interface Gaps {
  arrangement: 'stacked' | 'across' | 'grid';
  /** For stacked or across, the gaps between consecutive items. For a grid, the row gaps. */
  gaps: number[];
  /** Column gaps of a grid. Empty otherwise. */
  columnGaps: number[];
  /** Free space before the first item. */
  freeStart: number;
  /** Free space after the last item. */
  freeEnd: number;
}

export interface NodeLayout {
  /** Position in PageMeasurement.nodes. */
  index: number;
  /** From the start edge of the parent's content box, or from the viewport when isViewportFrame. */
  x: number;
  /** From the top of the parent's content box, or from the viewport when isViewportFrame. */
  y: number;
  /** Gaps between the node's flow items. null when there are none worth printing. */
  gaps: Gaps | null;
}

export interface Analysis {
  /** Same order and length as PageMeasurement.nodes. */
  layouts: NodeLayout[];
  /** Sorted by node index. */
  findings: Finding[];
}

// ---------- snapshots for since last run ----------

export interface SnapshotNode {
  width: number;
  height: number;
  x: number;
  y: number;
  tags: string;
  findings: string[];
}

export interface Snapshot {
  version: 1;
  /** Keyed by node path, see docs/DESIGN.md section 4.15. */
  nodes: Record<string, SnapshotNode>;
}

// ---------- public API ----------

export interface Viewport {
  width: number;
  height: number;
}

export type ColorScheme = 'light' | 'dark';

/** Code that runs in Node with the Playwright page. */
export type PageScript = (page: import('playwright-core').Page) => Promise<void>;

export interface SessionOptions {
  /** Installed browser channel such as 'chrome'. Default is Playwright's Chromium. */
  channel?: string;
}

export interface MeasureOptions {
  /** Default [{ width: 1280, height: 800 }]. */
  viewports?: Viewport[];
  /** Default ['light']. */
  colorSchemes?: ColorScheme[];
  /** Default 1. */
  devicePixelRatio?: number;
  /** Window scroll before measuring, as coordinates or a selector. Default { x: 0, y: 0 }. */
  scroll?: { x: number; y: number } | string;
  /** Inline code (body of async (page) => {}) or a function. Runs in Node with the Playwright page. */
  script?: string | PageScript;
  /** Text that identifies the script for the cache key. The CLI passes the file content. Default is the script when it is a string. */
  scriptCacheText?: string;
  /** Milliseconds to sleep, or a selector to wait for, after the script. */
  wait?: number | string;
  /** Print only these elements. */
  elementSelector?: string;
  /** With elementSelector, include what is inside the matches. Default true. */
  shouldIncludeChildren?: boolean;
  /** PNG path. Several runs get a -WxH-scheme suffix. */
  screenshotPath?: string;
  /** Capture Playwright's aria snapshot of the page, or of each elementSelector match, in the measured state. Default false. */
  shouldCaptureAriaSnapshot?: boolean;
  /**
   * Measure the page. Default true. false skips the measurement only when cacheDirectory is null and there is no elementSelector,
   * because both need it. A run without a measurement has page and analysis null.
   */
  shouldMeasurePage?: boolean;
  /** Run the reveal scroll pass. Default true. */
  shouldReveal?: boolean;
  /** Load budget in ms. Default 30000. */
  timeoutMs?: number;
  /** Snapshot directory for since-last-run. null disables it. Default ~/.cache/pxtree. */
  cacheDirectory?: string | null;
}

/** One viewport and color scheme of a measure call. */
export interface RunResult {
  viewport: Viewport;
  colorScheme: ColorScheme;
  /** HTTP status. null when there was no response. */
  status: number | null;
  /** What settling saw before the measurement. */
  settle: SettleReport;
  /** The devicePixelRatio option that the run used. */
  devicePixelRatio: number;
  /** Everything measured in the page. null when the measurement was skipped. */
  page: PageMeasurement | null;
  /** Layouts and findings computed from the page. null when the measurement was skipped. */
  analysis: Analysis | null;
  /** The snapshot of the previous run. null on the first run or with the cache off. */
  previousSnapshot: Snapshot | null;
  /** False when cacheDirectory was null. */
  isCacheEnabled: boolean;
  /** Where the screenshot was saved. null when none was asked for. */
  screenshotPath: string | null;
  /** The shouldIncludeChildren option that the run used. */
  shouldIncludeChildren: boolean;
  /** Aria snapshots as YAML: one for the page, or one per elementSelector match. null when none was asked for. */
  ariaSnapshots: string[] | null;
  /** The URL that loading ended on, when it differs from the target by more than a trailing slash or a default port. */
  redirectedUrl: string | null;
  /** Font stacks whose first named family did not draw the text. Empty when the measurement was skipped. */
  fontFallbacks: FontFallback[];
}

export interface FontFallback {
  /** The first family of the stack that is not generic. */
  requestedFamily: string;
  /** The platform font that drew most of the glyphs. */
  drawnFamily: string;
}

export interface MeasureResult {
  /** The resolved URL. */
  target: string;
  /** One run per viewport and color scheme. Runs finished before an error are kept. */
  runs: RunResult[];
  /** A load, launch, script or measurement failure. null when every run finished. */
  error: { kind: 'load' | 'launch' | 'script' | 'measure'; message: string } | null;
}

export interface FormatOptions {
  /** Print hex colors in [renders] and [text]. Default false. */
  shouldShowColors?: boolean;
  /**
   * How much of the measurement each run prints. Default 'tree'.
   * 'tree': facts line, since last run, summary, tree and the across block.
   * 'findings': the same, with the tree cut down to the lines that carry a finding and the names of their ancestors.
   * 'summary': the same without the tree. 'changes': facts line and since last run. 'none': the facts line only.
   * The aria section follows in every case when the run has aria snapshots.
   */
  report?: ReportDetail;
}

export type ReportDetail = 'tree' | 'findings' | 'summary' | 'changes' | 'none';

/** A browser session. Keep one open to measure several times without relaunching. */
export interface Session {
  /** Measures a URL, host or HTML file path. Failures are returned in `error`, not thrown. */
  measure(target: string, options?: MeasureOptions): Promise<MeasureResult>;
  /** Closes the browser. */
  close(): Promise<void>;
}
