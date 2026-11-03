"use client";

import type { DeviceViewProps } from "./DeviceListView";
import DeviceCard, { DeviceCardSkeleton } from "./DeviceCard";

const GRID = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 p-4 sm:p-5";

/** The devices as cards, in the order the page chose (the same rows as the list). */
export default function DeviceGridView({ devices, figuresFor, urls, handlers }: Omit<DeviceViewProps, "onOpen">) {
  return (
    <ul className={GRID} aria-label="Devices">
      {devices.map((device) => (
        <li key={device.deviceId} className="flex">
          <DeviceCard device={device} figures={figuresFor(device)} urls={urls} handlers={handlers} />
        </li>
      ))}
    </ul>
  );
}

export function DeviceGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={GRID} aria-busy="true" aria-label="Loading devices">
      {Array.from({ length: count }, (_, i) => (
        <DeviceCardSkeleton key={i} />
      ))}
    </div>
  );
}
