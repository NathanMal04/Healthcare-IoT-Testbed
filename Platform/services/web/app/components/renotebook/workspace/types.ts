import type { NotebookEntry, NotebookSection } from "@/lib/reNotebook";

/** A notebook change that needs a dialog (a title, a target or a confirmation). */
export type NavAction =
  | { kind: "newEntry"; section: NotebookSection }
  | { kind: "renameSection"; section: NotebookSection }
  | { kind: "deleteSection"; section: NotebookSection }
  | { kind: "renameEntry"; entry: NotebookEntry }
  | { kind: "moveEntry"; entry: NotebookEntry }
  | { kind: "deleteEntry"; entry: NotebookEntry };
