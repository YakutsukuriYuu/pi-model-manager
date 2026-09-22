import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Shared rendering for every screen so the manager looks the same everywhere:
 * a title block, one body, and one footer of key hints.
 */

export interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

export function safeTheme(theme: Theme): ThemeLike {
  // SAFETY: Theme implements fg/bg/bold with the same runtime signatures; the
  // local shape relaxes only the color argument so this module does not depend
  // on Pi's private ThemeColor union.
  return theme as unknown as ThemeLike;
}

export function pad(value: string, width: number): string {
  const visible = visibleWidth(value);
  if (visible === width) return value;
  if (visible > width) return truncateToWidth(value, width, "");
  return value + " ".repeat(width - visible);
}

export function padLeft(value: string, width: number): string {
  const visible = visibleWidth(value);
  if (visible >= width) return truncateToWidth(value, width, "");
  return " ".repeat(width - visible) + value;
}

export interface Column<T> {
  title: string;
  /** Fixed cell width, or "flex" to absorb the remaining space. */
  width: number | "flex";
  right?: boolean;
  value(row: T): string;
}

export interface TableOptions<T> {
  theme: ThemeLike;
  width: number;
  columns: Array<Column<T>>;
  rows: T[];
  selected: number;
  /** Label shown when there are no rows. */
  empty: string;
  /** Prefix for a row, e.g. a marker. Rendered before the first column. */
  marker?(row: T): string;
}

const GAP = 2;
const MARKER_WIDTH = 2;
const FLEX_MIN = 8;

function resolveWidths<T>(columns: Array<Column<T>>, width: number): number[] {
  const gaps = GAP * Math.max(0, columns.length - 1);
  const available = Math.max(1, width - MARKER_WIDTH - gaps);
  const fixed = columns.reduce((total, column) => total + (typeof column.width === "number" ? column.width : 0), 0);
  const flexible = columns.filter((column) => column.width === "flex").length;
  const remaining = available - fixed;
  const flexWidth = flexible === 0 ? 0 : Math.max(FLEX_MIN, Math.floor(remaining / flexible));
  return columns.map((column) => (column.width === "flex" ? flexWidth : column.width));
}

export function table<T>(options: TableOptions<T>): string[] {
  const { theme, width, columns, rows, selected } = options;
  const widths = resolveWidths(columns, width);
  const lines: string[] = [];

  const header = columns
    .map((column, index) => {
      const cell = pad(column.title, widths[index]);
      return column.right ? padLeft(cell.trim(), widths[index]) : cell;
    })
    .join(" ".repeat(GAP));
  lines.push(truncateToWidth(theme.fg("muted", `  ${header}`), width, ""));

  if (rows.length === 0) {
    lines.push(truncateToWidth(theme.fg("dim", `  ${options.empty}`), width, ""));
    return lines;
  }

  rows.forEach((row, index) => {
    const cells = columns.map((column, columnIndex) => {
      const raw = column.value(row);
      const cell = column.right ? padLeft(truncateToWidth(raw, widths[columnIndex], ""), widths[columnIndex]) : pad(raw, widths[columnIndex]);
      return cell;
    });
    const marker = options.marker?.(row) ?? " ";
    const content = `${marker} ${cells.join(" ".repeat(GAP))}`;
    if (index === selected) {
      lines.push(truncateToWidth(theme.bg("selectedBg", theme.fg("accent", pad(content, width))), width, ""));
    } else {
      lines.push(truncateToWidth(content, width, ""));
    }
  });

  return lines;
}

export interface FrameOptions {
  theme: ThemeLike;
  width: number;
  title: string;
  /** Secondary lines under the title, already plain text. */
  meta?: string[];
  body: string[];
  footer: string;
  /** Rendered in place of the default footer color when it reports a problem. */
  footerTone?: "dim" | "warning" | "error";
}

export function frame(options: FrameOptions): string[] {
  const { theme, width, title } = options;
  const rule = theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
  const lines: string[] = [theme.fg("borderAccent", "─".repeat(Math.max(1, width)))];
  lines.push(truncateToWidth(theme.fg("accent", theme.bold(` ${title}`)), width, ""));
  for (const line of options.meta ?? []) {
    lines.push(truncateToWidth(theme.fg("muted", ` ${line}`), width, ""));
  }
  lines.push(rule);
  lines.push(...options.body);
  lines.push(rule);
  lines.push(truncateToWidth(theme.fg(options.footerTone ?? "dim", ` ${options.footer}`), width, ""));
  lines.push(theme.fg("borderAccent", "─".repeat(Math.max(1, width))));
  return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
}

export function hint(parts: Array<[key: string, label: string]>): string {
  return parts.map(([key, label]) => `${key} ${label}`).join("  ·  ");
}

export function compactCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
