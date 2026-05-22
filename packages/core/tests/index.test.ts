import { describe, expect, it } from "vitest";
import * as core from "../src/index";

describe("public API", () => {
  it("exports classify, dispatch, verify, userMessage", () => {
    expect(typeof core.classify).toBe("function");
    expect(typeof core.dispatch).toBe("function");
    expect(typeof core.verify).toBe("function");
    expect(typeof core.userMessage).toBe("function");
  });

  it("exports RETRY_POLICY constant", () => {
    expect(core.RETRY_POLICY.segment.maxAttempts).toBe(5);
  });

  it("exports type predicates", () => {
    expect(typeof core.isTerminal).toBe("function");
    expect(typeof core.isRecoverable).toBe("function");
  });
});
