import { apiRequest } from "@/lib/api";
import { toReverseEngineeringStatus, type ReverseEngineeringStatus } from "@/lib/reverseEngineering";

export {
  REVERSE_ENGINEERING_STATUSES,
  REVERSE_ENGINEERING_STATUS_LABELS,
  type ReverseEngineeringStatus,
} from "@/lib/reverseEngineering";

/** Limits enforced by the API (device_fields.py), in characters after trimming. */
export const DEVICE_NAME_MAX_LENGTH = 255;
export const DEVICE_TYPE_MAX_LENGTH = 100;

/** The optional descriptive fields of a device, in display order. */
export const DEVICE_DETAIL_FIELDS = [
  { key: "manufacturer", label: "Manufacturer", maxLength: 100, placeholder: "Philips" },
  { key: "modelNumber", label: "Model number", maxLength: 100, placeholder: "MX800" },
  { key: "chipset", label: "Chipset", maxLength: 100, placeholder: "nRF52840" },
  { key: "serialNumber", label: "Serial number", maxLength: 100, placeholder: "SN-0001" },
  { key: "hardwareRevision", label: "Hardware revision", maxLength: 50, placeholder: "Rev B" },
  { key: "firmwareVersion", label: "Firmware version", maxLength: 100, placeholder: "2.4.1" },
  { key: "description", label: "Description", maxLength: 2000, multiline: true },
] as const;

export type DeviceDetailKey = (typeof DEVICE_DETAIL_FIELDS)[number]["key"];
/** Only the details a device has are present. */
export type DeviceDetails = Partial<Record<DeviceDetailKey, string>>;

export interface Device extends DeviceDetails {
  deviceId: string;
  name: string;
  /** Absent only for a device whose record couldn't be read. */
  type?: string;
  /** Personal devices: the ownership role. Workspace devices: the user's role in the workspace. */
  role: string;
  reverseEngineeringStatus: ReverseEngineeringStatus;
  /** Set only on workspace devices. */
  workspaceId?: string;
  /** Workspace devices only: the member who created it. */
  createdBy?: string;
  /** From GET /devices/{deviceId} only. */
  createdAt?: string;
  updatedAt?: string;
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

/** One device with all of its details. */
export async function getDevice(deviceId: string): Promise<Device> {
  const device = await apiRequest<Device>("GET", `/devices/${encodeURIComponent(deviceId)}`);
  return { ...device, reverseEngineeringStatus: toReverseEngineeringStatus(device.reverseEngineeringStatus) };
}

export interface NewDevice extends DeviceDetails {
  name: string;
  type: string;
  /** Creates the device in this workspace; omitted for a personal device. */
  workspaceId?: string;
}

export interface CreatedDevice extends DeviceDetails {
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

/** A PATCH body: only the fields to change. null removes an optional detail. */
export type DeviceUpdate = {
  name?: string;
  type?: string;
  reverseEngineeringStatus?: ReverseEngineeringStatus;
} & Partial<Record<DeviceDetailKey, string | null>>;

export interface UpdatedDevice extends DeviceDetails {
  deviceId: string;
  name: string | null;
  type?: string | null;
  reverseEngineeringStatus: ReverseEngineeringStatus;
  updatedAt: string | null;
  workspaceId?: string;
}

export async function updateDevice(deviceId: string, update: DeviceUpdate): Promise<UpdatedDevice> {
  return apiRequest<UpdatedDevice>("PATCH", `/devices/${encodeURIComponent(deviceId)}`, { body: update });
}

export async function updateDeviceReverseEngineeringStatus(
  deviceId: string,
  reverseEngineeringStatus: ReverseEngineeringStatus
): Promise<UpdatedDevice> {
  return updateDevice(deviceId, { reverseEngineeringStatus });
}

// --- The add/edit form ---------------------------------------------------------

/** Every field as the form edits it: untrimmed text, "" when empty. */
export type DeviceForm = { name: string; type: string } & Record<DeviceDetailKey, string>;

export function emptyDeviceForm(): DeviceForm {
  return deviceToForm({ name: "", type: "" });
}

export function deviceToForm(device: Pick<Device, "name" | "type"> & DeviceDetails): DeviceForm {
  const form = { name: device.name ?? "", type: device.type ?? "" } as DeviceForm;
  for (const { key } of DEVICE_DETAIL_FIELDS) form[key] = device[key] ?? "";
  return form;
}

/** The first problem that would stop the form being saved, or null. */
export function deviceFormError(form: DeviceForm): string | null {
  if (!form.name.trim()) return "Device name is required";
  if (!form.type.trim()) return "Device type is required";
  if (form.name.trim().length > DEVICE_NAME_MAX_LENGTH) {
    return `Device name must be at most ${DEVICE_NAME_MAX_LENGTH} characters`;
  }
  if (form.type.trim().length > DEVICE_TYPE_MAX_LENGTH) {
    return `Device type must be at most ${DEVICE_TYPE_MAX_LENGTH} characters`;
  }
  for (const { key, label, maxLength } of DEVICE_DETAIL_FIELDS) {
    if (form[key].trim().length > maxLength) return `${label} must be at most ${maxLength} characters`;
  }
  return null;
}

/** The POST body for a new device: trimmed, with empty details left out. */
export function newDeviceBody(form: DeviceForm, workspaceId?: string): NewDevice {
  const body: NewDevice = { name: form.name.trim(), type: form.type.trim() };
  for (const { key } of DEVICE_DETAIL_FIELDS) {
    const value = form[key].trim();
    if (value) body[key] = value;
  }
  if (workspaceId) body.workspaceId = workspaceId;
  return body;
}

/**
 * The PATCH body for an edit: only the fields that changed, trimmed. A detail
 * that was cleared is sent as null, which removes it.
 */
export function deviceUpdateBody(device: Device, form: DeviceForm): DeviceUpdate {
  const update: DeviceUpdate = {};
  const name = form.name.trim();
  const type = form.type.trim();
  if (name !== device.name) update.name = name;
  if (type !== (device.type ?? "")) update.type = type;
  for (const { key } of DEVICE_DETAIL_FIELDS) {
    const value = form[key].trim();
    const current = device[key] ?? "";
    if (value !== current) update[key] = value || null;
  }
  return update;
}

/** The device after an update: the fields from the response, and the caller's role kept. */
export function applyDeviceUpdate(device: Device, updated: UpdatedDevice): Device {
  const next: Device = { ...device };
  for (const { key } of DEVICE_DETAIL_FIELDS) delete next[key];
  for (const { key } of DEVICE_DETAIL_FIELDS) {
    const value = updated[key];
    if (value) next[key] = value;
  }
  if (updated.name) next.name = updated.name;
  if (updated.type) next.type = updated.type;
  next.reverseEngineeringStatus = toReverseEngineeringStatus(updated.reverseEngineeringStatus);
  if (updated.updatedAt) next.updatedAt = updated.updatedAt;
  return next;
}
