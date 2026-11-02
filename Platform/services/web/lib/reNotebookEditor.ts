// The RE Notebook editor's extensions (Tiptap 3). The schema they produce is
// exactly what reNotebookDoc.ts and the backend accept: StarterKit with
// headings 1-3, and without horizontal rules, strikethrough and underline.
// The same extensions render saved documents read-only, so a document is
// always shown through the schema (ProseMirror builds the DOM from it), never
// as stored HTML. Pasted HTML is parsed into the schema too, so anything
// else is dropped.
//
// Kept apart from reNotebookDoc.ts so only the notebook loads Tiptap.

import type { Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { isAllowedHref } from "./reNotebookDoc";

export function notebookExtensions(): Extensions {
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
  ];
}
