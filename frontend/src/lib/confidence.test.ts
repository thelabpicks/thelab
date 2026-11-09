import { describe, expect, it } from "vitest";
import { bookCal } from "./confidence";

describe("bookCal", () => {
  it("leaves chances alone until a refit is published", () => {
    expect(bookCal(0.72, null)).toBe(0.72);
  });
  it("pulls overconfident book-line chances toward even and keeps their order", () => {
    const c = { a: 0.36, b: -0.18, rows: 586, weeks: 3, test_weeks: 2, log_loss_raw: 0.709, log_loss_refit: 0.7 };
    const under80 = 1 - bookCal(0.2, c), under65 = 1 - bookCal(0.35, c);
    expect(under80).toBeLessThan(0.8);
    expect(under65).toBeLessThan(under80);
    expect(under65).toBeGreaterThan(0.5);
  });
});
