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
  /**
   * Cap on rendered rows. The window follows the selection: a list taller than
   * the space available pushes the highlighted row off screen, leaving no way
   * to see where the cursor is.
   */
  maxRows?: number;
}

const GAP = 2;
const MARKER_WIDTH = 2;
const FLEX_MIN = 8;

/**
 * Gutter marker for the focused row.
 *
 * The selection is also highlighted with a background colour, but a colour
 * alone is invisible on themes with a subtle `selectedBg` and in terminals
 * without colour, so the cursor needs a glyph of its own.
 */
export const SELECTED_MARKER = "›";
export const UNSELECTED_MARKER = " ";

/**
 * Visible slice that keeps the selected row on screen.
 *
 * Same rule Pi's own model selector uses: centre the selection, then clamp so
 * the window never runs past either end.
 */
export function windowRange(total: number, selected: number, maxRows: number): { start: number; end: number } {
  const limit = Math.max(1, Math.floor(maxRows));
  if (total <= limit) return { start: 0, end: total };
  const start = Math.max(0, Math.min(selected - Math.floor(limit / 2), total - limit));
  return { start, end: Math.min(start + limit, total) };
}

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

  const range = windowRange(rows.length, selected, options.maxRows ?? rows.length);
  if (range.start > 0 || range.end < rows.length) {
    // Without this a capped list just looks truncated, and there is no way to
    // tell that more rows exist below.
    lines.push(truncateToWidth(theme.fg("dim", `  第 ${range.start + 1}-${range.end} 项 / 共 ${rows.length} 项`), width, ""));
  }

  for (let index = range.start; index < range.end; index++) {
    const row = rows[index];
    if (row === undefined) continue;
    const cells = columns.map((column, columnIndex) => {
      const raw = column.value(row);
      return column.right ? padLeft(truncateToWidth(raw, widths[columnIndex], ""), widths[columnIndex]) : pad(raw, widths[columnIndex]);
    });
    const marker = options.marker?.(row) ?? " ";
    const content = `${marker} ${cells.join(" ".repeat(GAP))}`;
    if (index === selected) {
      lines.push(truncateToWidth(theme.bg("selectedBg", theme.fg("accent", pad(content, width))), width, ""));
    } else {
      lines.push(truncateToWidth(content, width, ""));
    }
  }

  return lines;
}

export interface FrameOptions {
  theme: ThemeLike;
  width: number;
  title: string;
  /** Secondary lines under the title, already plain text. */
  meta?: string[];
  body: string[];
  /** Key hints. More than one line is allowed so nothing gets truncated away. */
  footer: string[];
  /**
   * Result of the last action, on its own line above the hints.
   *
   * A status that replaces the hints leaves the reader without any way to see
   * what the keys do.
   */
  notice?: { text: string; tone: "dim" | "warning" | "error" };
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
  if (options.notice) {
    lines.push(truncateToWidth(theme.fg(options.notice.tone, ` ${options.notice.text}`), width, ""));
  }
  for (const line of options.footer) {
    lines.push(truncateToWidth(theme.fg("dim", ` ${line}`), width, ""));
  }
  lines.push(theme.fg("borderAccent", "─".repeat(Math.max(1, width))));
  return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
}

export interface KeyHint {
  keys: string;
  label: string;
}

/**
 * Lays out key hints over at most `maxLines` lines.
 *
 * A single line silently truncates on a narrow terminal, and whatever is cut is
 * the hint that happened to come last — usually the one explaining how to leave
 * the screen. Wrapping keeps every hint; when even that is not enough, the
 * final hint is preserved instead of dropped.
 */
export function hintLines(hints: readonly KeyHint[], width: number, maxLines = 2): string[] {
  const budget = Math.max(8, width - 2);
  const lines: string[] = [];
  let current = "";
  let index = 0;

  const flush = (): void => {
    if (current.length > 0) lines.push(current);
    current = "";
  };

  for (; index < hints.length; index++) {
    const hint = hints[index];
    if (hint === undefined) continue;
    const piece = `${hint.keys} ${hint.label}`;
    const candidate = current.length === 0 ? piece : `${current}   ${piece}`;
    if (visibleWidth(candidate) <= budget) {
      current = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) break;
    flush();
    current = piece;
  }
  flush();

  if (index < hints.length && lines.length > 0) {
    const last = hints.at(-1);
    if (last) {
      const tail = `${last.keys} ${last.label}`;
      const room = budget - visibleWidth(tail) - visibleWidth("…   ");
      const head = lines.at(-1) ?? "";
      lines[lines.length - 1] = room > 0 ? `${truncateToWidth(head, room, "")}…   ${tail}` : tail;
    }
  }
  return lines.slice(0, maxLines);
}

export function compactCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
