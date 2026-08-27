import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID,
  SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { accountLabel, waitFor } from "../src/rpc-client.js";

let harness: Harness;
const model = scriptedChatCompletions([
  {
    toolCall: {
      id: "write-test-value",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) { console.log(await env.TEST_AMBIENT.writeValue(7)); }",
      },
    },
  },
  { text: "The test value was updated." },
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

const TEST_ACTION_STATE = z.object({
  pending: z.array(z.object({ id: z.number(), value: z.number() })),
  value: z.number().optional(),
  applyCount: z.number(),
});
type TestActionState = z.infer<typeof TEST_ACTION_STATE>;

async function actionState(label: string): Promise<TestActionState> {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/action-state",
      { method: "POST", body: JSON.stringify({ label }) });
  if (response.status !== 200) {
    throw new Error(`Reading test action state failed with ${response.status}: ${await response.text()}`);
  }
  return TEST_ACTION_STATE.parse(await response.json());
}

it("holds a scripted agent write until the user approves it", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix: "agentaction",
  });
  const label = accountLabel(session.connectedAccount(TEST_VENDOR_ID));

  const firstTurn = await session.runTurn("Set the test value to 7.");
  const pending = await waitForPendingAction(session);
  expect(firstTurn.outcome).toEqual({ status: "completed" });
  expect(pending).toMatchObject({
    type: "action",
    state: "pending",
    description: {
      title: "Set the test value to 7",
      awaitDecision: true,
      implementsRevert: false,
    },
  });
  expect(await actionState(label)).toEqual({
    pending: [{ id: 1, value: 7 }],
    applyCount: 0,
  });
  expect(model.requests).toHaveLength(1);

  const resumed = await session.approveActionAndWait(pending.id);
  expect(resumed.outcome).toEqual({ status: "completed" });
  expect(await actionState(label)).toEqual({ pending: [], value: 7, applyCount: 1 });
  const [approved] = (await session.listActions({ filter: "action" })).entries;
  expect(approved).toMatchObject({ id: pending.id, state: "approved", type: "action" });
  if (approved?.type !== "action") throw new Error("Approved test action was not an action record");
  expect(approved.resolvedBy).toMatchObject({ type: "user", id: session.username });
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: expect.stringContaining("1") }),
    ]),
  });
  expect(resumed.history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      message: "The test value was updated.",
    }),
  ]));
  await expect(session.approveActionAndWait(pending.id)).rejects.toThrow();
  expect((await actionState(label)).applyCount).toBe(1);
  expect(model.remainingSteps()).toBe(0);
});

async function waitForPendingAction(session: WorkshopAgentSession) {
  return waitFor("the test action to enter the approval queue", async () => {
    const entries = (await session.listActions({ filter: "pending" })).entries;
    return entries.length === 1 ? entries[0] : null;
  });
}
