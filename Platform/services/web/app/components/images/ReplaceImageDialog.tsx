"use client";

import { useEffect, useRef, useState } from "react";
import { Replace } from "lucide-react";
import { formatBytes, isAbortError } from "@/lib/artifacts";
import {
  IMAGE_ACCEPT,
  applyImageReplacement,
  checkImageFile,
  imageErrorMessage,
  imageTitle,
  replaceImageFile,
  type ImageArtifact,
  type ImageFileCheck,
  type ImageMimeType,
  type ReplacementStage,
} from "@/lib/images";
import { useScopeLock } from "@/context/WorkspaceContext";
import { Alert, Button, Dialog, labelClass } from "@/app/components/ui";
import { ImageView } from "./ImageGrid";
import type { ImageUrls } from "./useImageData";

const STAGE_LABELS: Record<ReplacementStage, string> = {
  hashing: "Checking the file",
  uploading: "Uploading",
  verifying: "Verifying and replacing",
};

interface Choice {
  file: File;
  mimeType: ImageMimeType;
  previewUrl: string;
}

/**
 * Replaces an image's file, keeping the image itself: its title,
 * description, capture date, tags and device links don't change. The new
 * file is checked here (format from its bytes, size), shown next to the
 * current one, and only uploaded once the user confirms that the current
 * file will be permanently deleted. If anything fails, the current file
 * stays the live one.
 */
