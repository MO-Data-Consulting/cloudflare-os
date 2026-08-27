import { describe, expect, it } from "vitest";
import { resolveModelAccess } from "./target.js";

describe("resolveModelAccess", () => {
  it("uses a complete AI Gateway configuration", () => {
    expect(resolveModelAccess({
      CF_AI_GATEWAY: "gateway",
      CF_AI_GATEWAY_ACCOUNT_ID: "account",
      CF_AI_GATEWAY_API_TOKEN: "token",
    })).toEqual({
      kind: "gateway",
      gateway: "gateway",
      accountId: "account",
      apiToken: "token",
    });
  });

  it("uses direct Workers AI credentials", () => {
    expect(resolveModelAccess({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    })).toEqual({ kind: "direct", accountId: "account", apiToken: "token" });
  });

  it("rejects a partial Gateway configuration", () => {
    expect(() => resolveModelAccess({ CF_AI_GATEWAY: "gateway" }))
      .toThrow("require CF_AI_GATEWAY");
  });

  it("rejects missing model credentials", () => {
    expect(() => resolveModelAccess({})).toThrow("model credentials");
  });
});
