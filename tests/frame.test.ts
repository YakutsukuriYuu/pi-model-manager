import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { windowRange } from "../src/ui/frame.ts";

test("a list that fits is shown in full", () => {
  assert.deepEqual(windowRange(3, 0, 10), { start: 0, end: 3 });
  assert.deepEqual(windowRange(10, 9, 10), { start: 0, end: 10 });
});

test("the window follows the selection instead of running off the end", () => {
  // Selection at the top: window pinned to the start.
  assert.deepEqual(windowRange(100, 0, 10), { start: 0, end: 10 });
  // Middle: centred on the selection.
  assert.deepEqual(windowRange(100, 50, 10), { start: 45, end: 55 });
  // At the bottom: pinned to the end, so the cursor stays visible.
  assert.deepEqual(windowRange(100, 99, 10), { start: 90, end: 100 });
  assert.deepEqual(windowRange(100, 95, 10), { start: 90, end: 100 });
});

test("the selected row is always inside the window", () => {
  for (const total of [1, 2, 17, 69, 200]) {
    for (const maxRows of [1, 4, 7, 17]) {
      for (let selected = 0; selected < total; selected++) {
        const { start, end } = windowRange(total, selected, maxRows);
        assert.ok(
          selected >= start && selected < end,
          `selected ${selected} fell outside [${start}, ${end}) for total ${total}, maxRows ${maxRows}`,
        );
        assert.ok(end - start <= Math.max(1, maxRows), "the window must not exceed maxRows");
        assert.ok(start >= 0 && end <= total, "the window must stay inside the list");
      }
    }
  }
});

test("a degenerate maxRows still shows one row", () => {
  assert.deepEqual(windowRange(10, 5, 0), { start: 5, end: 6 });
  assert.deepEqual(windowRange(10, 5, -3), { start: 5, end: 6 });
  assert.deepEqual(windowRange(0, 0, 10), { start: 0, end: 0 });
});

test("rendering a long list never exceeds the row budget", async () => {
  const { table } = await import("../src/ui/frame.ts");
  const rows = Array.from({ length: 200 }, (_, index) => ({ id: `model-${index}` }));
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

  for (const selected of [0, 99, 199]) {
    const lines = table({
      // SAFETY: the table only needs fg/bg from the theme.
      theme: theme as never,
      width: 100,
      columns: [{ title: "模型", width: "flex", value: (row) => row.id }],
      rows,
      selected,
      empty: "none",
      maxRows: 17,
    });
    // header + indicator + 17 rows
    assert.equal(lines.length, 19, `unexpected height at selected=${selected}`);
    assert.ok(lines.some((line) => line.includes(`model-${selected}`)), `selected row missing at ${selected}`);
    assert.ok(lines.some((line) => line.includes("共 200 项")), "scroll position must be reported");
    for (const line of lines) assert.ok(visibleWidth(line) <= 100);
  }
});
