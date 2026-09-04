import { describe, expect, it } from "vitest";

import {
  appModeSchema,
  feedbackSchema,
  healthResponseSchema,
  indexStatusSchema,
  isoDateTimeSchema,
  messageRoleSchema,
} from "../src/index";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";

describe("domain schemas", () => {
  it("accepts the public health response", () => {
    expect(
      healthResponseSchema.parse({
        status: "ok",
        mode: "demo",
        checks: { database: "ok" },
      }),
    ).toEqual({
      status: "ok",
      mode: "demo",
      checks: { database: "ok" },
    });
  });

  it.each([
    [appModeSchema, "preview"],
    [indexStatusSchema, "complete"],
    [messageRoleSchema, "system"],
    [isoDateTimeSchema, "September 5"],
  ])("rejects invalid enum or date input", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("requires feedback to target exactly one resource", () => {
    const base = {
      id: firstId,
      rating: 1 as const,
      correction: null,
      createdAt: "2026-09-05T00:00:00.000Z",
    };

    expect(
      feedbackSchema.safeParse({
        ...base,
        messageId: secondId,
        draftId: null,
      }).success,
    ).toBe(true);
    expect(
      feedbackSchema.safeParse({
        ...base,
        messageId: secondId,
        draftId: secondId,
      }).success,
    ).toBe(false);
    expect(
      feedbackSchema.safeParse({
        ...base,
        messageId: null,
        draftId: null,
      }).success,
    ).toBe(false);
  });
});
