"use client";

import { useState } from "react";
import { Microchip, Upload } from "lucide-react";
import { canEditDevice, type Device } from "@/lib/devices";
import type { Artifact } from "@/lib/artifacts";
import FirmwareUploadDialog from "@/app/components/firmware/FirmwareUploadDialog";
import { FirmwareRetryDialog, FirmwareTable, useFirmwareReStatus } from "@/app/components/firmware/FirmwareList";
import { Alert, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState } from "@/app/components/ui";

/** The device's firmware versions: upload, retry, and each version's reverse-engineering status. */
export default function FirmwareSection({
  device,
  firmware,
  setFirmware,
  error,
  reload,
}: {
  device: Device;
  firmware: Artifact[] | null;
  setFirmware: React.Dispatch<React.SetStateAction<Artifact[] | null>>;
  error: string | null;
  reload: () => Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [retryFirmware, setRetryFirmware] = useState<Artifact | null>(null);
  const { savingReIds, reError, setReError, changeReStatus } = useFirmwareReStatus(setFirmware);
  // Viewers see the versions and their status, and can download them.
  const canEdit = canEditDevice(device);
  const uploadButton = canEdit ? (
    <Button size="sm" icon={Upload} onClick={() => setUploading(true)}>
      Upload firmware
    </Button>
  ) : undefined;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Firmware"
        description="Firmware versions uploaded for this device"
        actions={uploadButton}
      />
      {reError && (
        <Alert tone="error" className="mx-5 mt-3" onDismiss={() => setReError(null)}>
          {reError}
        </Alert>
      )}
      {error ? (
        <ErrorState title="Couldn't load firmware" message={error} />
      ) : firmware === null ? (
        <LoadingState label="Loading firmware…" />
      ) : firmware.length === 0 ? (
        <EmptyState
          icon={Microchip}
          title="No firmware uploaded yet"
          action={uploadButton}
        />
      ) : (
        <FirmwareTable
          firmware={firmware}
          savingReIds={savingReIds}
          onReStatusChange={canEdit ? (f, next) => void changeReStatus(f, next) : undefined}
          onRetry={canEdit ? setRetryFirmware : undefined}
        />
      )}

      {uploading && (
        <FirmwareUploadDialog device={device} onClose={() => setUploading(false)} onUploaded={() => void reload()} />
      )}
      {retryFirmware && (
        <FirmwareRetryDialog
          firmware={retryFirmware}
          onClose={() => setRetryFirmware(null)}
          onRetried={() => void reload().catch(() => undefined)}
        />
      )}
    </Card>
  );
}
