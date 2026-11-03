"use client";

import { Cpu } from "lucide-react";
import { ButtonLink, Card, EmptyState, ErrorState, PageHeader } from "@/app/components/ui";

const DEVICES_BACK = { href: "/devices", label: "Devices" };

function BackToDevices() {
  return (
    <ButtonLink href="/devices" variant="secondary" size="sm">
      Back to Devices
    </ButtonLink>
  );
}

/** A device link without an id. */
export function NoDeviceSelected() {
  return <EmptyState icon={Cpu} title="No device selected" action={<BackToDevices />} />;
}

export function DeviceLoadError({ message }: { message: string }) {
  return (
    <>
      <PageHeader title="Device" back={DEVICES_BACK} />
      <Card>
        <ErrorState title="Couldn't load the device" message={message} />
      </Card>
    </>
  );
}

/** The device isn't in the current scope, or isn't available to the user. */
export function DeviceNotFound({ scopeName }: { scopeName: string }) {
  return (
    <>
      <PageHeader title="Device not found" back={DEVICES_BACK} />
      <Card>
        <EmptyState
          icon={Cpu}
          title={`This device isn't available in ${scopeName}.`}
          description="It may belong to a different workspace or to Personal. Switch scope, or go back to this scope's devices."
          action={<BackToDevices />}
        />
      </Card>
    </>
  );
}
