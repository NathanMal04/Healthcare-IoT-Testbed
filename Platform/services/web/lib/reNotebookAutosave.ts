// Autosave for one open RE Notebook entry, independent of React so its timing
// and failure handling can be tested on their own.
//
// - Saves 1.5 s after the last change, and at least every 10 s while typing
//   goes on. One save at a time; changes made during a save go in the next.
// - Each save names the contentVersion it is based on. If someone else saved
//   meanwhile, the backend refuses it (409) and nothing is overwritten:
//   autosave stops and onConflict hands both versions to the UI.
// - An entry deleted meanwhile stops autosave too (onDeleted).
// - Network and server errors are retried with a growing delay (up to 30 s);
//   the state says so. Errors only the user can fix stop it.
// - Until a save is confirmed, the latest version is kept as a local draft,
//   so closing the tab or a crash doesn't lose it.

import { isRetryableSaveError, notebookRefusal, type NotebookEntry, type NotebookRefusal } from "./reNotebook";
import { normalizeDoc, validateDoc, type NotebookDoc } from "./reNotebookDoc";

export type AutosaveStatus = "saved" | "unsaved" | "saving" | "retrying" | "error" | "conflict" | "deleted";

export interface AutosaveState {
  status: AutosaveStatus;
  /** When the last save was confirmed (the server's time). */
  lastSavedAt: string | null;
  error: string | null;
  /**
   * Autosave has stopped until the user decides (a conflict, a deleted entry)
   * or can't continue (lost access). The changes are kept as a local draft.
   */
  stopped: boolean;
}

export interface AutosaveOptions {
  /** The document as loaded, and its version. */
  doc: NotebookDoc;
  contentVersion: number;
  lastSavedAt?: string | null;
  save(doc: NotebookDoc, expectedContentVersion: number): Promise<NotebookEntry>;
  onState(state: AutosaveState): void;
  onSaved?(entry: NotebookEntry): void;
  /** Someone else saved first. `mine` is the unsaved version. */
  onConflict?(refusal: NotebookRefusal, mine: NotebookDoc): void;
  /** The entry was deleted meanwhile. */
  onDeleted?(refusal: NotebookRefusal, mine: NotebookDoc): void;
  draft: { write(doc: NotebookDoc, baseContentVersion: number): boolean; clear(): void };
  debounceMs?: number;
  maxWaitMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  draftDelayMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

export class EntryAutosave {
  private base: number;
  private savedJson: string;
  private latest: NotebookDoc;
  private latestJson: string;
  /** A document refused as invalid: not sent again until it changes. */
  private refusedJson: string | null = null;
  private inflight: Promise<void> | null = null;
  private stopped = false;
  private disposed = false;
  private retries = 0;
  private debounce: Timer | null = null;
  private maxWait: Timer | null = null;
  private retryTimer: Timer | null = null;
  private draftTimer: Timer | null = null;
  private state: AutosaveState;
  private readonly opts: Required<Pick<AutosaveOptions, "debounceMs" | "maxWaitMs" | "retryBaseMs" | "retryMaxMs" | "draftDelayMs">> &
    AutosaveOptions;

  constructor(options: AutosaveOptions) {
    this.opts = { debounceMs: 1500, maxWaitMs: 10_000, retryBaseMs: 2000, retryMaxMs: 30_000, draftDelayMs: 400, ...options };
    this.base = options.contentVersion;
    this.latest = normalizeDoc(options.doc);
    this.latestJson = this.savedJson = JSON.stringify(this.latest);
    this.state = { status: "saved", lastSavedAt: options.lastSavedAt ?? null, error: null, stopped: false };
  }

  get current(): AutosaveState {
    return this.state;
  }

  get contentVersion(): number {
    return this.base;
  }

  /** The latest version, saved or not. */
  get latestDoc(): NotebookDoc {
    return this.latest;
  }

  hasUnsaved(): boolean {
    return this.latestJson !== this.savedJson || this.inflight !== null;
  }

