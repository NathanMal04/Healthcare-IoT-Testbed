// The RE Notebook editor's extensions (Tiptap 3). The schema they produce is
// exactly what reNotebookDoc.ts and the backend accept: StarterKit with
// headings 1-3, and without horizontal rules, strikethrough and underline,
// plus the notebook's own image node. The same extensions render saved
// documents read-only, so a document is always shown through the schema
// (ProseMirror builds the DOM from it), never as stored HTML. Pasted HTML is
// parsed into the schema too, so anything else is dropped.
//
// Kept apart from reNotebookDoc.ts so only the notebook loads Tiptap.

import { Node, mergeAttributes, type Extensions, type NodeViewRenderer } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { cleanAlt, isAllowedHref } from "./reNotebookDoc";

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One of the device's gallery images, as a block of its own. It holds the
 * image's artifactId (and alt text) only: its HTML form has no src, so an
 * image pasted from elsewhere (an <img> without the notebook's
 * data-artifact-id) is dropped, and a view URL never ends up in a document.
 * Shown by the node view the page passes in (NotebookImage.tsx), which gets
 * a short-lived URL for the id.
 */
export const NotebookImage = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      artifactId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-artifact-id"),
        renderHTML: (attrs) => ({ "data-artifact-id": attrs.artifactId }),
      },
      alt: {
        default: null,
        parseHTML: (element) => cleanAlt(element.getAttribute("alt") ?? "") || null,
        renderHTML: (attrs) => (attrs.alt ? { alt: attrs.alt } : {}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[data-artifact-id]",
        getAttrs: (element) => (ARTIFACT_ID.test((element as HTMLElement).getAttribute("data-artifact-id") ?? "") ? null : false),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes({ "data-notebook-image": "" }, HTMLAttributes)];
  },
});

export interface NotebookExtensionOptions {
  /** Shows images (NotebookImage.tsx); without it they render as bare <img> placeholders. */
  imageNodeView?: NodeViewRenderer;
}

export function notebookExtensions({ imageNodeView }: NotebookExtensionOptions = {}): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      horizontalRule: false,
      strike: false,
      underline: false,
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: "https",
        // Typed, pasted and loaded links alike: http(s) and mailto only. A
        // value without a scheme ("example.org", as autolinking sees typed
        // text) gets https:// added; any link that still isn't allowed is
        // dropped by normalizeDoc (its text stays), so it's never stored.
        isAllowedUri: (url, ctx) =>
          isAllowedHref(url) || (!/^[a-z][a-z0-9+.-]*:/i.test(url) && ctx.defaultValidate(url)),
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer nofollow" },
      },
    }),
    imageNodeView ? NotebookImage.extend({ addNodeView: () => imageNodeView }) : NotebookImage,
  ];
}
