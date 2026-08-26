import { describe, expect, it } from "vitest";
import { formatApprovalField } from "../src/approval-format";

describe("formatApprovalField", () => {
  it("uses a fence longer than the longest backtick run", () => {
    const value = "three ``` then " + "`".repeat(6);
    const fence = "`".repeat(7);

    expect(formatApprovalField("Name", value)).toBe(
      `**Name:**\n\n${fence}\n${value}\n${fence}`,
    );
  });
});