  /** The editor changed (already normalized). */
  update(doc: NotebookDoc): void {
    if (this.disposed) return;
    this.latest = doc;
    this.latestJson = JSON.stringify(doc);
    if (this.latestJson === this.savedJson) {
      this.clearTimer("debounce");
      this.clearTimer("maxWait");
      this.clearTimer("draftTimer");
      if (!this.stopped) this.opts.draft.clear();
      if (!this.inflight && !this.stopped) this.setState({ status: "saved", error: null });
      return;
    }
    this.scheduleDraft();
    if (this.stopped) return; // a conflict or deletion is waiting for the user
    if (this.state.status !== "retrying") this.setState({ status: this.inflight ? "saving" : "unsaved", error: null });
    if (this.retryTimer) return; // the retry sends the latest version
    this.clearTimer("debounce");
    this.debounce = setTimeout(() => void this.run(), this.opts.debounceMs);
    if (!this.maxWait) this.maxWait = setTimeout(() => void this.run(), this.opts.maxWaitMs);
  }

  /**
   * Saves now. Resolves true once nothing is left unsaved; false when it
   * can't be saved yet (an error, a conflict, a deleted entry), in which case
   * the changes are kept as a local draft.
   */
  async flush(): Promise<boolean> {
    this.writeDraftNow();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.inflight) await this.inflight;
      if (!this.hasUnsaved()) return true;
      if (this.stopped || this.latestJson === this.refusedJson) return false;
      await this.run();
      if (this.state.status === "retrying" || this.state.status === "error") return false;
    }
    return !this.hasUnsaved();
  }

  /** Retries now (the "Retry" button). */
  retry(): void {
    this.retries = 0;
    this.refusedJson = null;
    void this.run();
  }

  /**
   * Continues from a version the user chose after a conflict or a deletion
   * (e.g. the other person's): it becomes the saved state, and the local
   * draft is dropped.
   */
  rebase(doc: NotebookDoc, contentVersion: number, lastSavedAt?: string | null): void {
    this.clearAllTimers();
    this.stopped = false;
    this.retries = 0;
    this.refusedJson = null;
    this.base = contentVersion;
    this.latest = normalizeDoc(doc);
    this.latestJson = this.savedJson = JSON.stringify(this.latest);
    this.opts.draft.clear();
    this.setState({ status: "saved", lastSavedAt: lastSavedAt ?? this.state.lastSavedAt, error: null, stopped: false });
  }

  /**
   * Puts a recovered local draft back. It is saved against the version it
   * was based on, so if the entry changed since, the save is refused and the
   * conflict is shown instead of either version being lost.
   */
  restore(doc: NotebookDoc, baseContentVersion: number): void {
    this.base = baseContentVersion;
    this.update(normalizeDoc(doc));
  }

  /**
   * The user discarded the unsaved changes (or saved them elsewhere): stop,
   * forget them and their draft, and send nothing more, not even on close.
   */
  abandon(): void {
    this.clearAllTimers();
    this.stopped = true;
    this.savedJson = this.latestJson;
    this.opts.draft.clear();
  }

  /** Keeps the latest version as a local draft now (e.g. on pagehide). */
  writeDraftNow(): void {
    this.clearTimer("draftTimer");
    if (this.latestJson !== this.savedJson) this.opts.draft.write(this.latest, this.base);
  }

  /**
   * The editor is closing (another entry, another tab, another page). The
   * draft is written, and unsaved changes are sent one last time; the draft
   * stays until that save is confirmed.
   */
  dispose(): void {
    if (this.disposed) return;
    this.writeDraftNow();
    this.clearAllTimers();
    const unsaved = this.latestJson !== this.savedJson && !this.stopped && this.latestJson !== this.refusedJson;
    this.disposed = true;
    if (unsaved && !this.inflight) void this.send();
  }

  private run(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.clearTimer("debounce");
    this.clearTimer("maxWait");
    this.clearTimer("retryTimer");
    if (this.stopped || this.disposed) return Promise.resolve();
    if (this.latestJson === this.savedJson) {
      this.setState({ status: "saved", error: null });
      return Promise.resolve();
    }
    if (this.latestJson === this.refusedJson) return Promise.resolve();
    const check = validateDoc(this.latest);
    if (!check.ok) {
      // Can't be saved as it is; the next change tries again.
      this.refusedJson = this.latestJson;
      this.writeDraftNow();
      this.setState({ status: "error", error: `Not saved: ${check.error}.` });
      return Promise.resolve();
    }
    return this.send();
  }

  private send(): Promise<void> {
    const doc = this.latest;
    const json = this.latestJson;
    const expected = this.base;
    this.setState({ status: "saving", error: null });
    this.inflight = this.opts
      .save(doc, expected)
      .then(
        (entry) => {
          this.base = entry.contentVersion;
          this.savedJson = json;
          this.retries = 0;
          if (this.disposed) {
            if (this.latestJson === json) this.opts.draft.clear();
            // Closed with newer changes than this save: send those too
            // (a task later, once the finally below has cleared this one).
            else setTimeout(() => void (this.inflight ?? this.send()), 0);
            return;
          }
          this.opts.onSaved?.(entry);
          if (this.latestJson === json) {
            this.clearTimer("draftTimer");
            this.opts.draft.clear();
            this.setState({ status: "saved", lastSavedAt: entry.contentUpdatedAt ?? entry.updatedAt, error: null });
          } else {
            // Changed while saving: the next save follows.
            this.setState({ status: "unsaved", lastSavedAt: entry.contentUpdatedAt ?? entry.updatedAt, error: null });
            this.debounce = setTimeout(() => void this.run(), this.opts.debounceMs);
          }
        },
        (err) => this.failed(err, json)
      )
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private failed(err: unknown, json: string) {
    if (this.disposed) return; // the draft stays and is offered next time
    const refusal = notebookRefusal(err);
    this.writeDraftNow();
    if (refusal?.code === "conflict") {
      this.stopped = true;
      this.clearAllTimers();
      this.setState({ status: "conflict", error: refusal.message, stopped: true });
      this.opts.onConflict?.(refusal, this.latest);
      return;
    }
    if (refusal?.code === "deleted") {
      this.stopped = true;
      this.clearAllTimers();
      this.setState({ status: "deleted", error: refusal.message, stopped: true });
      this.opts.onDeleted?.(refusal, this.latest);
      return;
    }
    if (isRetryableSaveError(err)) {
      this.retries += 1;
      const delay = Math.min(this.opts.retryBaseMs * 2 ** (this.retries - 1), this.opts.retryMaxMs);
      this.setState({ status: "retrying", error: "Couldn't reach the server; your changes will be saved when it's back." });
      this.retryTimer = setTimeout(() => void this.run(), delay);
      return;
    }
    if (refusal?.code === "invalid_document") {
      this.refusedJson = json;
      this.setState({ status: "error", error: `Not saved: ${refusal.message}.` });
      return;
    }
    // Lost access, device gone, or another refusal the user must see.
    this.stopped = true;
    this.clearAllTimers();
    this.setState({
      status: "error",
      error: `Not saved: ${refusal?.message ?? (err instanceof Error ? err.message : "request failed")}`,
      stopped: true,
    });
  }

  private scheduleDraft() {
    if (this.draftTimer) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.writeDraftNow();
    }, this.opts.draftDelayMs);
  }

  private setState(patch: Partial<AutosaveState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.opts.onState(this.state);
  }

  private clearTimer(name: "debounce" | "maxWait" | "retryTimer" | "draftTimer") {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  private clearAllTimers() {
    this.clearTimer("debounce");
    this.clearTimer("maxWait");
    this.clearTimer("retryTimer");
    this.clearTimer("draftTimer");
  }
}
