import { beforeEach, describe, expect, it, vi } from "vitest";

// lib/api pulls in Amplify; only apiRequest is needed, as a mock.
vi.mock("@/lib/api", () => ({ apiRequest: vi.fn() }));

import { apiRequest } from "@/lib/api";
import {
  DEVICE_DETAIL_FIELDS,
  applyDeviceUpdate,
  createDevice,
  deviceFormError,
  deviceToForm,
  deviceUpdateBody,
  emptyDeviceForm,
  getDevice,
  newDeviceBody,
  updateDevice,
  updateDeviceReverseEngineeringStatus,
  type Device,
} from "@/lib/devices";

const request = vi.mocked(apiRequest);
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";

const DEVICE: Device = {
  deviceId: DEVICE_ID,
  name: "Infusion pump",
  type: "Pump",
  role: "owner",
  reverseEngineeringStatus: "in_progress",
  manufacturer: "Acme",
  chipset: "nRF52840",
  description: "Bench unit",
};

/** An existing device from before the details existed. */
const LEGACY: Device = { deviceId: DEVICE_ID, name: "Old pump", type: "pump", role: "owner", reverseEngineeringStatus: "not_started" };

beforeEach(() => request.mockReset());

describe("creating a device", () => {
  it("sends only the name and type when no details are given", () => {
    const form = { ...emptyDeviceForm(), name: "  Pump ", type: " Infusion " };
    expect(deviceFormError(form)).toBeNull();
    expect(newDeviceBody(form)).toEqual({ name: "Pump", type: "Infusion" });
    expect(newDeviceBody(form, "ws-1")).toEqual({ name: "Pump", type: "Infusion", workspaceId: "ws-1" });
  });

  it("trims details and leaves out the empty ones", () => {
    const form = {
      ...emptyDeviceForm(),
      name: "Pump",
      type: "Infusion",
      manufacturer: "  Acme ",
      modelNumber: "   ",
      description: "Line one\nLine two\n",
    };
    expect(newDeviceBody(form)).toEqual({
      name: "Pump",
      type: "Infusion",
      manufacturer: "Acme",
      description: "Line one\nLine two",
    });
  });

  it("requires only the name and type", () => {
    expect(deviceFormError(emptyDeviceForm())).toBe("Device name is required");
    expect(deviceFormError({ ...emptyDeviceForm(), name: "Pump", type: "  " })).toBe("Device type is required");
    expect(deviceFormError({ ...emptyDeviceForm(), name: "Pump", type: "Infusion" })).toBeNull();
  });

  it("enforces the API's length limits", () => {
    const form = { ...emptyDeviceForm(), name: "Pump", type: "Infusion" };
    expect(deviceFormError({ ...form, name: "x".repeat(256) })).toMatch(/at most 255/);
    expect(deviceFormError({ ...form, hardwareRevision: "x".repeat(51) })).toMatch(/Hardware revision/);
    expect(deviceFormError({ ...form, description: "x".repeat(2000) })).toBeNull();
  });

  it("posts the body to /devices", async () => {
    request.mockResolvedValue({});
    await createDevice({ name: "Pump", type: "Infusion", chipset: "ESP32" });
    expect(request).toHaveBeenCalledWith("POST", "/devices", { body: { name: "Pump", type: "Infusion", chipset: "ESP32" } });
  });
});

describe("editing a device", () => {
  it("prefills every field, with missing details empty", () => {
    const form = deviceToForm(DEVICE);
    expect(form).toMatchObject({ name: "Infusion pump", type: "Pump", manufacturer: "Acme", serialNumber: "" });
    expect(Object.keys(form).sort()).toEqual(["name", "type", ...DEVICE_DETAIL_FIELDS.map((f) => f.key)].sort());
    expect(deviceToForm(LEGACY).description).toBe("");
  });

  it("sends nothing when nothing changed", () => {
    expect(deviceUpdateBody(DEVICE, deviceToForm(DEVICE))).toEqual({});
    // Whitespace around an unchanged value is not a change.
    expect(deviceUpdateBody(DEVICE, { ...deviceToForm(DEVICE), manufacturer: " Acme " })).toEqual({});
  });

  it("sends only the changed fields, trimmed", () => {
    const form = { ...deviceToForm(DEVICE), name: " Pump A ", type: "Pump", serialNumber: "SN-1 " };
    expect(deviceUpdateBody(DEVICE, form)).toEqual({ name: "Pump A", serialNumber: "SN-1" });
  });

  it("sends a cleared detail as null", () => {
    const form = { ...deviceToForm(DEVICE), manufacturer: "", description: "   " };
    expect(deviceUpdateBody(DEVICE, form)).toEqual({ manufacturer: null, description: null });
  });

  it("does not clear details the device never had", () => {
    expect(deviceUpdateBody(LEGACY, { ...deviceToForm(LEGACY), chipset: "  " })).toEqual({});
  });

  it("adds details to an existing device", () => {
    expect(deviceUpdateBody(LEGACY, { ...deviceToForm(LEGACY), firmwareVersion: "2.0" })).toEqual({ firmwareVersion: "2.0" });
  });

  it("never sends the reverse-engineering status or protected fields", () => {
    const body = deviceUpdateBody(DEVICE, { ...deviceToForm(DEVICE), name: "Renamed" });
    for (const key of ["reverseEngineeringStatus", "workspaceId", "createdBy", "deviceId", "role"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("applies the response, removing cleared details and keeping the role and status", () => {
    const next = applyDeviceUpdate(
      { ...DEVICE, workspaceId: "ws-1" },
      {
        deviceId: DEVICE_ID,
        name: "Renamed",
        type: "Pump",
        reverseEngineeringStatus: "in_progress",
        updatedAt: "2026-10-24T00:00:00Z",
        chipset: "ESP32",
      }
    );
    expect(next).toEqual({
      deviceId: DEVICE_ID,
      name: "Renamed",
      type: "Pump",
      role: "owner",
      reverseEngineeringStatus: "in_progress",
      workspaceId: "ws-1",
      chipset: "ESP32",
      updatedAt: "2026-10-24T00:00:00Z",
    });
  });

  it("patches /devices/{id}", async () => {
    request.mockResolvedValue({});
    await updateDevice(DEVICE_ID, { name: "Renamed", chipset: null });
    expect(request).toHaveBeenCalledWith("PATCH", `/devices/${DEVICE_ID}`, { body: { name: "Renamed", chipset: null } });
  });

  it("still updates the reverse-engineering status on its own", async () => {
    request.mockResolvedValue({});
    await updateDeviceReverseEngineeringStatus(DEVICE_ID, "complete");
    expect(request).toHaveBeenCalledWith("PATCH", `/devices/${DEVICE_ID}`, {
      body: { reverseEngineeringStatus: "complete" },
    });
  });
});

describe("reading a device", () => {
  it("gets /devices/{id}, reading a missing status as not started", async () => {
    request.mockResolvedValue({ deviceId: DEVICE_ID, name: "Old pump", type: "pump", role: "owner" });
    const device = await getDevice(DEVICE_ID);
    expect(request).toHaveBeenCalledWith("GET", `/devices/${DEVICE_ID}`);
    expect(device.reverseEngineeringStatus).toBe("not_started");
    expect(device.manufacturer).toBeUndefined();
  });
});
