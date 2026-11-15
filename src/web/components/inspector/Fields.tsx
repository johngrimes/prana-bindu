import { useId, useRef, useState, type ReactNode } from "react";
import type { Settings } from "../../../shared/schemas";
import { bumpDate, formatDateInput, formatDateTime, toWall, wallDayKey, withDay, type DateField as DateFieldKind } from "../../lib/dates";
import { formatDuration, parseDuration, previewDate } from "../../lib/nl";
import { Icon } from "../Icons";

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="pb-label flex-1">{title}</h3>
        {actions}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function FieldRow({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-2">
      <label htmlFor={htmlFor} className="pt-2.5 text-sm text-muted">
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  mixed,
}: {
  options: Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  mixed?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="pb-seg">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={!mixed && value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Single-line text that commits on blur or Enter. */
export function CommitInput({
  value,
  onCommit,
  label,
  placeholder,
  className = "",
  id,
  multiline = false,
}: {
  value: string;
  onCommit: (text: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  id?: string;
  multiline?: boolean;
}) {
  // While focused the field edits a local draft; otherwise it shows the server value.
  const [draft, setDraft] = useState<string | null>(null);
  const common = {
    id,
    "aria-label": label,
    placeholder,
    value: draft ?? value,
    onFocus: () => setDraft(value),
    onBlur: () => {
      if (draft !== null && draft !== value) onCommit(draft);
      setDraft(null);
    },
  };
  if (multiline) {
    return (
      <textarea
        {...common}
        className={`pb-input min-h-[240px] resize-y leading-relaxed ${className}`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
      />
    );
  }
  return (
    <textarea
      {...common}
      rows={1}
      className={`pb-input resize-none overflow-hidden ${className}`}
      style={{ fieldSizing: "content" } as React.CSSProperties}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

/**
 * Natural-language date field with instant preview, calendar picker, clear and +1 day/week/month
 * buttons. `effective` shows an inherited value as implied (italic).
 */
export function DateField({
  label,
  field,
  value,
  effective,
  settings,
  onChange,
  mixed = false,
  dateOnly = false,
}: {
  label: string;
  field: DateFieldKind;
  value: string | null;
  effective?: string | null;
  settings: Settings;
  onChange: (value: string | null) => void;
  mixed?: boolean;
  dateOnly?: boolean;
}) {
  const id = useId();
  const display = value ? (dateOnly ? formatDateInput(value, settings).split(" ")[0] ?? "" : formatDateInput(value, settings)) : "";
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  const wall = value ? toWall(value, settings.timeZone) : null;
  const nativeValue = wall ? (dateOnly ? wallDayKey(wall) : `${wallDayKey(wall)}T${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`) : "";
  // Value chosen in the touch picker, committed when the picker closes (iOS fires input events while scrolling).
  const [picked, setPicked] = useState<string | null>(null);
  const fromNative = (raw: string) => (raw === "" ? null : dateOnly ? withDay(value, raw, field, settings) : `${raw}:00.000`);
  const pickedValue = picked === null || picked === nativeValue ? undefined : fromNative(picked);
  const shown = pickedValue === undefined ? display : pickedValue === null ? "" : dateOnly ? formatDateInput(pickedValue, settings).split(" ")[0] ?? "" : formatDateInput(pickedValue, settings);
  const editing = draft !== null;
  const text = draft ?? shown;
  const preview = editing && text.trim() && text !== display ? previewDate(text, field, settings) : null;
  const invalid = editing && !!text.trim() && text !== display && !preview;
  const commit = () => {
    setDraft(null);
    if (cancelled.current || draft === null || draft === display) {
      cancelled.current = false;
      return;
    }
    onChange(draft.trim() ? draft.trim() : null);
  };
  const implied = !value && effective;
  return (
    <div className="flex flex-col gap-1.5" data-testid={`date-field-${field}`}>
      <div className="relative flex items-center gap-1">
        <input
          id={id}
          className={`pb-input min-w-0 flex-1 ${implied ? "italic" : ""} ${invalid ? "border-danger" : ""}`}
          aria-label={label}
          aria-invalid={invalid}
          placeholder={mixed ? "Multiple values" : implied ? formatDateInput(effective, settings) : "None"}
          value={text}
          onFocus={() => setDraft(display)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              cancelled.current = true;
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <button
          type="button"
          className="pb-icon-btn shrink-0 max-md:hidden pointer-coarse:hidden"
          aria-label={`Pick ${label} from calendar`}
          onClick={() => {
            const el = pickerRef.current;
            if (!el) return;
            try {
              el.showPicker();
            } catch {
              el.focus();
            }
          }}
        >
          <Icon name="calendar" size={18} />
        </button>
        {/* Touch devices: the native input itself takes the tap, since iOS ignores showPicker() on hidden inputs.
            16 px text stops iOS zooming the page when it gains focus. */}
        <label className="pb-icon-btn relative hidden shrink-0 max-md:inline-flex pointer-coarse:inline-flex">
          <Icon name="calendar" size={18} />
          <input
            type={dateOnly ? "date" : "datetime-local"}
            aria-label={`Pick ${label} from calendar`}
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none text-base opacity-0"
            value={picked ?? nativeValue}
            onFocus={() => setPicked(nativeValue)}
            onChange={(e) => {
              // Without focus there is no picker session to wait for, so the change commits at once.
              if (document.activeElement === e.currentTarget) setPicked(e.target.value);
              else if (e.target.value !== nativeValue) onChange(fromNative(e.target.value));
            }}
            onBlur={() => {
              setPicked(null);
              if (pickedValue !== undefined) onChange(pickedValue);
            }}
          />
        </label>
        <input
          ref={pickerRef}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute h-0 w-0 opacity-0"
          value={value ? wallDayKey(toWall(value, settings.timeZone)) : ""}
          onChange={(e) => {
            if (e.target.value) onChange(withDay(value, e.target.value, field, settings));
          }}
        />
        {(value || mixed) && (
          <button type="button" className="pb-icon-btn shrink-0" aria-label={`Clear ${label}`} onClick={() => onChange(null)}>
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {editing && text.trim() && text !== display && (
        <p className={`text-xs ${invalid ? "text-danger" : "text-muted"}`} aria-live="polite">
          {preview ? formatDateTime(preview, settings) : "Unable to parse date"}
        </p>
      )}
      {!dateOnly && (
        <div className="flex gap-1">
          {(["day", "week", "month"] as const).map((unit) => (
            <button
              key={unit}
              type="button"
              className="min-h-[44px] min-w-[44px] rounded-md border border-line px-2 text-xs text-muted hover:bg-surface-2 md:min-h-[32px]"
              aria-label={`${label} plus one ${unit}`}
              onClick={() => onChange(bumpDate(value, 1, unit, field, settings))}
            >
              +1 {unit}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DurationField({ value, onChange, mixed = false }: { value: number | null; onChange: (minutes: number | null) => void; mixed?: boolean }) {
  const display = value === null ? "" : formatDuration(value);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? display;
  const parsed = text.trim() ? parseDuration(text) : null;
  const invalid = draft !== null && !!text.trim() && parsed === null;
  return (
    <div className="flex flex-col gap-1">
      <input
        className={`pb-input ${invalid ? "border-danger" : ""}`}
        aria-label="Duration"
        aria-invalid={invalid}
        placeholder={mixed ? "Multiple values" : "None"}
        value={text}
        onFocus={() => setDraft(display)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setDraft(null);
          if (draft === null || draft === display) return;
          if (!draft.trim()) onChange(null);
          else if (parsed !== null) onChange(parsed);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {invalid && <p className="text-xs text-danger">Unable to parse duration</p>}
    </div>
  );
}

export function ReadOnly({ label, value, settings }: { label: string; value: string | null; settings: Settings }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <span>{formatDateTime(value, settings)}</span>
    </div>
  );
}
