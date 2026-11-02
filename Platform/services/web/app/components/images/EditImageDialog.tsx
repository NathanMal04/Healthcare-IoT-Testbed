"use client";

import { useState } from "react";
import {
  MAX_IMAGE_DESCRIPTION_LENGTH,
  MAX_IMAGE_TITLE_LENGTH,
  applyImageUpdate,
  capturedAtHasTime,
  imageErrorMessage,
  imageFormError,
  imageToForm,
  imageTitle,
  imageUpdateBody,
  todayInput,
  updateImageMetadata,
  type ImageArtifact,
  type ImageForm,
} from "@/lib/images";
import { useScopeLock } from "@/context/WorkspaceContext";
import { Alert, Button, Dialog, inputClass, labelClass } from "@/app/components/ui";

/**
 * Edits an image's title, description and capture date. Only changed
 * fields are sent (PATCH /artifacts/{id}); a cleared description or date is
 * removed. The file, its format and the artifact itself can't be changed.
 */
export default function EditImageDialog({
  image,
  onClose,
  onSaved,
}: {
  image: ImageArtifact;
  onClose: () => void;
  onSaved: (image: ImageArtifact) => void;
}) {
  const [form, setForm] = useState<ImageForm>(() => imageToForm(image));
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The edit belongs to the image's scope; don't let the scope change under it.
  useScopeLock(submitting);

  // An unchanged capture date isn't re-validated (nor sent).
  const formError = imageFormError(form, new Date(), image);
  const update = imageUpdateBody(image, form);
  const changed = Object.keys(update).length > 0;

  function setField(key: keyof ImageForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function close() {
    if (!submitting) onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (formError || submitting) return;
    if (!changed) {
      onClose();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      onSaved(applyImageUpdate(image, await updateImageMetadata(image.artifactId, update)));
    } catch (err) {
      setSubmitError(imageErrorMessage(err, "Couldn't save the image details"));
      setSubmitting(false);
    }
  }

  return (
    <Dialog title="Edit image details" subtitle={imageTitle(image)} size="lg" onClose={close}>
      {/* noValidate: the checks above are the rules (imageFormError). The browser's
          own, from the date input's max, would block saving other fields when
          the stored date is one the backend accepted with its time-zone slack. */}
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label htmlFor="image-title" className={labelClass}>
            Title
          </label>
          <input
            id="image-title"
            type="text"
            value={form.title}
            onChange={(e) => setField("title", e.target.value)}
            disabled={submitting}
            maxLength={MAX_IMAGE_TITLE_LENGTH}
            required
            autoFocus
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="image-captured-at" className={labelClass}>
            Captured on <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <div className="flex gap-2">
            <input
              id="image-captured-at"
              type="date"
              value={form.capturedAt}
              min="1970-01-01"
              max={todayInput()}
              onChange={(e) => setField("capturedAt", e.target.value)}
              disabled={submitting}
              className={inputClass}
            />
            {form.capturedAt && (
              <Button variant="secondary" onClick={() => setField("capturedAt", "")} disabled={submitting}>
                Clear
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            When the photograph was taken, which can be long before it was uploaded.
            {capturedAtHasTime(image.capturedAt) && " It was saved with a time of day; choosing another date replaces it."}
          </p>
        </div>
        <div>
          <label htmlFor="image-description" className={labelClass}>
            Description <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            id="image-description"
            value={form.description}
            onChange={(e) => setField("description", e.target.value)}
            disabled={submitting}
            rows={4}
            maxLength={MAX_IMAGE_DESCRIPTION_LENGTH}
            className={`${inputClass} resize-y`}
          />
        </div>
        {formError && <p className="text-xs text-red-600">{formError}</p>}
        {submitError && <Alert tone="error">{submitError}</Alert>}
        <div className="flex items-center gap-2 pt-2">
          <Button variant="secondary" onClick={close} disabled={submitting} className="flex-1">
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || formError !== null || !changed} className="flex-1">
            {submitting ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
