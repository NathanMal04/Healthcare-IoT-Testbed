"use client";

import { useEffect, useMemo } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { notebookExtensions } from "@/lib/reNotebookEditor";
import type { NotebookDoc } from "@/lib/reNotebookDoc";

/**
 * A saved document, read-only. Rendered by the editor's own schema (ProseMirror
 * builds the DOM node by node), never from HTML, so only the supported
 * formatting can appear and links are only ever http(s) or mailto.
 */
export default function NotebookDocView({ doc, label }: { doc: NotebookDoc; label: string }) {
  const extensions = useMemo(() => notebookExtensions(), []);
  const editor = useEditor({
    extensions,
    content: doc,
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { class: "re-notebook-doc", "aria-label": label, "aria-readonly": "true" } },
  });

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.setContent(doc, { emitUpdate: false });
  }, [editor, doc]);

  return <EditorContent editor={editor} />;
}
