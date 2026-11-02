// RE Notebook documents: the editor's structured JSON, never HTML.
//
// The editor (Tiptap, see reNotebookEditor.ts) produces ProseMirror JSON with
// a few attributes the notebook doesn't store (a link's target and rel, which
// are fixed when shown; null attributes). normalizeDoc turns that into the
// canonical form the backend accepts, and validateDoc applies the backend's
// rules (re-notebook-api/re_notebook_doc.py) before anything is sent, so a
// document is refused here with the same message rather than after a round
// trip. Both sides are tested against the same documents
// (lambdas/tests/fixtures/re_notebook_docs.json).
//
// Supported: paragraphs, headings 1-3, bold, italic, inline code, links
// (http, https, mailto), bullet and numbered lists, quotes, code blocks and
// line breaks. Nothing else is stored or shown.

export interface NotebookMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface NotebookNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NotebookNode[];
  marks?: NotebookMark[];
  text?: string;
}

export type NotebookDoc = NotebookNode & { type: "doc" };

export const EMPTY_DOC: NotebookDoc = { type: "doc", content: [{ type: "paragraph" }] };

export const MAX_DOC_BYTES = 300 * 1024;
export const MAX_DEPTH = 40;
export const MAX_NODES = 60_000;
export const MAX_HREF_LENGTH = 2048;
export const HEADING_LEVELS = [1, 2, 3] as const;
const MAX_ORDERED_LIST_START = 1_000_000;
const LANGUAGE_PATTERN = /^[A-Za-z0-9+#._-]{1,32}$/;
const LINK_SCHEMES = new Set(["http", "https", "mailto"]);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export const BLOCK_NODES = ["paragraph", "heading", "blockquote", "bulletList", "orderedList", "codeBlock"] as const;
export const INLINE_NODES = ["text", "hardBreak"] as const;
export const NODE_TYPES = ["doc", ...BLOCK_NODES, "listItem", ...INLINE_NODES] as const;
export const MARK_TYPES = ["bold", "italic", "code", "link"] as const;

const BLOCK = new Set<string>(BLOCK_NODES);
const INLINE = new Set<string>(INLINE_NODES);
const NODES: Record<string, { children: Set<string>; min: number }> = {
  doc: { children: BLOCK, min: 1 },
  paragraph: { children: INLINE, min: 0 },
  heading: { children: INLINE, min: 0 },
  blockquote: { children: BLOCK, min: 1 },
  bulletList: { children: new Set(["listItem"]), min: 1 },
  orderedList: { children: new Set(["listItem"]), min: 1 },
  listItem: { children: BLOCK, min: 1 },
  codeBlock: { children: new Set(["text"]), min: 0 },
  hardBreak: { children: new Set(), min: 0 },
  text: { children: new Set(), min: 0 },
};
const LEAVES = new Set(["hardBreak", "text"]);

// --- Links ---------------------------------------------------------------------

/** http(s) with a host, or mailto: so a stored link can never run script. */
export function isAllowedHref(href: unknown): boolean {
  if (typeof href !== "string" || !href || href.length > MAX_HREF_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(href)) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  if (!scheme || !LINK_SCHEMES.has(scheme)) return false;
  if (scheme === "mailto") return href.length > "mailto:".length;
  return /^https?:\/\/[^/?#]+/i.test(href);
}

/**
 * What the link dialog stores for what was typed: "example.org/x" becomes
 * https://example.org/x and "lab@example.org" a mailto link. Null when it
 * isn't an allowed link.
 */
export function normalizeHref(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (isAllowedHref(value)) return value;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[^:/]+:\d/.test(value)) return null; // another scheme
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(value)) return `mailto:${value}`;
  const candidate = `https://${value.replace(/^\/+/, "")}`;
  return isAllowedHref(candidate) && /^https:\/\/[^/?#]*\.[^/?#]*/.test(candidate) ? candidate : null;
}

// --- Normalization ------------------------------------------------------------------

/** The canonical form of the editor's JSON (see the file comment). */
export function normalizeDoc(json: NotebookNode): NotebookDoc {
  return normalizeNode(json) as NotebookDoc;
}

function normalizeNode(node: NotebookNode): NotebookNode {
  const out: NotebookNode = { type: node.type };
  const attrs = normalizeAttrs(node);
  if (attrs) out.attrs = attrs;
  if (Array.isArray(node.content) && node.content.length) out.content = node.content.map(normalizeNode);
  const marks = Array.isArray(node.marks) ? node.marks.flatMap(normalizeMark) : [];
  if (marks.length) out.marks = marks;
  if (typeof node.text === "string") out.text = node.text;
  return out;
}

function normalizeAttrs(node: NotebookNode): Record<string, unknown> | undefined {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "heading":
      return { level: attrs.level };
    case "orderedList":
      return { start: typeof attrs.start === "number" ? attrs.start : 1 };
    case "codeBlock":
      return typeof attrs.language === "string" && LANGUAGE_PATTERN.test(attrs.language)
        ? { language: attrs.language }
        : undefined;
    default:
      // Unknown nodes keep theirs, so validation reports them.
      return NODES[node.type] || !node.attrs ? undefined : node.attrs;
  }
}

