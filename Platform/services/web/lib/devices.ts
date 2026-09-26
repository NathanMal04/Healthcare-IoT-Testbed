import { apiRequest } from "@/lib/api";

export interface Device {
  deviceId: string;
  name: string;
  role: string;
}

export async function getDevices(): Promise<Device[]> {
  const data = await apiRequest<{ devices: Device[] }>("GET", "/devices");
  return data.devices;
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
  dataPath: string;
  createdAt: string;
  updatedAt: string;
}

export async function createDevice(input: NewDevice): Promise<CreatedDevice> {
  return apiRequest<CreatedDevice>("POST", "/devices", { body: input });
}
