import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalModelAccess } from "./target.js";

const fakes = vi.hoisted(() => {
  const requestUrls: string[] = [];
  const responseStatuses: number[] = [];
  return {
    requestUrls,
    responseStatuses,
    session: { close: vi.fn(() => Promise.resolve()) },
    server: { close: vi.fn(() => Promise.resolve()) },
  };
});

vi.mock("@gadgets/integration-tests/agent-session", () => ({
  openAgentSession: vi.fn(() => Promise.resolve(fakes.session)),
}));

vi.mock("@gadgets/integration-tests/harness", () => ({
  startHarness: vi.fn(async () => {
    for (const url of fakes.requestUrls) {
      const method = url.includes("/logs/") ? "GET" : "POST";
      fakes.responseStatuses.push((await fetch(url, { method })).status);
    }
    return {
      url: new URL("http://127.0.0.1:8787"),
      server: fakes.server,
    };
  }),
}));

import { openLocalEvalTarget } from "./target.js";

const realFetch = globalThis.fetch;

beforeEach(() => {
  fakes.requestUrls.splice(0);
  fakes.responseStatuses.splice(0);
  globalThis.fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

async function run(access: LocalModelAccess): Promise<void> {
  const opened = await openLocalEvalTarget(access, "@cf/model", 25);
  await opened[Symbol.asyncDispose]();
}

it("allows the direct Workers AI route", async () => {
  fakes.requestUrls.push(
      "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1/chat/completions");

  await run({ kind: "direct", accountId: "account-id", apiToken: "token" });

  expect(globalThis.fetch).toHaveBeenCalledOnce();
  expect(fakes.responseStatuses).toEqual([204]);
});

it("allows AI Gateway inference and cost-log routes", async () => {
  fakes.requestUrls.push(
    "https://gateway.ai.cloudflare.com/v1/account-id/gateway/workers-ai/v1/chat/completions",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai-gateway/gateways/gateway/logs/log-id",
  );

  await run({
    kind: "gateway",
    gateway: "gateway",
    accountId: "account-id",
    apiToken: "token",
  });

  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(fakes.responseStatuses).toEqual([204, 204]);
});

it("returns a deterministic denial for every other route", async () => {
  fakes.requestUrls.push(
    "https://example.com/collect",
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1anything",
  );

  await run({ kind: "direct", accountId: "account-id", apiToken: "token" });

  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(fakes.responseStatuses).toEqual([403, 403]);
});
