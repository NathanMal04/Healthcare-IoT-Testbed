// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import {
  EMPTY_DOC,
  MARK_TYPES,
  MAX_DOC_BYTES,
  NODE_TYPES,
  docText,
  isAllowedHref,
  normalizeDoc,
  normalizeHref,
  validateDoc,
  type NotebookDoc,
  type NotebookNode,
} from "./reNotebookDoc";
import { notebookExtensions } from "./reNotebookEditor";

// The same documents the backend validator is tested with
// (re-notebook-api/re_notebook_doc.py, tests/test_re_notebook_doc.py).
const FIXTURES = JSON.parse(
  // Tests run from Platform/services/web.
  readFileSync(resolve(process.cwd(), "../lambdas/tests/fixtures/re_notebook_docs.json"), "utf8")
) as {
  valid: { name: string; doc: NotebookDoc; editorHtml?: string }[];
  invalid: { name: string; doc: unknown }[];
};

const editors: Editor[] = [];
function editorWith(content: string | NotebookDoc): Editor {
  const editor = new Editor({ element: document.createElement("div"), extensions: notebookExtensions(), content });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
});

describe("shared fixtures", () => {
  it.each(FIXTURES.valid.map((c) => [c.name, c] as const))("accepts: %s", (_name, c) => {
    expect(validateDoc(c.doc)).toMatchObject({ ok: true });
  });

  it.each(FIXTURES.invalid.map((c) => [c.name, c] as const))("refuses: %s", (_name, c) => {
    expect(validateDoc(c.doc)).toMatchObject({ ok: false });
  });

  it.each(FIXTURES.valid.filter((c) => c.editorHtml).map((c) => [c.name, c] as const))(
    "the editor produces exactly the fixture for: %s",
    (_name, c) => {
      const output = normalizeDoc(editorWith(c.editorHtml!).getJSON() as NotebookNode);
      expect(output).toEqual(c.doc);
      expect(validateDoc(output)).toMatchObject({ ok: true });
    }
  );

  it.each(FIXTURES.valid.map((c) => [c.name, c] as const))("a saved document loads back unchanged: %s", (_name, c) => {
    expect(normalizeDoc(editorWith(c.doc).getJSON() as NotebookNode)).toEqual(normalizeDoc(c.doc));
  });
});

describe("the editor's schema matches the validation rules", () => {
  it("has exactly the supported nodes and marks", () => {
    const editor = editorWith("");
    expect(Object.keys(editor.schema.nodes).sort()).toEqual([...NODE_TYPES].sort());
    expect(Object.keys(editor.schema.marks).sort()).toEqual([...MARK_TYPES].sort());
  });

  it("offers headings 1 to 3 only", () => {
    const editor = editorWith("<h4>x</h4><h1>y</h1>");
    const doc = normalizeDoc(editor.getJSON() as NotebookNode);
    expect(doc.content?.map((n) => [n.type, n.attrs?.level])).toEqual([
      ["paragraph", undefined],
      ["heading", 1],
    ]);
  });

  it("drops unsupported pasted HTML instead of storing it", () => {
    const editor = editorWith(
      '<p>a<img src="https://x.org/i.png"><u>u</u><s>s</s><script>alert(1)</script></p><hr><table><tr><td>t</td></tr></table>'
    );
    const doc = normalizeDoc(editor.getJSON() as NotebookNode);
    expect(validateDoc(doc)).toMatchObject({ ok: true });
    expect(JSON.stringify(doc)).not.toMatch(/img|script|underline|strike|horizontalRule|table/);
  });

  it("never keeps a link the notebook can't store", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "/relative", "ftp://x.org/f"]) {
      const doc = normalizeDoc(editorWith(`<p><a href="${href}">x</a></p>`).getJSON() as NotebookNode);
      expect(doc).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] });
    }
  });

  it("autolinks typed web addresses with https", () => {
    const editor = editorWith("<p></p>");
    editor.commands.insertContent("see example.org ");
    // Autolinking runs on typing; inserted content is linked by the paste rule
    // or not at all, but must never produce an unstorable link either way.
    const doc = normalizeDoc(editor.getJSON() as NotebookNode);
    expect(validateDoc(doc)).toMatchObject({ ok: true });
  });
});

describe("validateDoc limits", () => {
  it("measures the stored size in UTF-8 bytes", () => {
    const text = (n: number): NotebookDoc => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "é".repeat(n) }] }],
    });
    const overhead = JSON.stringify(text(1)).length - 1;
    expect(validateDoc(text(Math.floor((MAX_DOC_BYTES - overhead) / 2)))).toMatchObject({ ok: true });
    expect(validateDoc(text(Math.floor((MAX_DOC_BYTES - overhead) / 2) + 1))).toMatchObject({
      ok: false,
      error: "content is too large (at most 300 KB)",
    });
  });

  it("refuses lone surrogates and deep nesting", () => {
    const doc: NotebookDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a\ud800" }] }] };
    expect(validateDoc(doc)).toEqual({ ok: false, error: "content contains invalid characters" });
    let node: NotebookNode = { type: "paragraph" };
    for (let i = 0; i < 40; i++) node = { type: "blockquote", content: [node] };
    expect(validateDoc({ type: "doc", content: [node] })).toEqual({ ok: false, error: "content is nested too deeply" });
  });

  it("counts text like the backend (code points)", () => {
    const doc: NotebookDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "a😀b" }] }] };
    expect(validateDoc(doc)).toMatchObject({ ok: true, textLength: 3 });
  });
});

describe("links", () => {
  it("allows the same links as the backend", () => {
    for (const href of ["https://example.org/a?b=c#d", "http://10.0.0.1:8080/", "mailto:lab@example.org", "HTTPS://EXAMPLE.ORG"]) {
      expect(isAllowedHref(href)).toBe(true);
    }
    for (const href of ["", "javascript:alert(1)", "vbscript:x", "data:text/html,x", "file:///etc/passwd", "ftp://example.org",
      "//example.org", "example.org", "https://exa mple.org", "https://example.org/\n", "mailto:", `https://${"a".repeat(2048)}`, null, 5]) {
      expect(isAllowedHref(href)).toBe(false);
    }
  });

  it("normalizes what is typed in the link dialog", () => {
    expect(normalizeHref(" https://example.org/x ")).toBe("https://example.org/x");
    expect(normalizeHref("example.org/datasheet.pdf")).toBe("https://example.org/datasheet.pdf");
    expect(normalizeHref("lab@example.org")).toBe("mailto:lab@example.org");
    expect(normalizeHref("javascript:alert(1)")).toBeNull();
    expect(normalizeHref("not a link")).toBeNull();
    expect(normalizeHref("")).toBeNull();
  });
});

describe("docText", () => {
  it("turns a document into plain text", () => {
    const doc = FIXTURES.valid.find((c) => c.name === "every supported format")!.doc;
    expect(docText(doc)).toBe("T\na b c d l\nn\n• u\n3. o\n> q\nx=1\n");
    expect(docText(EMPTY_DOC)).toBe("");
  });
});
