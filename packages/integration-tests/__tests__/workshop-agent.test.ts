import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID,
  SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

let harness: Harness;
const READ_TEST_VALUE =
    "export default async function(self, env) { console.log(await env.TEST_AMBIENT.readValue()); }";
const model = scriptedChatCompletions([
  {
    toolCall: {
      id: "read-test-value",
      name: "executeCode",
      arguments: {
        code: READ_TEST_VALUE,
      },
    },
  },
  { text: "The test value is 42." },
  {
    toolCall: {
      id: "read-test-value-again",
      name: "executeCode",
      arguments: { code: READ_TEST_VALUE },
    },
  },
  { text: "The test value is still 42." },
  { error: { status: 503, message: "scripted provider outage" } },
]);
const network = new NetworkInterceptor([model.handler]);

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("keeps multi-turn history and returns provider errors", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    ambientVendorIds: [TEST_VENDOR_ID],
  });
  const result = await session.runTurn("Read the test value and tell me what it is.");

  expect(result.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(2);
  expect(model.requests[0]).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.stringContaining("Read the test value") }),
    ]),
  });
  expect(JSON.stringify(model.requests[0])).toContain("executeCode");
  expect(model.requests[1]).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: expect.stringContaining("42") }),
    ]),
  });
  expect(result.history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      toolCalls: expect.arrayContaining([
        expect.objectContaining({ toolName: "executeCode", output: expect.stringContaining("42") }),
      ]),
    }),
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      message: "The test value is 42.",
    }),
  ]));
  const second = await session.runTurn("Check the test value again.");
  expect(second.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(4);
  expect(second.history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "user" }),
      message: "Check the test value again.",
    }),
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      message: "The test value is still 42.",
    }),
  ]));
  const failed = await session.runTurn("Trigger the scripted provider failure.");
  expect(failed.outcome).toMatchObject({
    status: "error",
    message: expect.stringContaining("scripted provider outage"),
  });
  expect(failed.history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "error",
      message: expect.stringContaining("scripted provider outage"),
    }),
  ]));
  expect(model.requests).toHaveLength(5);
  expect(model.remainingSteps()).toBe(0);
});
