import {
  formatDayShort,
  formatTokens,
  formatUsd,
} from "@renderer/lib/usage-history-format";
import {
  bucketValue,
  type UsageDayTotals,
} from "@renderer/lib/usage-history-view";
import type { UsageHistoryProvider } from "@shared/usage-history";
import { useCallback, useMemo, useRef, useState } from "react";
import { USAGE_PROVIDER_PRESENTATION } from "./usage-history-providers";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type UsageChartMetric = "cost" | "tokens";

interface DayColumn {
  bands: { provider: UsageHistoryProvider; value: number }[];
  total: number;
}

export function niceScale(
  peak: number,
  count: number,
): { max: number; ticks: number[] } {
  if (peak <= 0) {
    return { max: 0, ticks: [0] };
  }

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step =
    (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) *
    magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) {
    ticks.push(value);
  }
  return { max, ticks };
}

export function buildDayColumns(
  days: string[],
  byDay: Map<string, UsageDayTotals>,
  providers: UsageHistoryProvider[],
  metric: UsageChartMetric,
): DayColumn[] {
  return days.map((day) => {
    const entry = byDay.get(day);
    const bands = providers.map((provider) => ({
      provider,
      value: bucketValue(entry?.byProvider.get(provider), metric),
    }));
    return {
      bands,
      total: bands.reduce((sum, band) => sum + band.value, 0),
    };
  });
}

interface UsageHistoryChartProps {
  providers: UsageHistoryProvider[];
  days: string[];
  daily: UsageDayTotals[];
  metric: UsageChartMetric;
}

export function UsageHistoryChart({
  providers,
  days,
  daily,
  metric,
}: UsageHistoryChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const byDay = useMemo(
    () => new Map(daily.map((entry) => [entry.day, entry])),
    [daily],
  );

  const { paths, ticks, stepX, toY, columns } = useMemo(() => {
    const built = buildDayColumns(days, byDay, providers, metric);
    const peak = built.reduce(
      (max, column) =>
        column.bands.reduce((inner, band) => Math.max(inner, band.value), max),
      0,
    );
    const { max, ticks: tickValues } = niceScale(peak, TICK_COUNT);
    const step = days.length <= 1 ? 0 : VIEW_WIDTH / (days.length - 1);
    const scaleY = (value: number) =>
      max === 0
        ? VIEW_HEIGHT
        : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);

    const series = providers.map((provider, providerIndex) => {
      const points = built.map((column, dayIndex) => {
        const value = column.bands[providerIndex]?.value ?? 0;
        return `${(dayIndex * step).toFixed(2)},${scaleY(value).toFixed(2)}`;
      });
      const line = points.length === 0 ? "" : `M${points.join(" L")}`;
      return {
        provider,
        total: built.reduce(
          (sum, column) => sum + (column.bands[providerIndex]?.value ?? 0),
          0,
        ),
        line,
        area:
          line === ""
            ? ""
            : `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z`,
      };
    });

    return {
      paths: series.sort((a, b) => b.total - a.total),
      columns: built,
      stepX: step,
      ticks: tickValues,
      toY: scaleY,
    };
  }, [byDay, days, metric, providers]);

  const format = metric === "cost" ? formatUsd : formatTokens;
  const chartLabel = `Daily ${metric === "cost" ? "cost" : "processed tokens"} by provider`;

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || days.length === 0) {
        return;
      }
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) {
        return;
      }
      const fraction =
        Math.min(bounds.width, Math.max(0, event.clientX - bounds.left)) /
        bounds.width;
      const index = Math.round(fraction * (days.length - 1));
      setHoverIndex(Math.min(days.length - 1, Math.max(0, index)));
    },
    [days.length],
  );

  const hoveredDay = hoverIndex === null ? undefined : days[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : columns[hoverIndex];
  const tooltipOnRight =
    hoverIndex !== null && hoverIndex < Math.floor(days.length / 2);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          className="relative h-56 flex-1"
          role="img"
          aria-label={chartLabel}
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
          >
            <title>{chartLabel}</title>
            {ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {paths.map(({ provider, area }) => (
              <path
                key={provider}
                d={area}
                fill={USAGE_PROVIDER_PRESENTATION[provider].color}
                fillOpacity={0.12}
              />
            ))}
            {paths.map(({ provider, line }) => (
              <path
                key={provider}
                d={line}
                fill="none"
                stroke={USAGE_PROVIDER_PRESENTATION[provider].color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {hoverIndex === null ? null : (
              <line
                x1={hoverIndex * stepX}
                x2={hoverIndex * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredDay === undefined ? null : (
            <div
              className={
                tooltipOnRight
                  ? "pointer-events-none absolute top-2 right-2 z-10 min-w-36 rounded-md border border-border/60 bg-popover px-2.5 py-2 text-xs shadow-md"
                  : "pointer-events-none absolute top-2 left-2 z-10 min-w-36 rounded-md border border-border/60 bg-popover px-2.5 py-2 text-xs shadow-md"
              }
            >
              <div className="mb-1 text-muted-foreground">
                {formatDayShort(hoveredDay)}
              </div>
              {providers.map((provider) => (
                <div
                  key={provider}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-muted-foreground">
                    {USAGE_PROVIDER_PRESENTATION[provider].label}
                  </span>
                  <span className="tabular-nums">
                    {format(
                      hoveredColumn?.bands.find(
                        (band) => band.provider === provider,
                      )?.value ?? 0,
                    )}
                  </span>
                </div>
              ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="tabular-nums">
                  {format(hoveredColumn?.total ?? 0)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-[10px] uppercase text-muted-foreground">
        <span>{days[0] === undefined ? "" : formatDayShort(days[0])}</span>
        <span>
          {days[Math.floor(days.length / 2)] === undefined
            ? ""
            : formatDayShort(days[Math.floor(days.length / 2)] ?? "")}
        </span>
        <span>
          {days[days.length - 1] === undefined
            ? ""
            : formatDayShort(days[days.length - 1] ?? "")}
        </span>
      </div>
    </div>
  );
}