export default function ReplaceImageDialog({
  image,
  urls,
  onClose,
  onReplaced,
}: {
  image: ImageArtifact;
  urls: ImageUrls;
  onClose: () => void;
  /** `cleanupPending`: replaced, but the old file is still being deleted. */
  onReplaced: (image: ImageArtifact, cleanupPending: boolean) => void;
}) {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [checking, setChecking] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [stage, setStage] = useState<ReplacementStage | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Only the latest chosen file's check may set the choice.
  const checkIdRef = useRef(0);

  const busy = stage !== null;
  // The replacement belongs to the image's scope; don't let the scope change under it.
  useScopeLock(busy);

  useEffect(() => {
    if (!choice) return;
    return () => URL.revokeObjectURL(choice.previewUrl);
  }, [choice]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const title = imageTitle(image);

  async function choose(file: File | undefined) {
    if (!file || busy) return;
    const checkId = ++checkIdRef.current;
    setChoice(null);
    setConfirmed(false);
    setError(null);
    setFileError(null);
    setChecking(true);
    let check: ImageFileCheck;
    try {
      check = await checkImageFile(file);
    } catch {
      check = { ok: false, reason: "couldn't be read" };
    }
    if (checkId !== checkIdRef.current) return;
    setChecking(false);
    if (!check.ok) {
      setFileError(`${file.name} can't be used: ${check.reason}. Choose a JPEG, PNG or WebP image of at most 25 MiB.`);
      return;
    }
    setChoice({ file, mimeType: check.mimeType, previewUrl: URL.createObjectURL(file) });
  }

  async function replace() {
    if (!choice || !confirmed || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    let reached: ReplacementStage = "hashing";
    setError(null);
    setProgress(0);
    setStage("hashing");
    try {
      const result = await replaceImageFile(image, choice.file, choice.mimeType, {
        onStage: (next) => {
          reached = next;
          setStage(next);
          setProgress(0);
        },
        onProgress: setProgress,
        signal: controller.signal,
      });
      onReplaced(applyImageReplacement(image, result.image), result.cleanupPending);
    } catch (err) {
      setError(failureMessage(err, reached));
      setStage(null);
    } finally {
      abortRef.current = null;
    }
  }

  function close() {
    if (!busy) onClose();
  }

  return (
    <Dialog title="Replace image" subtitle={title} size="xl" onClose={close}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <figure className="space-y-2 min-w-0">
            <figcaption className="text-xs font-medium text-slate-500">Current file</figcaption>
            <div className="rounded-lg overflow-hidden bg-navy-950 h-48">
              <ImageView image={image} urls={urls} fit="contain" lazy={false} className="h-full w-full bg-navy-950" />
            </div>
            <p className="text-xs text-slate-500 break-all">
              {image.originalFilename} · {image.mimeType.replace("image/", "").toUpperCase()} · {formatBytes(image.sizeBytes)}
            </p>
          </figure>
          <figure className="space-y-2 min-w-0">
            <figcaption className="text-xs font-medium text-slate-500">New file</figcaption>
            <div className="rounded-lg overflow-hidden bg-surface-sunken h-48 flex items-center justify-center">
              {choice ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local object URL preview
                <img src={choice.previewUrl} alt={`New file for ${title}`} className="h-full w-full object-contain" />
              ) : (
                <span className="text-xs text-slate-400">{checking ? "Checking the file…" : "No file chosen yet"}</span>
              )}
            </div>
            {choice && (
              <p className="text-xs text-slate-500 break-all">
                {choice.file.name} · {choice.mimeType.replace("image/", "").toUpperCase()} · {formatBytes(choice.file.size)}
              </p>
            )}
          </figure>
        </div>

        <div>
          <label htmlFor="replace-image-file" className={labelClass}>
            New image file
          </label>
          <input
            id="replace-image-file"
            type="file"
            accept={IMAGE_ACCEPT}
            disabled={busy}
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              // Lets the same file be chosen again after an error.
              e.target.value = "";
            }}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100"
          />
          <p className="text-xs text-slate-400 mt-1">JPEG, PNG or WebP, at most 25 MiB.</p>
        </div>
        {fileError && <Alert tone="error">{fileError}</Alert>}

        <Alert tone="warning">
          Replacing <strong>permanently deletes the current file</strong> ({image.originalFilename}). It can&apos;t be
          recovered: images have no version history. The title, description, capture date, tags and device links stay
          as they are.
        </Alert>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={!choice || busy}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          I understand the current file will be permanently deleted.
        </label>

        {stage && (
          <div className="space-y-1" role="status" aria-live="polite">
            <p className="text-sm text-slate-600">
              {STAGE_LABELS[stage]}…{stage !== "verifying" && ` ${Math.round(progress * 100)}%`}
            </p>
            <div className="h-1.5 rounded-full bg-surface-sunken overflow-hidden">
              <div
                className={`h-full bg-brand-500 ${stage === "verifying" ? "w-full animate-pulse" : ""}`}
                style={stage === "verifying" ? undefined : { width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          </div>
        )}
        {error && <Alert tone="error">{error}</Alert>}

        <div className="flex items-center gap-2 pt-2">
          {busy && stage !== "verifying" ? (
            <Button variant="secondary" onClick={() => abortRef.current?.abort()} className="flex-1">
              Cancel upload
            </Button>
          ) : (
            <Button variant="secondary" onClick={close} disabled={busy} className="flex-1">
              Cancel
            </Button>
          )}
          <Button icon={Replace} onClick={() => void replace()} disabled={!choice || !confirmed || busy} className="flex-1">
            {busy ? "Replacing…" : "Replace image"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

const KEPT = "The current image was kept.";
const UNCONFIRMED = "Couldn't confirm whether the image was replaced. Refresh the gallery to see which file is current.";

/** The backend's 409 answers, in this dialog's terms ("Replace image" starts over with a new upload). */
const CONFLICTS: [RegExp, string][] = [
  [/has changed since it was loaded/i,
    "This image was changed since the gallery loaded it (someone may have replaced it). Refresh the gallery and try again."],
  [/no longer current|started at the same time/i,
    "Another replacement of this image was started, so this one was cancelled. Try again if you still want to use this file."],
  [/not found yet/i, "The uploaded file couldn't be found to verify it. Try again."],
  [/could not read the uploaded file/i, "The uploaded file couldn't be read to verify it. Try again."],
];

/** Ends a message with a full stop, so another sentence can follow it. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** What went wrong, and what that means for the current file. */
function failureMessage(err: unknown, stage: ReplacementStage): string {
  if (isAbortError(err)) return `Replacement cancelled. ${KEPT}`;
  if (err instanceof Error && err.name === "S3TransferError") {
    const expired = "status" in err && err.status === 403;
    return `${expired ? "The upload link expired" : "The upload failed"}. ${KEPT} Try again.`;
  }
  const status = err instanceof Error && "status" in err && typeof err.status === "number" ? err.status : null;
  // Completing it may have swapped the file in before failing (a server
  // error, a gateway timeout) or reached the backend unanswered (network):
  // the outcome is unknown, so never claim the old file was kept.
  if (stage === "verifying" && (status === null || status >= 500)) return UNCONFIRMED;

  const message = imageErrorMessage(err, "Couldn't replace the image");
  if (status === 409) {
    const known = CONFLICTS.find(([pattern]) => pattern.test(message));
    if (known) return `${known[1]} ${KEPT}`;
  }
  if (/current image was kept/i.test(message)) return sentence(message.replace(/; the current image was kept\.?$/i, `. ${KEPT}`));
  return `${sentence(message)} ${KEPT}`;
}
