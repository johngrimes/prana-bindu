import { Settings, type Settings as SettingsT } from "../shared/schemas.js";

/** Defaults per docs/spec.md §1.2; `timeZone` comes from the deployment (createDomain option). */
export function defaultSettings(timeZone: string): SettingsT {
  return {
    timeZone,
    dateFormat: "MM/dd/yyyy",
    firstWeekday: 1,
    use24HourTime: false,
    defaultDeferTime: "00:00",
    defaultDueTime: "17:00",
    defaultPlannedTime: "09:00",
    dueSoonSeconds: 172_800,
    theme: "system",
    forecastTagId: null,
  };
}

const KEYS = Object.keys(Settings.shape) as (keyof SettingsT)[];

/** Merges stored key/value rows over the defaults, ignoring unknown keys and invalid values. */
export function settingsFromRows(rows: { key: string; valueJson: string }[], defaults: SettingsT): SettingsT {
  const out: Record<string, unknown> = { ...defaults };
  for (const row of rows) {
    if (!(KEYS as string[]).includes(row.key)) continue;
    let value: unknown;
    try {
      value = JSON.parse(row.valueJson);
    } catch {
      continue;
    }
    const field = Settings.shape[row.key as keyof SettingsT];
    if (field.safeParse(value).success) out[row.key] = value;
  }
  return out as SettingsT;
}

export const SETTINGS_KEYS = KEYS;
