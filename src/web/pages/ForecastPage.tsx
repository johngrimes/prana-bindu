import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";
import type { Forecast, OutlineGroup } from "../../shared/schemas";
import { usePerspectives, useForecast, useSettingsValue } from "../api/queries";
import { Outline } from "../components/outline/Outline";
import { ViewOptionsPanel } from "../components/ViewOptions";
import { Workspace } from "../components/Workspace";
import { addDaysToKey, formatDayKey, startOfWeekKey, weekdayName } from "../lib/dates";

type Day = Forecast["days"][number];

function dayLabel(d: Day, today: string): { top: string; bottom: string } {
  if (d.key === "PAST") return { top: "Past", bottom: "" };
  if (d.key === "FUTURE") return { top: "Future", bottom: "" };
  if (d.key === "TODAY" || d.date === today) return { top: "Today", bottom: "" };
  const date = d.date ?? d.key;
  const [y, m, dd] = date.split("-").map(Number);
  return { top: weekdayName(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, dd ?? 1)).getUTCDay()), bottom: String(dd ?? "") };
}

function Badge({ count, tone }: { count: number; tone: "overdue" | "dueSoon" | null }) {
  if (count <= 0) return <span className="h-5" />;
  const cls = tone === "overdue" ? "bg-danger text-white" : tone === "dueSoon" ? "bg-warn text-white" : "bg-surface-3 text-fg";
  return <span className={`min-w-[20px] rounded-full px-1.5 text-center text-xs font-semibold leading-5 tabular-nums ${cls}`}>{count}</span>;
}

