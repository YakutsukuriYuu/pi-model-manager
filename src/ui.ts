import type { Model, Api } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { CatalogEntry, CatalogProvider, CatalogSnapshot } from "./catalog.ts";
import { sourceLabel } from "./catalog.ts";

export interface ManagerCallbacks {
  onSelect(model: Model<Api>): void;
  onRefresh(): Promise<CatalogSnapshot>;
  onAdd(): void;
  onClose(): void;
}

interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

function safeTheme(theme: Theme): ThemeLike {
  // SAFETY: Theme exposes the same runtime fg/bg/bold methods; the local shape
  // narrows only the color argument to keep this component independent of Pi's
  // private ThemeColor union.
  return theme as unknown as ThemeLike;
}

function padRight(value: string, width: number): string {
  const visible = visibleWidth(value);
  return visible >= width ? truncateToWidth(value, width, "") : value + " ".repeat(width - visible);
}

function compactNumber(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function modelCapability(entry: CatalogEntry): string {
  const model = entry.model;
  const capabilities: string[] = [];
  if (model.reasoning) capabilities.push("thinking");
  if (model.input.includes("image")) capabilities.push("image");
  if (model.contextWindow) capabilities.push(compactNumber(model.contextWindow));
  return capabilities.join(" · ") || "text";
}

export class ModelManager implements Component {
  private snapshot: CatalogSnapshot;
  private readonly tui: TUI;
  private readonly theme: ThemeLike;
  private readonly callbacks: ManagerCallbacks;
  private readonly currentKey: string | undefined;
  private query = "";
  private providerFilter: string | undefined;
  private selectedIndex = 0;
  private searching = false;
  private loading = false;
  private status = "";
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    tui: TUI,
    theme: Theme,
    snapshot: CatalogSnapshot,
    currentKey: string | undefined,
    callbacks: ManagerCallbacks,
  ) {
    this.tui = tui;
    this.theme = safeTheme(theme);
    this.snapshot = snapshot;
    this.currentKey = currentKey;
    this.callbacks = callbacks;
  }

  private filteredEntries(): CatalogEntry[] {
    const query = this.query.trim().toLowerCase();
    return this.snapshot.entries.filter((entry) => {
      if (this.providerFilter && entry.providerId !== this.providerFilter) return false;
      if (!query) return true;
      const haystack = [
        entry.model.id,
        entry.model.name,
        entry.providerId,
        entry.providerName,
        entry.model.api,
        sourceLabel(entry.source),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }

  private providers(): CatalogProvider[] {
    return this.snapshot.providers;
  }

  private selectedEntry(): CatalogEntry | undefined {
    const entries = this.filteredEntries();
    return entries[this.selectedIndex];
  }

  private clampSelection(): void {
    const count = this.filteredEntries().length;
    this.selectedIndex = count === 0 ? 0 : Math.min(this.selectedIndex, count - 1);
  }

  private invalidateRender(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  private async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.status = "Refreshing model catalog…";
    this.invalidateRender();
    try {
      this.snapshot = await this.callbacks.onRefresh();
      this.clampSelection();
      this.status = `Updated ${this.snapshot.entries.length} models`;
    } catch (error) {
      this.status = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.loading = false;
      this.invalidateRender();
    }
  }

  private beginSearch(): void {
    this.searching = true;
    this.status = "Type to search · Enter keeps the filter · Esc clears it";
    this.invalidateRender();
  }

  private endSearch(clear: boolean): void {
    this.searching = false;
    if (clear) this.query = "";
    this.clampSelection();
    this.status = "";
    this.invalidateRender();
  }

  private cycleProvider(): void {
    const providers = this.providers();
    if (providers.length === 0) return;
    const ids = [undefined, ...providers.map((provider) => provider.id)];
    const current = ids.indexOf(this.providerFilter);
    this.providerFilter = ids[(current + 1) % ids.length];
    this.selectedIndex = 0;
    this.status = this.providerFilter ? `Showing ${this.providerFilter}` : "Showing all providers";
    this.invalidateRender();
  }

  handleInput(data: string): void {
    if (this.searching) {
      if (matchesKey(data, Key.escape)) {
        this.endSearch(true);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.endSearch(false);
        return;
      }
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
        this.query = this.query.slice(0, -1);
        this.selectedIndex = 0;
        this.invalidateRender();
        return;
      }
      if (!data.includes("\x1b") && data.length > 0 && [...data].every((char) => char >= " ")) {
        this.query += data;
        this.selectedIndex = 0;
        this.invalidateRender();
      }
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.callbacks.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      const count = this.filteredEntries().length;
      if (count > 0) this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
      this.invalidateRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      const count = this.filteredEntries().length;
      if (count > 0) this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
      this.invalidateRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.selectedEntry();
      if (selected) this.callbacks.onSelect(selected.model);
      return;
    }
    if (matchesKey(data, Key.tab) || data === "f") {
      this.cycleProvider();
      return;
    }
    if (data === "/") {
      this.beginSearch();
      return;
    }
    if (data === "r" || data === "R") {
      void this.refresh();
      return;
    }
    if (data === "a" || data === "A") {
      this.callbacks.onAdd();
      return;
    }
    if (data === "q") {
      this.callbacks.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines: string[] = [];
    const selected = this.selectedEntry();
    const entries = this.filteredEntries();
    const providers = this.providers();
    const title = ` Models · ${this.snapshot.entries.length} models · ${this.snapshot.providerCount} providers `;

    lines.push(this.theme.fg("borderAccent", "─".repeat(Math.max(1, width))));
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(title)), width, ""));
    lines.push(
      truncateToWidth(
        this.theme.fg(
          this.searching ? "accent" : "muted",
          this.searching ? ` Search: ${this.query}▌` : ` Search: ${this.query || "all models"}`,
        ),
        width,
        "",
      ),
    );
    lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))));

    if (width >= 100) {
      this.renderWide(lines, width, providers, entries, selected);
    } else {
      this.renderNarrow(lines, width, entries, selected);
    }

    if (this.status) lines.push(truncateToWidth(this.theme.fg("warning", ` ${this.status}`), width, ""));
    lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
    lines.push(
      truncateToWidth(
        this.theme.fg("dim", " ↑↓ navigate  Enter select  / search  Tab/f provider  A add  R refresh  Esc/q close "),
        width,
        "",
      ),
    );

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderWide(
    lines: string[],
    width: number,
    providers: CatalogProvider[],
    entries: CatalogEntry[],
    selected: CatalogEntry | undefined,
  ): void {
    const leftWidth = Math.max(18, Math.floor(width * 0.2));
    const rightWidth = Math.max(32, Math.floor(width * 0.3));
    const centerWidth = Math.max(20, width - leftWidth - rightWidth - 2);
    const providerLines = ["ALL PROVIDERS", ...providers.map((provider) => `${provider.name} (${provider.modelCount})`)];
    const modelLines = entries.length
      ? entries.map((entry, index) => {
          let marker = " ";
          if (entry.key === this.currentKey) marker = "★";
          else if (index === this.selectedIndex) marker = "›";
          const source = sourceLabel(entry.source);
          return `${marker} ${entry.model.id} · ${source}`;
        })
      : ["No models match this filter"];
    const detailLines = selected ? this.detailLines(selected) : ["Select a model to inspect it"];
    const rowCount = Math.max(providerLines.length, modelLines.length, detailLines.length, 1);

    lines.push(
      this.theme.fg(
        "borderMuted",
        `${padRight("Providers", leftWidth)} ${padRight("Models", centerWidth)} ${padRight("Details", rightWidth)}`,
      ),
    );
    for (let row = 0; row < rowCount; row++) {
      let provider = providerLines[row];
      if (row === 0) provider = this.providerFilter ? `> ${this.providerFilter}` : "> All providers";
      const model = modelLines[row];
      const detail = detailLines[row];
      const line = `${padRight(provider ?? "", leftWidth)} ${padRight(model ?? "", centerWidth)} ${detail ?? ""}`;
      lines.push(truncateToWidth(line, width, ""));
    }
  }

  private renderNarrow(lines: string[], width: number, entries: CatalogEntry[], selected: CatalogEntry | undefined): void {
    lines.push(truncateToWidth(this.theme.fg("accent", ` Provider: ${this.providerFilter ?? "all"}`), width, ""));
    lines.push(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))), width, ""));
    if (entries.length === 0) {
      lines.push(truncateToWidth(this.theme.fg("muted", " No models match this filter"), width, ""));
      return;
    }
    const visible = Math.min(entries.length, 14);
    const start = Math.max(0, Math.min(this.selectedIndex - 6, entries.length - visible));
    for (let index = start; index < start + visible; index++) {
      const entry = entries[index];
      if (!entry) continue;
      let marker = " ";
      if (entry.key === this.currentKey) marker = "★";
      else if (index === this.selectedIndex) marker = "›";
      const line = `${marker} ${entry.model.id}  ${this.theme.fg("muted", `${entry.providerId} · ${modelCapability(entry)}`)}`;
      lines.push(truncateToWidth(line, width, ""));
    }
    if (selected) {
      lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))));
      for (const line of this.detailLines(selected)) lines.push(truncateToWidth(` ${line}`, width, ""));
    }
  }

  private detailLines(entry: CatalogEntry): string[] {
    const model = entry.model;
    return [
      this.theme.fg("accent", model.name || model.id),
      `Provider: ${entry.providerName} (${entry.providerId})`,
      `Source: ${sourceLabel(entry.source)}${entry.manageable ? " · editable" : " · read-only"}`,
      `API: ${model.api}`,
      `Input: ${model.input.join(", ")}`,
      `Reasoning: ${model.reasoning ? "yes" : "no"}`,
      `Context: ${compactNumber(model.contextWindow)}`,
      `Max output: ${compactNumber(model.maxTokens)}`,
    ];
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
