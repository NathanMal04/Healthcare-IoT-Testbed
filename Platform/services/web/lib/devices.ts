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
  role: string;
  reverseEngineeringStatus: ReverseEngineeringStatus;
}

export async function getDevices(): Promise<Device[]> {
  const data = await apiRequest<{ devices: Device[] }>("GET", "/devices");
  // Devices without the attribute haven't been started.
  return data.devices.map((device) => ({
    ...device,
    reverseEngineeringStatus: toReverseEngineeringStatus(device.reverseEngineeringStatus),
  }));
}

export interface NewDevice {
  name: string;
  type: string;
}

export interface CreatedDevice {
  deviceId: string;
  name: string;
  type: string;
  status: string;
  reverseEngineeringStatus: ReverseEngineeringStatus;
  dataPath: string;
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
