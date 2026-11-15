import type { RepeatRule } from "../../../shared/schemas";
import { buildRule, defaultRepeat, parseRule, summarizeRepeat, WEEKDAY_CODES, type Freq, type RepeatForm, type WeekdayCode } from "../../lib/repeat";
import { Segmented } from "./Fields";

const FREQS: Array<{ value: Freq; label: string }> = [
  { value: "DAILY", label: "Day" },
  { value: "WEEKLY", label: "Week" },
  { value: "MONTHLY", label: "Month" },
  { value: "YEARLY", label: "Year" },
];
const DAY_SHORT: Record<WeekdayCode, string> = { SU: "S", MO: "M", TU: "T", WE: "W", TH: "T", FR: "F", SA: "S" };
const DAY_LONG: Record<WeekdayCode, string> = { SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Repeat editor (docs/spec.md §3): none / every N units with FREQ-specific options, schedule, anchor, catch-up, end. */
export function RepeatEditor({ repeat, onChange }: { repeat: RepeatRule | null; onChange: (repeat: RepeatRule | null) => void }) {
  if (!repeat) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted">Doesn’t repeat</span>
        <button type="button" className="pb-btn text-sm md:min-h-[36px]" onClick={() => onChange(defaultRepeat())}>
          Add repeat
        </button>
      </div>
    );
  }
  const form = parseRule(repeat.rule);
  const update = (patch: Partial<RepeatForm>) => onChange({ ...repeat, rule: buildRule({ ...form, ...patch }) });
  const isMonthOrYear = form.freq === "MONTHLY" || form.freq === "YEARLY";

  return (
    <div className="flex flex-col gap-3" data-testid="repeat-editor">
      <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm" data-testid="repeat-summary">
        {summarizeRepeat(repeat)}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Every</span>
        <input
          type="number"
          min={1}
          className="pb-input w-20"
          aria-label="Repeat interval"
          value={form.interval}
          onChange={(e) => update({ interval: Math.max(1, Number(e.target.value) || 1) })}
        />
        <select
          className="pb-input w-auto"
          aria-label="Repeat unit"
          value={form.freq}
          onChange={(e) => {
            const freq = e.target.value as Freq;
            update({ freq, byDay: [], monthlyMode: "none", byMonthDay: [], byMonth: [] });
          }}
        >
          {FREQS.map((f) => (
            <option key={f.value} value={f.value}>
              {form.interval === 1 ? f.label.toLowerCase() : `${f.label.toLowerCase()}s`}
            </option>
          ))}
          {!FREQS.some((f) => f.value === form.freq) && <option value={form.freq}>{form.freq.toLowerCase()}</option>}
        </select>
      </div>

      {form.freq === "WEEKLY" && (
        <div role="group" aria-label="Repeat on weekdays" className="flex flex-wrap gap-0.5">
          {WEEKDAY_CODES.map((d) => {
            const on = form.byDay.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                aria-label={DAY_LONG[d]}
                className={`h-11 w-11 rounded-full border text-sm ${on ? "border-accent bg-accent text-on-accent" : "border-line"}`}
                onClick={() => update({ byDay: on ? form.byDay.filter((x) => x !== d) : [...form.byDay, d] })}
              >
                {DAY_SHORT[d]}
              </button>
            );
          })}
        </div>
      )}

      {form.freq === "YEARLY" && (
        <div role="group" aria-label="Repeat in months" className="grid grid-cols-6 gap-1">
          {MONTHS.map((m, i) => {
            const on = form.byMonth.includes(i + 1);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                className={`min-h-[44px] rounded-md border text-xs md:min-h-[36px] ${on ? "border-accent bg-accent text-on-accent" : "border-line"}`}
                onClick={() => update({ byMonth: on ? form.byMonth.filter((x) => x !== i + 1) : [...form.byMonth, i + 1] })}
              >
                {m}
              </button>
            );
          })}
        </div>
      )}

      {isMonthOrYear && (
        <div className="flex flex-col gap-2 text-sm">
          <Segmented
            label="Monthly repeat mode"
            value={form.monthlyMode}
            onChange={(monthlyMode) => update({ monthlyMode, byMonthDay: monthlyMode === "dayOfMonth" && form.byMonthDay.length === 0 ? [1] : form.byMonthDay })}
            options={[
              { value: "none", label: "Same day" },
              { value: "dayOfMonth", label: "Day of month" },
              { value: "nthWeekday", label: "Weekday" },
            ]}
          />
          {form.monthlyMode === "dayOfMonth" && (
            <label className="flex items-center gap-2">
              On day
              <select
                className="pb-input w-auto"
                aria-label="Day of month"
                value={form.byMonthDay[0] ?? 1}
                onChange={(e) => update({ byMonthDay: [Number(e.target.value)] })}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
                <option value={-1}>last</option>
              </select>
            </label>
          )}
          {form.monthlyMode === "nthWeekday" && (
            <div className="flex items-center gap-2">
              On the
              <select className="pb-input w-auto" aria-label="Week of month" value={form.nth} onChange={(e) => update({ nth: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, -1].map((n) => (
                  <option key={n} value={n}>
                    {n === -1 ? "last" : ["first", "second", "third", "fourth", "fifth"][n - 1]}
                  </option>
                ))}
              </select>
              <select className="pb-input w-auto" aria-label="Weekday" value={form.nthWeekday} onChange={(e) => update({ nthWeekday: e.target.value as WeekdayCode })}>
                {WEEKDAY_CODES.map((d) => (
                  <option key={d} value={d}>
                    {DAY_LONG[d]}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">Schedule</span>
        <Segmented
          label="Repeat schedule"
          value={repeat.scheduleType}
          onChange={(scheduleType) => onChange({ ...repeat, scheduleType })}
          options={[
            { value: "regularly", label: "Regularly" },
            { value: "fromCompletion", label: "From completion" },
          ]}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">Anchor date</span>
        <Segmented
          label="Repeat anchor date"
          value={repeat.anchorDate}
          onChange={(anchorDate) => onChange({ ...repeat, anchorDate })}
          options={[
            { value: "due", label: "Due" },
            { value: "defer", label: "Defer" },
            { value: "planned", label: "Planned" },
          ]}
        />
      </div>
      {repeat.scheduleType === "regularly" && (
        <label className="flex min-h-[44px] items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={repeat.catchUpAutomatically} onChange={(e) => onChange({ ...repeat, catchUpAutomatically: e.target.checked })} />
          Catch up automatically
        </label>
      )}
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs text-muted">Ends</span>
        <Segmented
          label="Repeat end"
          value={form.end.kind}
          onChange={(kind) =>
            update({
              end: kind === "never" ? { kind } : kind === "count" ? { kind, count: 5 } : { kind, date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) },
            })
          }
          options={[
            { value: "never", label: "Never" },
            { value: "count", label: "After" },
            { value: "until", label: "On date" },
          ]}
        />
        {form.end.kind === "count" && (
          <label className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              className="pb-input w-24"
              aria-label="Number of occurrences"
              value={form.end.count}
              onChange={(e) => update({ end: { kind: "count", count: Math.max(1, Number(e.target.value) || 1) } })}
            />
            times
          </label>
        )}
        {form.end.kind === "until" && (
          <input type="date" className="pb-input w-auto" aria-label="Repeat until" value={form.end.date} onChange={(e) => e.target.value && update({ end: { kind: "until", date: e.target.value } })} />
        )}
      </div>
      <button type="button" className="pb-btn pb-btn-danger self-start text-sm" onClick={() => onChange(null)}>
        Remove repeat
      </button>
    </div>
  );
}