function normalizeMark(mark: NotebookMark): NotebookMark[] {
  if (mark.type === "link") {
    // A link the notebook can't store (e.g. a relative one from pasted HTML)
    // is dropped; its text stays.
    const href = mark.attrs?.href;
    return isAllowedHref(href) ? [{ type: "link", attrs: { href: href as string } }] : [];
  }
  return [MARK_TYPES.includes(mark.type as (typeof MARK_TYPES)[number]) ? { type: mark.type } : mark];
}

// --- Validation -------------------------------------------------------------------

export type DocValidation = { ok: true; bytes: number; textLength: number } | { ok: false; error: string };

class DocError extends Error {}

/** The backend's rules (re_notebook_doc.validate), with the same messages. */
export function validateDoc(doc: unknown): DocValidation {
  const state = { nodes: 0, text: 0 };
  try {
    if (!isObject(doc) || doc.type !== "doc") throw new DocError("content must be a document");
    checkNode(doc as unknown as NotebookNode, state, 1, false);
    const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
    if (bytes > MAX_DOC_BYTES) throw new DocError(`content is too large (at most ${MAX_DOC_BYTES / 1024} KB)`);
    return { ok: true, bytes, textLength: state.text };
  } catch (err) {
    if (err instanceof DocError) return { ok: false, error: err.message };
    throw err;
  }
}

function checkNode(node: unknown, state: { nodes: number; text: number }, depth: number, marksAllowed: boolean) {
  if (!isObject(node)) throw new DocError("content contains an invalid node");
  const kind = node.type;
  if (typeof kind !== "string" || !NODES[kind]) throw new DocError("content contains unsupported formatting");
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw new DocError("content is too large");
  if (depth > MAX_DEPTH) throw new DocError("content is nested too deeply");

  const allowed = new Set(["type", "attrs"]);
  if (!LEAVES.has(kind)) allowed.add("content");
  if (INLINE.has(kind)) allowed.add("marks");
  if (kind === "text") allowed.add("text");
  if (Object.keys(node).some((key) => !allowed.has(key))) throw new DocError("content contains unsupported formatting");

  checkAttrs(kind, node.attrs);
  if ("marks" in node) {
    if (!marksAllowed) throw new DocError("content contains unsupported formatting");
    checkMarks(node.marks);
  }
  if (kind === "text") {
    const text = node.text;
    if (typeof text !== "string" || !text) throw new DocError("content contains an invalid text node");
    if (CONTROL_CHARS.test(text) || LONE_SURROGATE.test(text)) throw new DocError("content contains invalid characters");
    state.text += [...text].length;
    return;
  }
  if (kind === "hardBreak") return;

  const rule = NODES[kind];
  const children = "content" in node ? node.content : [];
  if (!Array.isArray(children) || children.length < rule.min) throw new DocError("content has an invalid structure");
  children.forEach((child, index) => {
    if (!isObject(child) || typeof child.type !== "string" || !rule.children.has(child.type)) {
      throw new DocError("content has an invalid structure");
    }
    if (kind === "listItem" && index === 0 && child.type !== "paragraph") {
      throw new DocError("content has an invalid structure");
    }
    checkNode(child, state, depth + 1, kind === "paragraph" || kind === "heading");
  });
}

