/** Types for `@codepress/design-kit/kit`, the kit tool's functions. */

/** One row of `index.json` (stories) or `routes.json` (pages). */
export interface KitRow {
  id: string;
  kind?: "story" | "route";
  title?: string;
  component?: string;
  file: string;
  width?: number;
  height?: number;
  bytes?: number;
  slots?: string[];
  source_file?: string;
  body_class?: string;
  html_attrs?: Record<string, string>;
  body_attrs?: Record<string, string>;
}

export interface KitManifest {
  kit_version?: number;
  sha?: string;
  built_at?: string;
  [key: string]: unknown;
}

/** A loaded kit: its folder, manifest and rows, sorted and by id. */
export interface Kit {
  dir: string;
  manifest: KitManifest | null;
  rows: KitRow[];
  byId: Map<string, KitRow>;
  /** Each row's visible text by id, from text.json; absent in older kits. */
  text?: Map<string, string>;
}

export function loadKit(dir: string): Kit;

/** One `find` result; `excerpt` is set when a word matched only the row's text. */
export interface KitMatch {
  row: KitRow;
  excerpt?: string;
}

/**
 * Rows whose id, title, component, source file or visible text holds every
 * word: id matches first, then title, component or source file, then text.
 */
export function findMatches(kit: Kit, query: string): KitMatch[];

/** The rows of `findMatches`, in the same order. */
export function find(kit: Kit, query: string): KitRow[];

/**
 * `kit find`'s lines for `findMatches` results, at most 30: rows that differ
 * only by width share one line (`route:x@{1280,390}  131/136 KB  Title`), a
 * title that only restates the id is left out, and when the matches do not
 * fit, a last line counts the rows not shown.
 */
export function findMatchLines(matches: KitMatch[]): string[];

/** Characters of visible text text.json keeps per row: 600. */
export const TEXT_LIMIT: number;

/**
 * A row's on-screen words: text outside scripts, styles, SVG, the head and
 * templates, entities decoded, whitespace collapsed, at most `limit` characters.
 */
export function visibleText(html: string, limit?: number): string;

/** text.json's content for `rows`, reading each row's markup by its `file`. */
export function kitText(
  rows: KitRow[],
  read: (file: string) => string,
): Record<string, string>;

/** text.json as written. */
export function kitTextJson(text: Record<string, string>): string;

/** Rebuilds `dir`/text.json from the rows and markup already in the kit. */
export function writeKitText(dir: string): string;

/** Up to five candidates, closest first. */
export function nearMatches(wanted: string, candidates: string[]): string[];

/** A markup outline of at most `limit` bytes. */
export function outline(
  html: string,
  limit?: number,
): { lines: string[]; truncated: boolean };

/**
 * One self-contained page. Throws an Error whose message starts with
 * `unknown ` (and names near matches) for an unknown frame, slot or snippet,
 * and with `too large: ` when snippets grow the page past `maxBytes`.
 */
export function compose(
  kit: Kit,
  options: {
    frame: string;
    slots?: { name: string; content: string }[];
    theme?: "light" | "dark";
    showNew?: boolean;
    /** Bytes of markup the page may grow to through snippets. */
    maxBytes?: number;
    /**
     * `pruned` (the default) keeps only the CSS rules the page's classes and
     * ids can use, each repeated rule once; `full` keeps every rule.
     */
    css?: "pruned" | "full";
  },
): string;

/**
 * The stylesheet without the style rules that need a class or id missing
 * from `names`, and with each rule repeated in the same at-rule context
 * written once (its last copy).
 */
export function pruneCss(css: string, names: Set<string>): string;

/** The default `maxBytes` of `compose`: 32 MB. */
export const COMPOSE_MAX_BYTES: number;

export function sanitizeMarkup(html: string): string;
export function sanitizeCss(css: string): string;

/** Runs one command line; returns the exit code. */
export function run(
  argv: string[],
  io?: { out(text: string): void; err(text: string): void },
  env?: Record<string, string | undefined>,
  defaultDir?: string,
): number;

/** Whether this file is the script node was started with. */
export function isMain(moduleUrl?: string, script?: string): boolean;

/**
 * The kit's one-line summary, as `kit info` prints it:
 * `sha7 built <iso> · stories N · routes N · failed N` (the failed ids when
 * there are five or fewer).
 */
export function kitSummaryLine(kit: Kit): string;

/** Image bytes above which `kit figure` warns: 1 MB. */
export const FIGURE_WARN_BYTES: number;

/**
 * `kit figure`'s fragment: a `<figure>` with the image as a data URI, inside
 * `<a href>` when `href` is given (a fragment such as `#cp-page:<key>` or a
 * relative link), and the caption escaped. `width` is CSS pixels.
 */
export function figureHtml(options: {
  image: Uint8Array;
  type: "image/png" | "image/jpeg" | "image/webp";
  href?: string;
  caption?: string;
  alt?: string;
  width?: string | number;
}): string;

/** `figure --page`'s default design width when the page records none. */
export const FIGURE_PAGE_WIDTH: number;
/** `figure --page`'s default displayed width. */
export const FIGURE_PAGE_FIT: number;

/**
 * `kit figure --page`'s fragment: the page's markup and CSS in a declarative
 * shadow root, laid out at `width` × `height` design pixels and scaled to
 * `fit` CSS pixels wide. `scripts` counts the <script> elements dropped.
 */
export function pageFigureHtml(
  page: string,
  options?: {
    href?: string;
    caption?: string;
    alt?: string;
    width?: string | number;
    fit?: string | number;
    height?: string | number;
  },
): { html: string; scripts: number };

/** A selector with `:root`, `html` and `body` pointed at the figure's stand-ins. */
export function pageSelector(selector: string): string;

/** Whether an `@media` prelude holds at width × height; null when undecidable. */
export function mediaMatches(
  prelude: string,
  width: number,
  height: number,
): boolean | null;

/** CSS with viewport units turned into pixels of a width × height box. */
export function viewportToPixels(
  css: string,
  width: number,
  height: number,
): string;

/** Whether a selector can match in a static, inert figure with these names. */
export function figureSelectorCanMatch(
  selector: string,
  names: Set<string>,
): boolean;
