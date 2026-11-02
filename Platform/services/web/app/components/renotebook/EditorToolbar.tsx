"use client";

import { useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  SquareCode,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { normalizeHref } from "@/lib/reNotebookDoc";
import { Alert, Button, Dialog, inputClass, labelClass } from "@/app/components/ui";

const STYLES = [
  { value: "paragraph", label: "Normal text" },
  { value: "1", label: "Heading 1" },
  { value: "2", label: "Heading 2" },
  { value: "3", label: "Heading 3" },
] as const;

/**
 * The formatting the notebook supports, and nothing else: text style
 * (paragraph or heading 1-3), bold, italic, inline code, link, bullet and
 * numbered lists, quote, code block, undo and redo. Keyboard shortcuts (Ctrl/⌘
 * B, I, Z, Shift+Z, …) work as usual.
 */
export default function EditorToolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      style: e.isActive("heading", { level: 1 })
        ? "1"
        : e.isActive("heading", { level: 2 })
          ? "2"
          : e.isActive("heading", { level: 3 })
            ? "3"
            : "paragraph",
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bulletList: e.isActive("bulletList"),
      orderedList: e.isActive("orderedList"),
      blockquote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const off = disabled || !editor.isEditable;
  const chain = () => editor.chain().focus();

  return (
    <div className="sticky top-0 z-10 border-y border-line bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85">
      <div
        role="toolbar"
        aria-label="Formatting"
        className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-1 gap-y-1 px-3 sm:px-8 py-1.5"
      >
        <label className="sr-only" htmlFor="re-notebook-style">
          Text style
        </label>
        <select
          id="re-notebook-style"
          value={state.style}
          disabled={off || state.codeBlock}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "paragraph") chain().setParagraph().run();
            else chain().setHeading({ level: Number(value) as 1 | 2 | 3 }).run();
          }}
          className="h-8 rounded-md border border-line bg-white px-2 text-xs font-medium text-slate-700 disabled:opacity-50"
        >
          {STYLES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Divider />
        <Group label="Text">
          <Tool label="Bold" icon={Bold} active={state.bold} disabled={off} onClick={() => chain().toggleBold().run()} />
          <Tool label="Italic" icon={Italic} active={state.italic} disabled={off} onClick={() => chain().toggleItalic().run()} />
          <Tool label="Inline code" icon={Code} active={state.code} disabled={off} onClick={() => chain().toggleCode().run()} />
          <Tool label={state.link ? "Edit link" : "Add link"} icon={Link2} active={state.link} disabled={off} onClick={() => setLinkOpen(true)} />
        </Group>
        <Divider />
        <Group label="Blocks">
          <Tool label="Bulleted list" icon={List} active={state.bulletList} disabled={off} onClick={() => chain().toggleBulletList().run()} />
          <Tool label="Numbered list" icon={ListOrdered} active={state.orderedList} disabled={off} onClick={() => chain().toggleOrderedList().run()} />
          <Tool label="Quote" icon={Quote} active={state.blockquote} disabled={off} onClick={() => chain().toggleBlockquote().run()} />
          <Tool label="Code block" icon={SquareCode} active={state.codeBlock} disabled={off} onClick={() => chain().toggleCodeBlock().run()} />
        </Group>
        <span className="ml-auto" aria-hidden="true" />
        <Group label="History">
          <Tool label="Undo" icon={Undo2} disabled={off || !state.canUndo} onClick={() => chain().undo().run()} />
          <Tool label="Redo" icon={Redo2} disabled={off || !state.canRedo} onClick={() => chain().redo().run()} />
        </Group>

        {linkOpen && <LinkDialog editor={editor} onClose={() => setLinkOpen(false)} />}
      </div>
    </div>
  );
}

/** Related tools, kept together when the toolbar wraps. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5">
      {children}
    </div>
  );
}

function Tool({
  label,
  icon: Icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      // Keep the editor's selection when clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`h-8 w-8 inline-flex items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
        active ? "bg-brand-100 text-brand-800" : "text-slate-600 hover:bg-surface-sunken hover:text-slate-900"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />;
}

/** Adds, changes or removes the link on the selection (http, https or mailto only). */
function LinkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const existing = (editor.getAttributes("link").href as string | undefined) ?? "";
  const [value, setValue] = useState(existing);
  const [error, setError] = useState<string | null>(null);
  const hasSelection = !editor.state.selection.empty || !!existing;

  function apply(e: React.FormEvent) {
    e.preventDefault();
    const href = normalizeHref(value);
    if (!href) {
      setError("Enter a web address (https://…) or an email address.");
      return;
    }
    const chain = editor.chain().focus().extendMarkRange("link");
    if (hasSelection) chain.setLink({ href }).run();
    else chain.insertContent({ type: "text", text: value.trim(), marks: [{ type: "link", attrs: { href } }] }).run();
    onClose();
  }

  return (
    <Dialog title={existing ? "Edit link" : "Add link"} onClose={onClose}>
      <form onSubmit={apply} className="space-y-4">
        <div>
          <label htmlFor="re-notebook-link" className={labelClass}>
            Web or email address
          </label>
          <input
            id="re-notebook-link"
            autoFocus
            className={inputClass}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="https://example.org/datasheet"
            maxLength={2048}
          />
          {!hasSelection && <p className="mt-1.5 text-xs text-slate-500">The address is inserted as the link text.</p>}
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          {existing && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                onClose();
              }}
            >
              Remove link
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">{existing ? "Update link" : "Add link"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
