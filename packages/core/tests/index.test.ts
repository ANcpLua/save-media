import { describe, expect, it } from "vitest";
import * as core from "../src/index";

describe("public API", () => {
  it("exports classify, dispatch, verify, userMessage", () => {
    expect(typeof core.classify).toBe("function");
    expect(typeof core.dispatch).toBe("function");
    expect(typeof core.verify).toBe("function");
    expect(typeof core.userMessage).toBe("function");
  });

  it("exports the one byte formatter and the network explanation", () => {
    expect(core.formatBytes(1536)).toBe("1.5 KB");
    expect(typeof core.networkBlock).toBe("function");
    expect(core.addressScope("10.0.0.1")).toBe("private");
  });

  it("exports RETRY_POLICY constant", () => {
    expect(core.RETRY_POLICY.segment.maxAttempts).toBe(5);
  });

  it("exports type predicates", () => {
    expect(typeof core.isJobError).toBe("function");
    expect(typeof core.isCertificateError).toBe("function");
  });
});
