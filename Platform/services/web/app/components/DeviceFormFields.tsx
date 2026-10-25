"use client";

import {
  DEVICE_DETAIL_FIELDS,
  DEVICE_NAME_MAX_LENGTH,
  DEVICE_TYPE_MAX_LENGTH,
  type DeviceForm,
} from "@/lib/devices";
import { inputClass, labelClass } from "@/app/components/ui";

type SetField = (key: keyof DeviceForm, value: string) => void;

/** The two required fields: device name and type. */
export function DeviceIdentityFields({
  form,
  onChange,
  disabled,
  autoFocus,
}: {
  form: DeviceForm;
  onChange: SetField;
  disabled: boolean;
  autoFocus?: boolean;
}) {
  return (
    <>
      <div>
        <label className={labelClass} htmlFor="device-name">
          Device name
        </label>
        <input
          id="device-name"
          type="text"
          value={form.name}
          onChange={(e) => onChange("name", e.target.value)}
          disabled={disabled}
          maxLength={DEVICE_NAME_MAX_LENGTH}
          className={inputClass}
          placeholder="Philips IntelliVue MX800"
          autoFocus={autoFocus}
        />
      </div>
      <div>
        <label className={labelClass} htmlFor="device-type">
          Device type
        </label>
        <input
          id="device-type"
          type="text"
          value={form.type}
          onChange={(e) => onChange("type", e.target.value)}
          disabled={disabled}
          maxLength={DEVICE_TYPE_MAX_LENGTH}
          className={inputClass}
          placeholder="Patient monitor"
        />
      </div>
    </>
  );
}

/** The optional descriptive fields. Any of them may be left empty. */
export function DeviceDetailFields({
  form,
  onChange,
  disabled,
}: {
  form: DeviceForm;
  onChange: SetField;
  disabled: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {DEVICE_DETAIL_FIELDS.map((field) => {
        const id = `device-${field.key}`;
        const multiline = "multiline" in field && field.multiline;
        return (
          <div key={field.key} className={multiline ? "sm:col-span-2" : undefined}>
            <label className={labelClass} htmlFor={id}>
              {field.label}
            </label>
            {multiline ? (
              <textarea
                id={id}
                value={form[field.key]}
                onChange={(e) => onChange(field.key, e.target.value)}
                disabled={disabled}
                maxLength={field.maxLength}
                rows={3}
                className={inputClass}
                placeholder="What the device is and how it is used in the testbed"
              />
            ) : (
              <input
                id={id}
                type="text"
                value={form[field.key]}
                onChange={(e) => onChange(field.key, e.target.value)}
                disabled={disabled}
                maxLength={field.maxLength}
                className={inputClass}
                placeholder={"placeholder" in field ? field.placeholder : undefined}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