function checkAttrs(kind: string, attrs: unknown) {
  if (kind === "heading") {
    if (
      !isObject(attrs) ||
      !sameKeys(attrs, ["level"]) ||
      !isInt(attrs.level) ||
      !(HEADING_LEVELS as readonly number[]).includes(attrs.level as number)
    ) {
      throw new DocError("content contains an invalid heading");
    }
    return;
  }
  if (attrs === undefined || attrs === null) return;
  if (kind === "orderedList") {
    if (!isObject(attrs) || Object.keys(attrs).some((k) => k !== "start")) throw new DocError("content contains an invalid list");
    const start = "start" in attrs ? attrs.start : 1;
    if (!isInt(start) || (start as number) < 0 || (start as number) > MAX_ORDERED_LIST_START) {
      throw new DocError("content contains an invalid list");
    }
    return;
  }
  if (kind === "codeBlock") {
    if (!isObject(attrs) || Object.keys(attrs).some((k) => k !== "language")) {
      throw new DocError("content contains an invalid code block");
    }
    const language = attrs.language;
    if (language !== undefined && language !== null && (typeof language !== "string" || !LANGUAGE_PATTERN.test(language))) {
      throw new DocError("content contains an invalid code block");
    }
    return;
  }
  throw new DocError("content contains unsupported formatting");
}

function checkMarks(marks: unknown) {
  if (!Array.isArray(marks) || !marks.length) throw new DocError("content contains invalid formatting");
  const seen = new Set<string>();
  for (const mark of marks) {
    if (!isObject(mark) || typeof mark.type !== "string" || !(MARK_TYPES as readonly string[]).includes(mark.type) || seen.has(mark.type)) {
      throw new DocError("content contains unsupported formatting");
    }
    seen.add(mark.type);
    if (mark.type === "link") {
      if (!sameKeys(mark, ["type", "attrs"]) || !isObject(mark.attrs) || !sameKeys(mark.attrs, ["href"]) || !isAllowedHref(mark.attrs.href)) {
        throw new DocError("content contains an invalid link (only http, https and mailto links)");
      }
    } else if (!sameKeys(mark, ["type"])) {
      throw new DocError("content contains unsupported formatting");
    }
  }
  if (seen.has("code") && seen.size > 1) throw new DocError("content contains unsupported formatting");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

// --- Plain text -----------------------------------------------------------------------

/** The document as plain text (one line per block), e.g. to copy it. */
export function docText(doc: NotebookNode): string {
  const lines: string[] = [];
  const walk = (node: NotebookNode, prefix: string) => {
    if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") {
      lines.push(prefix + inlineText(node));
      return;
    }
    if (node.type === "bulletList" || node.type === "orderedList") {
      let n = typeof node.attrs?.start === "number" ? (node.attrs.start as number) : 1;
      for (const item of node.content ?? []) {
        const marker = node.type === "bulletList" ? "• " : `${n++}. `;
        (item.content ?? []).forEach((child, i) => walk(child, i === 0 ? prefix + marker : prefix + "   "));
      }
      return;
    }
    const childPrefix = node.type === "blockquote" ? prefix + "> " : prefix;
    for (const child of node.content ?? []) walk(child, childPrefix);
  };
  walk(doc, "");
  return lines.join("\n");
}

function inlineText(node: NotebookNode): string {
  return (node.content ?? []).map((child) => (child.type === "hardBreak" ? "\n" : child.text ?? "")).join("");
}

/** Whether two documents have the same content. */
export function sameDoc(a: NotebookNode | null | undefined, b: NotebookNode | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
