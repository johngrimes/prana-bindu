import type { Settings } from "../../shared/schemas";
import { parseDate, type DateField } from "../../shared/nlparse";

/** Instant client-side preview of a natural-language date (the server re-parses authoritatively). */
export function previewDate(text: string, field: DateField, settings: Settings, now = new Date()): string | null {
  if (!text.trim()) return null;
  return parseDate(text, {
    field,
    now,
    timeZone: settings.timeZone,
    defaults: { defer: settings.defaultDeferTime, due: settings.defaultDueTime, planned: settings.defaultPlannedTime },
    dateFormat: settings.dateFormat,
  });
}

export { formatDuration, parseDuration } from "../../shared/nlparse";