/** Sidebar calendar: Past, five weeks from the start of the current week, Future (docs/spec.md §4 Forecast). */
function ForecastCalendar({ forecast, selected, firstWeekday }: { forecast: Forecast; selected: string | null; firstWeekday: number }) {
  const navigate = useNavigate();
  const past = forecast.days.find((d) => d.key === "PAST");
  const future = forecast.days.find((d) => d.key === "FUTURE");
  const counts = new Map(forecast.calendar.map((c) => [c.date, c]));
  const start = forecast.calendar[0]?.date ?? startOfWeekKey(forecast.today, firstWeekday);
  const cells = Array.from({ length: 35 }, (_, i) => addDaysToKey(start, i));
  const go = (day: string) => navigate(`/forecast?day=${day}`);
  const headerDays = Array.from({ length: 7 }, (_, i) => weekdayName(firstWeekday - 1 + i).slice(0, 2));
  return (
    <div className="flex flex-col gap-2 p-2" aria-label="Forecast calendar">
      <button
        type="button"
        data-closes-drawer
        className={`flex min-h-[44px] items-center justify-between rounded-lg px-3 text-sm ${selected === "PAST" ? "bg-select-strong/70 font-medium" : "hover:bg-surface-3/60"}`}
        onClick={() => go("PAST")}
      >
        Past <Badge count={past?.dueCount ?? 0} tone="overdue" />
      </button>
      <div role="grid" aria-label="Next five weeks" className="grid grid-cols-7 text-center">
        <div role="row" className="contents">
          {headerDays.map((d, i) => (
            <span role="columnheader" key={i} className="pb-1 text-[11px] font-medium text-muted">
              {d}
            </span>
          ))}
        </div>
        {cells.map((date) => {
          const c = counts.get(date);
          const isToday = date === forecast.today;
          const isSel = selected === date || (selected === "TODAY" && isToday);
          const past = date < forecast.today;
          return (
            <button
              key={date}
              type="button"
              role="gridcell"
              data-closes-drawer
              aria-label={`${formatDayKey(date)}${c?.dueCount ? `, ${c.dueCount} due` : ""}`}
              aria-selected={isSel}
              disabled={past}
              onClick={() => go(isToday ? "TODAY" : date)}
              className={`flex min-h-[44px] flex-col items-center justify-center rounded-lg text-sm ${isSel ? "bg-accent text-on-accent" : isToday ? "ring-1 ring-accent" : "hover:bg-surface-3/60"} ${past ? "opacity-35" : ""}`}
            >
              <span className="tabular-nums">{Number(date.slice(8))}</span>
              <span className={`text-[10px] leading-3 tabular-nums ${isSel ? "" : "text-muted"}`}>{c && c.dueCount > 0 ? c.dueCount : "\u00a0"}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        data-closes-drawer
        className={`flex min-h-[44px] items-center justify-between rounded-lg px-3 text-sm ${selected === "FUTURE" ? "bg-select-strong/70 font-medium" : "hover:bg-surface-3/60"}`}
        onClick={() => go("FUTURE")}
      >
        Future <Badge count={future?.dueCount ?? 0} tone={null} />
      </button>
    </div>
  );
}

export function ForecastPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const settings = useSettingsValue();
  const selected = params.get("day");
  const { data: forecast, isPending } = useForecast();
  const outside = !!forecast && !!selected && /^\d{4}-\d{2}-\d{2}$/.test(selected) && !forecast.days.some((d) => d.key === selected || d.date === selected);
  const { data: single } = useForecast(outside && selected ? { from: selected, days: 1 } : {});
  const { data: perspectives } = usePerspectives();
  const perspective = perspectives?.find((p) => p.id === "forecast");

  const groups: OutlineGroup[] = useMemo(() => {
    if (!forecast) return [];
    const source = outside && single ? single.days.filter((d) => d.date === selected) : forecast.days;
    return source
      .filter((d) => !selected || outside || d.key === selected || d.date === selected || (selected === "TODAY" && d.date === forecast.today))
      .map((d) => ({
        key: d.key,
        title: d.key === "PAST" ? "Past" : d.key === "FUTURE" ? "Future" : d.key === "TODAY" || d.date === forecast.today ? `Today — ${formatDayKey(d.date ?? forecast.today)}` : d.date ? formatDayKey(d.date) : d.title,
        kind: "date" as const,
        rows: d.rows,
      }));
  }, [forecast, single, selected, outside]);

  const strip = forecast?.days ?? [];

  return (
    <Workspace
      title="Forecast"
      icon="forecast"
      color="#c4372f"
      sidebar={forecast ? <ForecastCalendar forecast={forecast} selected={selected} firstWeekday={settings.firstWeekday} /> : undefined}
      sidebarTitle="Calendar"
      viewOptions={perspective ? <ViewOptionsPanel perspective={perspective} /> : undefined}
    >
      <nav aria-label="Forecast days" className="sticky top-0 z-[2] flex gap-1 overflow-x-auto border-b border-line bg-surface px-2 py-2">
        {strip.map((d) => {
          const l = dayLabel(d, forecast?.today ?? "");
          const key = d.key === "TODAY" || d.date === forecast?.today ? "TODAY" : (d.date ?? d.key);
          const isSel = selected === key || selected === d.key;
          return (
            <button
              key={d.key}
              type="button"
              aria-pressed={isSel}
              data-testid="forecast-strip-day"
              onClick={() => navigate(isSel ? "/forecast" : `/forecast?day=${key}`)}
              className={`flex min-h-[56px] min-w-[52px] flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-xs ${isSel ? "bg-accent text-on-accent" : "hover:bg-surface-2"}`}
            >
              <span className="font-medium">{l.top}</span>
              {l.bottom && <span className="text-[11px] opacity-70">{l.bottom}</span>}
              <Badge count={d.dueCount} tone={d.badge} />
            </button>
          );
        })}
      </nav>
      {isPending ? (
        <p className="px-6 py-16 text-center text-muted">Loading…</p>
      ) : (
        <Outline groups={groups} scopeKey={`forecast?${selected ?? ""}`} newItemTarget={{ inbox: true }} showProject emptyText="No items" label="Forecast" />
      )}
    </Workspace>
  );
}
