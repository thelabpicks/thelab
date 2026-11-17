import { describe, expect, it } from "vitest";
import { bookCal, type BookCal } from "./confidence";

const table = (bands: [number, number][]): BookCal => ({
  kind: "measured", shrink: 50, rows: 1000, periods: 4, test_periods: 3, log_loss_raw: 0.71, log_loss_table: 0.7,
  bands: [0.5, 0.55, 0.6, 0.65, 0.7].map((lo, i) => ({ lo, hi: i === 4 ? 1 : lo + 0.05, n: bands[i][0], hits: bands[i][1], rate: bands[i][0] ? bands[i][1] / bands[i][0] : null })),
});

describe("bookCal (measured confidence table)", () => {
  it("leaves chances alone until a table is published, or an old-style refit is still cached", () => {
    expect(bookCal(0.72, null)).toBe(0.72);
    expect(bookCal(0.72, { a: 0.4, b: 0 } as unknown as BookCal)).toBe(0.72);
  });
  it("shows a band's real record, nudged toward the model by sample size, on the lean's own side", () => {
    const c = table([[400, 210], [400, 216], [300, 168], [200, 116], [100, 61]]);
    const over = bookCal(0.72, c);
    expect(over).toBeCloseTo((61 + 50 * 0.72) / 150, 6);
    const under = 1 - bookCal(0.28, c);
    expect(under).toBeCloseTo(over, 6);
  });
  it("keeps the model's order inside a band and never flips a losing band to the other side", () => {
    const c = table([[400, 210], [400, 216], [300, 168], [200, 116], [100, 61]]);
    expect(bookCal(0.8, c)).toBeGreaterThan(bookCal(0.72, c));
    const losing = table([[400, 210], [400, 216], [300, 168], [200, 116], [400, 150]]);
    expect(bookCal(0.72, losing)).toBe(0.5);
    expect(bookCal(0.28, losing)).toBe(0.5);
  });
});
