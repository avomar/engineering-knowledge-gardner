import { describe, expect, it } from "vitest";

import { SourceAdapterError } from "../src/index";

describe("SourceAdapterError", () => {
  it("keeps a safe category and optional retry delay", () => {
    const error = new SourceAdapterError("rate_limited", "Try later", 4);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(4);
  });
});
