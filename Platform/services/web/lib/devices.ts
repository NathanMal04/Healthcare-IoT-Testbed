import { apiRequest } from "@/lib/api";
import { toReverseEngineeringStatus, type ReverseEngineeringStatus } from "@/lib/reverseEngineering";

export {
  REVERSE_ENGINEERING_STATUSES,
  REVERSE_ENGINEERING_STATUS_LABELS,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";

export interface Device {
  deviceId: string;
  name: string;
  /** Personal devices: the ownership role. Workspace devices: the user's role in the workspace. */
  role: string;
  reverseEngineeringStatus: ReverseEngineeringStatus;
  /** Set only on workspace devices. */
  workspaceId?: string;
}

/** Personal devices, or the devices of a workspace when workspaceId is given. */
export async function getDevices(workspaceId?: string): Promise<Device[]> {
  const data = await apiRequest<{ devices: Device[] }>("GET", "/devices", { query: { workspaceId } });
  // Devices without the attribute haven't been started.
  return data.devices.map((device) => ({
    ...device,
    reverseEngineeringStatus: toReverseEngineeringStatus(device.reverseEngineeringStatus),
  }));
}

export interface NewDevice {
  name: string;
  type: string;
  /** Creates the device in this workspace; omitted for a personal device. */
  workspaceId?: string;
}

export interface CreatedDevice {
  deviceId: string;
  name: string;
  type: string;
  status: string;
  reverseEngineeringStatus: ReverseEngineeringStatus;
  dataPath: string;
  workspaceId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export async function createDevice(input: NewDevice): Promise<CreatedDevice> {
  return apiRequest<CreatedDevice>("POST", "/devices", { body: input });
}

export interface UpdatedDevice {
  deviceId: string;
  name: string | null;
  reverseEngineeringStatus: ReverseEngineeringStatus;
  updatedAt: string | null;
}

export async function updateDeviceReverseEngineeringStatus(
  deviceId: string,
  reverseEngineeringStatus: ReverseEngineeringStatus
): Promise<UpdatedDevice> {
  return apiRequest<UpdatedDevice>("PATCH", `/devices/${encodeURIComponent(deviceId)}`, {
    body: { reverseEngineeringStatus },
  });
}
