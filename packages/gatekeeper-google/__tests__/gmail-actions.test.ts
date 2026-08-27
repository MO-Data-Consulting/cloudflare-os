import {afterEach, describe, expect, it, vi} from "vitest";
import {
  base64UrlDecodedByteLength, buildEncodedEmail, decodeBase64UrlToBytes, extractRfc822Attachments,
  GmailApi, GmailOutboundSpec, parseMimeMessage,
} from "../src/google-api";
import {
  GmailDraftState, GmailForwardSnapshotReference, GmailForwardSnapshotStore,
  gmailDraftStateFingerprint,
} from "../src/gmail-state";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  RpcStub: class {
    [Symbol.dispose](): void {}
  },
  RpcTarget: class {
    [Symbol.dispose](): void {}
  },
}));
vi.mock("capnweb-validate", () => ({
  skipRpcValidation: () => () => undefined,
  validateRpc: () => () => undefined,
}));

const {GmailGatekeeperImpl} = await import("../src/gmail");

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json"}});

function memoryStorage() {
  const values = new Map<string, unknown>();
  const kv = {
    get<T>(key: string): T | undefined { return values.get(key) as T | undefined; },
    put<T>(key: string, value: T): void { values.set(key, value); },
    delete(key: string): boolean { return values.delete(key); },
    list<T>(options?: {prefix?: string}): Iterable<[string, T]> {
      return [...values]
        .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
        .toSorted(([left], [right]) => left.localeCompare(right)) as Array<[string, T]>;
    },
  };
  const storage = {
    kv,
    transactionSync<T>(callback: () => T): T {
      const before = structuredClone(values);
      try {
        return callback();
      } catch (error) {
        values.clear();
        for (const [key, value] of before) values.set(key, value);
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  return {storage, values};
}

type FetchCall = {url: URL; init: RequestInit};

function actionHarness(
    gmailFetch: (url: URL, init: RequestInit) => Response | Promise<Response>,
    props: {searchQuery?: string; labelName?: string} = {}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push({url, init});
    if (url.hostname === "www.googleapis.com" && url.pathname === "/oauth2/v3/userinfo") {
      return json({sub: "account-subject", email: "me@example.com"});
    }
    return gmailFetch(url, init);
  });
  const {storage, values} = memoryStorage();
  const ctx = {
    storage,
    props: {userObjectId: "user-object", ...props},
    exports: {
      UserAccount: {
        idFromString: (id: string) => id,
        get: () => ({
          getAccessToken: async () => ({
            token: "access-token", expires: new Date(Date.now() + 60 * 60 * 1000),
          }),
        }),
      },
    },
  };
  const gatekeeper = new GmailGatekeeperImpl(ctx as never, {} as never);
  return {calls, gatekeeper, storage, values};
}

function approvalQueue(
    submitAction = vi.fn(async () => undefined)) {
  const queue = {
    authorizeObservation: vi.fn(async () => undefined),
    submitAction,
    dup: () => queue,
    [Symbol.dispose]: vi.fn(),
  };
  return queue;
}

function draftFull(
    providerId: string, messageId: string, threadId: string,
    state: GmailDraftState) {
  const body = new TextEncoder().encode(state.text);
  let binary = "";
  for (const byte of body) binary += String.fromCharCode(byte);
  return {
    id: providerId,
    message: {
      id: messageId,
      threadId,
      internalDate: "1",
      sizeEstimate: body.byteLength,
      payload: {
        mimeType: "text/plain",
        headers: [
          {name: "From", value: state.from},
          {name: "To", value: state.to.join(", ")},
          {name: "Subject", value: state.subject},
          {name: "Message-ID", value: state.rfcMessageId!},
        ],
        body: {
          size: body.byteLength,
          data: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
        },
      },
    },
  };
}

function messageMetadata(
    id: string, threadId: string, rfcMessageId = "<message@example.com>", labelIds: string[] = []) {
  return {
    id,
    threadId,
    internalDate: "1",
    labelIds,
    payload: {headers: [
      {name: "From", value: "sender@example.com"},
      {name: "To", value: "me@example.com"},
      {name: "Subject", value: "Known message"},
      {name: "Message-ID", value: rfcMessageId},
    ]},
  };
}

function threadMinimal(id: string, messageIds: string[]) {
  return {id, messages: messageIds.map(messageId => ({id: messageId}))};
}

function outboundSpec(messageId = "<forward@gadgets.invalid>"): GmailOutboundSpec {
  return {
    from: "me@example.com",
    replyTo: [],
    to: ["to@example.com"],
    cc: [],
    bcc: [],
    subject: "Fwd: Subject",
    text: "Forwarded message attached.",
    messageId,
    attachments: [],
  };
}

async function seedForwardSend(
    storage: DurableObjectStorage, bytes: Uint8Array, actionId = 1) {
  const snapshot = await new GmailForwardSnapshotStore(storage).capture(bytes);
  storage.kv.put(`pending:action:${actionId}`, {
    type: "send",
    mode: "forward",
    spec: outboundSpec(),
    sourceMessageId: "source-message",
    sourceAttachment: {
      ...snapshot,
      messageId: "source-message",
      description: "Complete original message",
    },
  });
  return snapshot;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((byte, offset) => haystack[i + offset] === byte)) return true;
  }
  return false;
}

function forwardDraftState(
    snapshot: GmailForwardSnapshotReference, logicalId = "provisional-draft"): GmailDraftState {
  return {
    logicalId,
    from: "me@example.com",
    replyTo: [],
    to: ["to@example.com"],
    cc: [],
    bcc: [],
    subject: "Fwd: Subject",
    text: "Forwarded message attached.",
    rfcMessageId: "<forward-draft@gadgets.invalid>",
    timestamp: 1,
    source: {kind: "forward", messageId: "source-message"},
    attachments: [{
      key: "forward-source",
      info: {
        filename: "forwarded-message.eml",
        mimeType: "message/rfc822",
        size: snapshot.size,
        disposition: "attachment",
        readable: true,
      },
      contentDigest: snapshot.digest,
    }],
    version: 0,
  };
}

async function seedForwardDraft(storage: DurableObjectStorage, bytes: Uint8Array, actionId = 1) {
  const snapshot = await new GmailForwardSnapshotStore(storage).capture(bytes);
  const state = forwardDraftState(snapshot);
  storage.kv.put(`gmail:draft:${state.logicalId}`, {
    logicalId: state.logicalId,
    source: state.source,
    createdAt: 1,
    status: "active",
    version: 0,
  });
  storage.kv.put(`pending:action:${actionId}`, {
    type: "draftCreate",
    draft: state,
    sourceAttachment: {
      ...snapshot,
      messageId: "source-message",
      description: "Complete original message",
    },
  });
  return {snapshot, state};
}

afterEach(() => vi.unstubAllGlobals());

describe("Gmail forward action snapshots", () => {
  it("sends a new forward inline with ordinary source attachments", async () => {
    const sourceRaw = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: `${"x".repeat(70 * 1024)}\nSource body`,
      html: "<p>Source <strong>HTML</strong></p>",
      messageId: "<source@gadgets.invalid>",
      attachments: [{
        filename: "source.txt",
        contentType: "text/plain",
        data: btoa("source attachment"),
        disposition: "attachment",
        description: "source attachment",
      }],
    });
    let sentRaw: string | undefined;
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return url.searchParams.has("q")
          ? json({messages: []})
          : json({messages: [{id: "source-message", threadId: "source-thread"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/source-message" && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: "source-message", threadId: "source-thread", internalDate: "1", raw: sourceRaw});
        }
        return json({
          id: "source-message", threadId: "source-thread", internalDate: "1",
          sizeEstimate: base64UrlDecodedByteLength(sourceRaw), labelIds: [],
          payload: {headers: [
            {name: "From", value: "source@example.com"},
            {name: "To", value: "me@example.com"},
            {name: "Subject", value: "Source subject"},
            {name: "Message-ID", value: "<source@gadgets.invalid>"},
          ]},
        });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {raw: string}).raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);
    const messages = await (await session.listMessages()).next();

    await messages![0].message.forward(
      ["recipient@example.com"], "Intro", {html: "<p>Intro</p>"});
    await gatekeeper.applyAction(1);

    const parsed = await parseMimeMessage(sentRaw!);
    expect(parsed.text).toContain("Intro");
    expect(parsed.text).toContain("---------- Forwarded message ---------");
    expect(parsed.text).toContain("Source body");
    expect(parsed.html).toContain("Source <strong>HTML</strong>");
    expect(parsed.attachments.map(attachment => attachment.filename)).toEqual(["source.txt"]);
  });

  it("creates an inline forward draft from the captured source snapshot", async () => {
    const sourceRaw = buildEncodedEmail({
      from: "source@example.com",
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: "Source body",
      messageId: "<source-draft@gadgets.invalid>",
      attachments: [],
    });
    let createdRaw: string | undefined;
    let sentRaw: string | undefined;
    let providerMessageId = "provider-message";
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: "source-message", threadId: "source-thread"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/source-message" && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: "source-message", threadId: "source-thread", internalDate: "1", raw: sourceRaw});
        }
        return json({
          id: "source-message", threadId: "source-thread", internalDate: "1", sizeEstimate: 100,
          labelIds: [], payload: {headers: [
            {name: "From", value: "source@example.com"},
            {name: "To", value: "me@example.com"},
            {name: "Subject", value: "Source subject"},
            {name: "Message-ID", value: "<source-draft@gadgets.invalid>"},
          ]},
        });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        createdRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "provider-draft", message: {id: "provider-message"}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({
          id: "provider-draft",
          message: {
            id: providerMessageId, threadId: "provider-thread", internalDate: "1", raw: createdRaw,
          },
        });
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && init.method === "PUT") {
        createdRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        providerMessageId = "provider-message-2";
        return json({id: "provider-draft", message: {id: providerMessageId}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);
    const messages = await (await session.listMessages()).next();
    const draft = await messages![0].message.createForwardDraft(["recipient@example.com"], "Intro");

    await expect(draft.getContent()).resolves.toMatchObject({
      text: expect.stringContaining("---------- Forwarded message ---------"),
    });
    await gatekeeper.applyAction(1);

    const parsed = await parseMimeMessage(createdRaw!);
    expect(parsed.text).toContain("Intro");
    expect(parsed.text).toContain("Source body");
    expect(parsed.attachments).toHaveLength(0);

    await draft.update({text: "Updated intro"});
    await gatekeeper.applyAction(2);
    const updated = await parseMimeMessage(createdRaw!);
    expect(updated.text).toContain("Updated intro");
    expect(updated.text).toContain("Source body");

    await draft.send();
    await gatekeeper.applyAction(3);
    expect(await parseMimeMessage(sentRaw!)).toMatchObject({text: expect.stringContaining("Source body")});
    expect([...values.keys()].some(key => key.startsWith("gmail:forwardSnapshot:") &&
      !key.endsWith("totalBytes"))).toBe(false);
  });

  it("sends the initially captured bytes without a second source GET and cleans up", async () => {
    const initial = new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nBody");
    let sentRaw: string | undefined;
    const {calls, gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {raw: string}).raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      if (url.pathname.includes("source-message")) {
        return json({
          id: "source-message", threadId: "source-thread", internalDate: "1", raw: "ZGlmZmVyZW50",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await seedForwardSend(storage, initial);

    await gatekeeper.applyAction(1);

    const parsed = await parseMimeMessage(sentRaw!);
    expect(parsed.attachments[0].mimeType).toBe("message/rfc822");
    expect(containsBytes(decodeBase64UrlToBytes(sentRaw!), initial)).toBe(true);
    expect(calls.some(call => call.url.pathname.includes("source-message"))).toBe(false);
    expect([...values.keys()].some(key => key.includes(snapshot.handle))).toBe(false);
    expect(values.has("pending:action:1")).toBe(false);
  });

  it("fails corrupt chunks before a Gmail write", async () => {
    let writes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      if (init.method === "POST") writes++;
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await seedForwardSend(storage, new Uint8Array([1, 2, 3]));
    const chunkKey = [...values.keys()].find(key =>
      key.includes(snapshot.handle) && key.includes(":chunk:"))!;
    const chunk = (values.get(chunkKey) as Uint8Array).slice();
    chunk[0] ^= 0xff;
    values.set(chunkKey, chunk);

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/incomplete or corrupted/);
    expect(writes).toBe(0);
  });

  it("retains an ambiguous snapshot and reconciles before trying to materialize it", async () => {
    let delivered = false;
    let writes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: delivered ? [{id: "sent-message", threadId: "sent-thread"}] : []});
      }
      if (url.pathname === "/gmail/v1/users/me/messages/send" && init.method === "POST") {
        writes++;
        throw new Error("connection lost after write");
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await seedForwardSend(storage, new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nBody"));

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/connection lost/);
    expect([...values.keys()].some(key => key.includes(snapshot.handle))).toBe(true);
    expect(values.has("gmail:applying:1")).toBe(true);

    const chunkKey = [...values.keys()].find(key =>
      key.includes(snapshot.handle) && key.includes(":chunk:"))!;
    values.delete(chunkKey);
    delivered = true;
    await gatekeeper.applyAction(1);

    expect(writes).toBe(1);
    expect([...values.keys()].some(key => key.includes(snapshot.handle))).toBe(false);
    expect(values.has("pending:action:1")).toBe(false);
  });

  it("cleans up a rejected direct forward snapshot", async () => {
    const {gatekeeper, storage, values} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const snapshot = await seedForwardSend(storage, new Uint8Array([7, 7, 7]));

    await gatekeeper.rejectAction(1);

    expect([...values.keys()].some(key => key.includes(snapshot.handle))).toBe(false);
    expect(values.has("pending:action:1")).toBe(false);
  });

  it("fails old pending snapshot shapes closed after reconciliation", async () => {
    let writes = 0;
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      if (init.method === "POST") writes++;
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put("pending:action:1", {
      type: "send",
      mode: "forward",
      spec: outboundSpec(),
      sourceMessageId: "source-message",
      sourceAttachment: {
        messageId: "source-message", size: 3, digest: "0".repeat(64), description: "Legacy",
      },
    });
    storage.kv.put("gmail:applying:1", Date.now());

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/reject and resubmit/i);
    expect(writes).toBe(0);
  });

  it("fails old forward-draft snapshot shapes closed", async () => {
    const {gatekeeper, storage} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const digest = "0".repeat(64);
    const state = forwardDraftState({handle: crypto.randomUUID(), size: 3, digest});
    storage.kv.put(`gmail:draft:${state.logicalId}`, {
      logicalId: state.logicalId,
      source: state.source,
      createdAt: 1,
      status: "active",
      version: 0,
    });
    storage.kv.put("pending:action:1", {
      type: "draftCreate",
      draft: state,
      sourceAttachment: {
        messageId: "source-message", size: 3, digest, description: "Legacy",
      },
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/reject and resubmit/i);
  });

  it("creates a forward draft from captured bytes without refetching the source", async () => {
    const initial = new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nBody");
    let createdRaw: string | undefined;
    const {calls, gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        createdRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "provider-draft", message: {id: "provider-message"}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({
          id: "provider-draft",
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw: createdRaw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const {snapshot, state} = await seedForwardDraft(storage, initial);

    await gatekeeper.applyAction(1);

    const parsed = await parseMimeMessage(createdRaw!);
    expect(parsed.attachments[0].mimeType).toBe("message/rfc822");
    expect(containsBytes(decodeBase64UrlToBytes(createdRaw!), initial)).toBe(true);
    expect(calls.some(call => call.url.pathname.includes("source-message"))).toBe(false);
    expect([...values.keys()].some(key => key.includes(snapshot.handle))).toBe(false);
    expect(values.get(`gmail:draft:${state.logicalId}`)).toMatchObject({
      logicalId: state.logicalId,
      providerId: "provider-draft",
    });
  });

  it("preserves exact forwarded message bytes through draft update and send", async () => {
    const source = new TextEncoder().encode(
      "From: source@example.com\r\nTo: me@example.com\r\nSubject: Source\r\n\r\nExact body");
    let providerRaw: string | undefined;
    let providerMessageId = "provider-message-1";
    let sentRaw: string | undefined;
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        providerRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "provider-draft", message: {id: providerMessageId}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        if (url.searchParams.get("format") === "full") {
          return json(draftFull("provider-draft", providerMessageId, "provider-thread", {
            ...forwardDraftState({handle: "unused", size: source.length, digest: "unused"}),
            text: "Updated body",
          }));
        }
        return json({
          id: "provider-draft",
          message: {
            id: providerMessageId,
            threadId: "provider-thread",
            internalDate: "1",
            raw: providerRaw,
          },
        });
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && init.method === "PUT") {
        providerMessageId = "provider-message-2";
        providerRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "provider-draft", message: {id: providerMessageId}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/send" && init.method === "POST") {
        sentRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        return json({id: "sent-message", threadId: "sent-thread"});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const {state} = await seedForwardDraft(storage, source);
    storage.kv.put("pending:nextActionId", 2);

    await gatekeeper.applyAction(1);
    expect(extractRfc822Attachments(providerRaw!)[0].bytes).toEqual(source);
    const session = await gatekeeper.startSession(approvalQueue() as never);
    const draft = await session.getDraft(state.logicalId);
    await draft.update({text: "Updated body"});
    await gatekeeper.applyAction(2);
    expect(extractRfc822Attachments(providerRaw!)[0].bytes).toEqual(source);
    await draft.send();
    await gatekeeper.applyAction(3);

    expect(extractRfc822Attachments(sentRaw!)[0].bytes).toEqual(source);
  });

  it("cleans up a rejected forward draft snapshot", async () => {
    const {gatekeeper, storage, values} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const {snapshot, state} = await seedForwardDraft(storage, new Uint8Array([10, 11]));

    await gatekeeper.rejectAction(1);

    expect([...values.keys()].some(key => key.includes(snapshot.handle))).toBe(false);
    expect(values.get(`gmail:draft:${state.logicalId}`)).toMatchObject({status: "rejected"});
  });

  it("reads the initially captured bytes through a provisional attachment capability", async () => {
    const initial = new Uint8Array([0, 17, 34, 128, 255]);
    const {gatekeeper, storage} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await seedForwardDraft(storage, initial);
    const session = await gatekeeper.startSession(approvalQueue() as never);
    const cursor = await session.listDrafts();
    const entries = await cursor.next();

    expect(entries).toHaveLength(1);
    const attachments = await entries![0].draft.attachments();
    expect(attachments).toHaveLength(1);
    expect(new Uint8Array(await attachments[0].attachment.getContent())).toEqual(initial);
  });

  it("cleans direct and draft snapshots when approval submission fails", async () => {
    const sourceId = "source-message";
    const threadId = "source-thread";
    const sourceRaw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      from: "sender@example.com",
      replyTo: [],
      to: ["me@example.com"],
      cc: [],
      bcc: [],
      subject: "Source subject",
      text: "Source body",
      messageId: "<source@example.com>",
      attachments: [],
    }).raw;
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: sourceId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${sourceId}` && !init.method) {
        if (url.searchParams.get("format") === "raw") {
          return json({id: sourceId, threadId, internalDate: "1", raw: sourceRaw});
        }
        return json({
          id: sourceId,
          threadId,
          internalDate: "1",
          sizeEstimate: 100,
          labelIds: [],
          payload: {headers: [
            {name: "From", value: "sender@example.com"},
            {name: "To", value: "me@example.com"},
            {name: "Subject", value: "Source subject"},
            {name: "Message-ID", value: "<source@example.com>"},
          ]},
        });
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const submit = vi.fn(async () => {
      throw new Error("approval queue unavailable");
    });
    const session = await gatekeeper.startSession(approvalQueue(submit) as never);
    const messages = await (await session.listMessages()).next();
    const message = messages![0].message;

    await expect(message.forward(["to@example.com"])).rejects.toThrow(/approval queue unavailable/);
    await expect(message.createForwardDraft(["to@example.com"]))
      .rejects.toThrow(/approval queue unavailable/);

    expect(submit).toHaveBeenCalledTimes(2);
    expect([...values.keys()].some(key =>
      key.startsWith("gmail:forwardSnapshot:") && !key.endsWith("totalBytes"))).toBe(false);
    expect([...values.keys()].some(key =>
      key.startsWith("gmail:forwardSnapshotAllocation:") && !key.endsWith("totalBytes")))
      .toBe(false);
    expect([...values].find(([key]) => key.endsWith("totalBytes"))?.[1]).toBe(0);
    expect([...values.keys()].some(key => key.startsWith("gmail:draft:"))).toBe(false);
    expect([...values.keys()].some(key => key.startsWith("pending:action:"))).toBe(false);
  });
});

describe("Gmail draft lookup", () => {
  it("reopens a stable logical ID with pending updates overlaid", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);
    const created = await session.createDraft({
      to: ["to@example.com"], subject: "Initial subject", text: "Body",
    });
    const {id} = await created.getMetadata();
    await created.update({subject: "Updated subject"});

    const reopened = await session.getDraft(id);

    await expect(reopened.getMetadata()).resolves.toMatchObject({
      id,
      subject: "Updated subject",
    });
  });

  it("does not reopen an unscoped draft through a restricted binding", async () => {
    const {gatekeeper, storage} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    storage.kv.put("gmail:draft:provider-draft", {
      logicalId: "provider-draft",
      providerId: "provider-draft",
      createdAt: 1,
      status: "active",
      version: 0,
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);

    await expect(session.getDraft("provider-draft")).rejects.toThrow(/restricted binding/);
  });

  it("rejects malformed and unknown logical IDs", async () => {
    const {gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);

    await expect(session.getDraft("not/a/draft")).rejects.toThrow(/Invalid Gmail draft ID/);
    await expect(session.getDraft("unknown-draft")).rejects.toThrow(/Unknown Gmail draft ID/);
  });
});

describe("Gmail message lookup", () => {
  const messageId = "1a03a1e31ecc5e7f";
  const threadId = "1a03a1e31ecc5e70";

  it("opens a known message by ID without scanning the mailbox", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);

    const message = await session.getMessage(messageId);
    await expect(message.getMetadata()).resolves.toMatchObject({
      id: messageId,
      threadId,
      subject: "Known message",
    });

    expect(calls.filter(call =>
      call.url.pathname === "/gmail/v1/users/me/messages")).toHaveLength(0);
    expect(calls.filter(call =>
      call.url.pathname === `/gmail/v1/users/me/messages/${messageId}`)).toHaveLength(1);
  });

  it("allows an empty direct reply", async () => {
    const submitAction = vi.fn(async () => undefined);
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue(submitAction) as never);
    const entries = await (await session.listMessages()).next();

    await entries![0].message.reply("");

    expect(values.get("pending:action:1")).toMatchObject({
      type: "send",
      mode: "reply",
      spec: {text: ""},
    });
  });

  it("allows an empty reply draft to be sent", async () => {
    const submitAction = vi.fn(async () => undefined);
    const {gatekeeper, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue(submitAction) as never);
    const entries = await (await session.listMessages()).next();
    const draft = await entries![0].message.createReplyDraft("");

    await expect(draft.send()).resolves.toBeUndefined();

    expect(values.get("pending:action:2")).toMatchObject({
      type: "draftSend",
      approved: {text: ""},
    });
  });

  it("checks the binding restriction before opening a known message", async () => {
    const rfcMessageId = "<restricted@example.com>";
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, rfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue() as never);

    await expect(session.getMessage(messageId)).rejects.toThrow(/restricted binding/);
    const scopeCheck = calls.find(call => call.url.pathname === "/gmail/v1/users/me/messages");
    expect(scopeCheck?.url.searchParams.get("q")).toBe(
      "(from:sender@example.com) AND (rfc822msgid:restricted@example.com)");
  });

  it("opens a message admitted by a search restriction", async () => {
    const rfcMessageId = "<admitted@example.com>";
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, rfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue() as never);

    await expect(session.getMessage(messageId)).resolves.toBeDefined();
  });

  it("opens a known thread by ID without scanning the thread list", async () => {
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json({
          id: threadId,
          messages: [{payload: {headers: [{name: "Subject", value: "Known thread"}]}}],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);

    const thread = await session.getThread(threadId);
    await expect(thread.getMetadata()).resolves.toMatchObject({
      id: threadId,
      subject: "Known thread",
      messageCount: 1,
    });

    expect(calls.filter(call => call.url.pathname === "/gmail/v1/users/me/threads")).toHaveLength(0);
    expect(calls.filter(call =>
      call.url.pathname === `/gmail/v1/users/me/threads/${threadId}`)).toHaveLength(1);
  });

  it("limits a search-scoped thread to its admitted messages", async () => {
    const excludedMessageId = "excluded-message";
    const admittedRfcMessageId = "<admitted-thread@example.com>";
    const excludedRfcMessageId = "<excluded-thread@example.com>";
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json(threadMinimal(threadId, [messageId, excludedMessageId]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, admittedRfcMessageId));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${excludedMessageId}` && !init.method) {
        return json(messageMetadata(excludedMessageId, threadId, excludedRfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: messageId, threadId}]});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue() as never);

    const thread = await session.getThread(threadId);
    await expect(thread.messages()).resolves.toHaveLength(1);
  });

  it("rejects a thread with no messages admitted by the binding", async () => {
    const rfcMessageId = "<outside-thread@example.com>";
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json(threadMinimal(threadId, [messageId]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, rfcMessageId));
      }
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: []});
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {searchQuery: "from:sender@example.com"});
    const session = await gatekeeper.startSession(approvalQueue() as never);

    await expect(session.getThread(threadId)).rejects.toThrow(/restricted binding/);
  });

  it("limits a label-scoped thread to messages carrying the bound label", async () => {
    const admittedMessageId = "admitted-label-message";
    const excludedMessageId = "excluded-label-message";
    const {gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: "Label_1", name: "Team", type: "user"}]});
      }
      if (url.pathname === `/gmail/v1/users/me/threads/${threadId}` && !init.method) {
        return json(threadMinimal(threadId, [messageId, admittedMessageId, excludedMessageId]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId, "<labeled@example.com>", ["Label_1"]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${admittedMessageId}` && !init.method) {
        return json(messageMetadata(
          admittedMessageId, threadId, "<also-labeled@example.com>", ["Label_1"]));
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${excludedMessageId}` && !init.method) {
        return json(messageMetadata(excludedMessageId, threadId, "<unlabeled@example.com>"));
      }
      throw new Error(`Unexpected request: ${url}`);
    }, {labelName: "Team"});
    const session = await gatekeeper.startSession(approvalQueue() as never);

    const thread = await session.getThread(threadId);
    await expect(thread.messages()).resolves.toHaveLength(2);

    const messageThread = await (await session.getMessage(messageId)).thread();
    const messageThreadEntries = await messageThread.messages();
    const messageThreadIds = await Promise.all(
      messageThreadEntries.map(async message => (await message.getMetadata()).id));
    expect(messageThreadIds).toEqual([messageId, admittedMessageId]);
  });

  it("reports a non-mutable system label as a domain error", async () => {
    const submitAction = vi.fn(async () => undefined);
    const {calls, gatekeeper} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json(messageMetadata(messageId, threadId));
      }
      if (url.pathname === "/gmail/v1/users/me/labels" && !init.method) {
        return json({labels: [{id: "SENT", name: "SENT", type: "system"}]});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue(submitAction) as never);
    const message = await session.getMessage(messageId);

    await expect(message.applyLabel({id: "SENT", name: "SENT", type: "system"} as never))
      .rejects.toThrow(/not mutable/);

    expect(submitAction).not.toHaveBeenCalled();
    expect(calls.some(call => call.url.pathname.endsWith("/modify"))).toBe(false);
  });

  it("rejects malformed message IDs before contacting Gmail", async () => {
    const {calls, gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);

    await expect(session.getMessage("INVALID_MSG_ID_12345"))
      .rejects.toThrow(/Invalid Gmail message ID/);
    expect(calls.some(call => call.url.pathname.startsWith("/gmail/v1/users/me/messages/"))).toBe(false);
  });

  it("rejects malformed thread IDs before contacting Gmail", async () => {
    const {calls, gatekeeper} = actionHarness(url => {
      throw new Error(`Unexpected request: ${url}`);
    });
    const session = await gatekeeper.startSession(approvalQueue() as never);

    await expect(session.getThread("INVALID_THREAD_ID_12345"))
      .rejects.toThrow(/Invalid Gmail thread ID/);
    expect(calls.some(call => call.url.pathname.startsWith("/gmail/v1/users/me/threads/"))).toBe(false);
  });
});

describe("Gmail draft dependency reconciliation", () => {
  it("proactively merges an uncertain listed draft and keeps the provider draft after rejection", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const messageId = "provider-message";
    const threadId = "provider-thread";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<proactive-draft@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId),
      subject: state.subject,
      text: state.text,
    }).raw;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: providerId, message: {id: messageId}}]});
      }
      if (url.pathname === `/gmail/v1/users/me/messages/${messageId}` && !init.method) {
        return json({
          id: messageId,
          threadId,
          internalDate: "1",
          payload: {headers: [{name: "Message-ID", value: state.rfcMessageId}]},
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return url.searchParams.get("format") === "full"
          ? json(draftFull(providerId, messageId, threadId, state))
          : json({
              id: providerId,
              message: {id: messageId, threadId, internalDate: "1", raw},
            });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("gmail:applying:1", Date.now());
    const session = await gatekeeper.startSession(approvalQueue() as never);

    const reconciled = await (await session.listDrafts()).next();

    expect(reconciled).toHaveLength(1);
    expect(reconciled![0].info).toMatchObject({id: logicalId, messageId, threadId});
    expect(values.get(`gmail:draft:${logicalId}`)).toMatchObject({providerId, status: "active"});

    await gatekeeper.rejectAction(1);
    const retained = await (await session.listDrafts()).next();
    expect(retained).toHaveLength(1);
    expect(retained![0].info.id).toBe(logicalId);
    expect(values.get(`gmail:draft:${logicalId}`)).toMatchObject({providerId, status: "active"});
  });

  it("rebases each dependent action onto Gmail's normalized provider revision", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const rfcMessageId = "<normalized-draft@gadgets.invalid>";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Original",
      rfcMessageId,
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after: GmailDraftState = {...state, text: "Approved update", version: 1};
    const api = new GmailApi("me@example.com", async () => "token");
    let providerMessageId = "provider-message-1";
    let providerRaw = api.buildOutbound({
      ...outboundSpec(rfcMessageId),
      subject: state.subject,
      text: state.text + "\n",
    }).raw;
    let creates = 0;
    let updates = 0;
    let deletes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        creates++;
        return json({id: providerId, message: {id: providerMessageId}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: providerMessageId,
            threadId: "provider-thread",
            internalDate: "1",
            raw: providerRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        updates++;
        providerMessageId = "provider-message-2";
        providerRaw = api.buildOutbound({
          ...outboundSpec(rfcMessageId),
          subject: after.subject,
          text: after.text + "\n",
        }).raw;
        return json({id: providerId, message: {id: providerMessageId}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        deletes++;
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const expectedBefore = await gmailDraftStateFingerprint(state);
    const expectedAfter = await gmailDraftStateFingerprint(after);
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("pending:action:2", {
      type: "draftUpdate",
      draftId: logicalId,
      after,
      expectedBefore,
      dependsOn: [1],
    });
    storage.kv.put("pending:action:3", {
      type: "draftDelete",
      draftId: logicalId,
      expectedSnapshot: expectedAfter,
      dependsOn: [1, 2],
    });

    await gatekeeper.applyAction(1);

    expect(values.get("pending:action:2")).toMatchObject({
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [1],
    });
    expect((values.get("pending:action:2") as {expectedBefore: string}).expectedBefore)
      .not.toBe(expectedBefore);
    expect(values.get("pending:action:3")).toMatchObject({
      expectedSnapshot: expectedAfter,
      dependsOn: [1, 2],
    });
    expect(values.has("gmail:draftWriteReceipt:1")).toBe(false);

    await gatekeeper.applyAction(2);

    expect(values.get("pending:action:3")).toMatchObject({
      expectedProviderMessageId: "provider-message-2",
      dependsOn: [1, 2],
    });
    expect((values.get("pending:action:3") as {expectedSnapshot: string}).expectedSnapshot)
      .not.toBe(expectedAfter);

    await gatekeeper.applyAction(3);

    expect({creates, updates, deletes}).toEqual({creates: 1, updates: 1, deletes: 1});
    expect(values.has("pending:action:2")).toBe(false);
    expect(values.has("pending:action:3")).toBe(false);
    expect(values.has("gmail:draftWriteReceipt:2")).toBe(false);
  });

  it("retries provider-baseline capture from a durable create receipt without another write", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<receipt-draft@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text + "\n",
    }).raw;
    let creates = 0;
    let readable = false;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        creates++;
        return json({id: providerId, message: {id: "provider-message"}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return readable
          ? json({
              id: providerId,
              message: {
                id: "provider-message", threadId: "provider-thread", internalDate: "1", raw,
              },
            })
          : json({error: "temporarily unavailable"}, 400);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.get failed/);
    expect(values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: providerId, messageId: "provider-message",
    });
    readable = true;

    await gatekeeper.applyAction(1);

    expect(creates).toBe(1);
    expect(values.has("pending:action:1")).toBe(false);
    expect(values.has("gmail:draftWriteReceipt:1")).toBe(false);
  });

  it("retries provider-baseline capture from an update receipt without another write", async () => {
    const providerId = "provider-draft";
    const before: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message-1",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Before",
      rfcMessageId: "<update-receipt@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after: GmailDraftState = {...before, text: "After", version: 1};
    const api = new GmailApi("me@example.com", async () => "token");
    const beforeRaw = api.buildOutbound({
      ...outboundSpec(before.rfcMessageId), subject: before.subject, text: before.text,
    }).raw;
    const normalizedAfterRaw = api.buildOutbound({
      ...outboundSpec(after.rfcMessageId), subject: after.subject, text: after.text + "\n",
    }).raw;
    let providerMessageId = "provider-message-1";
    let baselineMode: "unavailable" | "changed" | "expected" = "unavailable";
    let updates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        if (providerMessageId === "provider-message-1") {
          return json({
            id: providerId,
            message: {
              id: providerMessageId,
              threadId: "provider-thread",
              internalDate: "1",
              raw: beforeRaw,
            },
          });
        }
        if (baselineMode === "unavailable") return json({error: "unavailable"}, 400);
        return json({
          id: providerId,
          message: {
            id: baselineMode === "changed" ? "provider-message-3" : "provider-message-2",
            threadId: "provider-thread",
            internalDate: "1",
            raw: normalizedAfterRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        updates++;
        providerMessageId = "provider-message-2";
        return json({id: providerId, message: {id: providerMessageId}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftUpdate",
      draftId: providerId,
      after,
      expectedBefore: await gmailDraftStateFingerprint(before),
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.get failed/);
    expect(values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: providerId, messageId: "provider-message-2",
    });

    baselineMode = "changed";
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);
    expect(updates).toBe(1);

    baselineMode = "expected";
    await gatekeeper.applyAction(1);

    expect(updates).toBe(1);
    expect(values.has("pending:action:1")).toBe(false);
    expect(values.has("gmail:draftWriteReceipt:1")).toBe(false);
  });

  it("completes an already-matching update without creating a write receipt", async () => {
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Already current",
      rfcMessageId: "<noop-update@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after = {...state, version: 1};
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text,
    }).raw;
    let updates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw,
          },
        });
      }
      if (init.method === "PUT") updates++;
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftUpdate",
      draftId: providerId,
      after,
      expectedBefore: await gmailDraftStateFingerprint(state),
      expectedProviderMessageId: "provider-message",
      dependsOn: [],
    });

    await gatekeeper.applyAction(1);

    expect(updates).toBe(0);
    expect(values.has("pending:action:1")).toBe(false);
    expect(values.has("gmail:draftWriteReceipt:1")).toBe(false);
  });

  it("marks an update draft deleted when receipt reconciliation finds a provider 404", async () => {
    const providerId = "provider-draft";
    const before: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId: "provider-message-1",
      threadId: "provider-thread",
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Before",
      rfcMessageId: "<discard-update@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after = {...before, text: "After", version: 1};
    const api = new GmailApi("me@example.com", async () => "token");
    const beforeRaw = api.buildOutbound({
      ...outboundSpec(before.rfcMessageId), subject: before.subject, text: before.text,
    }).raw;
    let wrote = false;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return wrote
          ? json({error: "missing"}, 404)
          : json({
              id: providerId,
              message: {
                id: "provider-message-1", threadId: "provider-thread", internalDate: "1", raw: beforeRaw,
              },
            });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        wrote = true;
        return json({id: providerId, message: {id: "provider-message-2"}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {
      type: "draftUpdate",
      draftId: providerId,
      after,
      expectedBefore: await gmailDraftStateFingerprint(before),
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/drafts\.get failed/);
    expect(values.has("gmail:draftWriteReceipt:1")).toBe(true);

    await gatekeeper.rejectAction(1);

    expect(values.has("pending:action:1")).toBe(false);
    expect(values.has("gmail:draftWriteReceipt:1")).toBe(false);
    expect(values.get(`gmail:draft:${providerId}`)).toMatchObject({status: "deleted"});
  });

  it("refuses to bless a different provider revision after draft creation", async () => {
    const logicalId = "provisional-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<edited-draft@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: "Externally edited",
    }).raw;
    let creates = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        creates++;
        return json({id: "provider-draft", message: {id: "provider-message-1"}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({
          id: "provider-draft",
          message: {
            id: "provider-message-2", threadId: "provider-thread", internalDate: "1", raw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);
    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/revision changed/);

    expect(creates).toBe(1);
    expect(values.has("pending:action:1")).toBe(true);
    expect(values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: "provider-draft", messageId: "provider-message-1",
    });

    await gatekeeper.rejectAction(1);

    expect(values.has("pending:action:1")).toBe(false);
    expect(values.has("gmail:draftWriteReceipt:1")).toBe(false);
    expect(values.get(`gmail:draft:${logicalId}`)).toMatchObject({
      logicalId, providerId: "provider-draft", status: "active",
    });
  });

  it("marks a created draft deleted when receipt reconciliation finds a provider 404", async () => {
    const logicalId = "provisional-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<deleted-create@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        return json({id: "provider-draft", message: {id: "provider-message"}});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts/provider-draft" && !init.method) {
        return json({error: "missing"}, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/http=404/);
    expect(values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: "provider-draft", messageId: "provider-message", missing: true,
    });

    await gatekeeper.rejectAction(1);

    expect(values.has("pending:action:1")).toBe(false);
    expect(values.has("gmail:draftWriteReceipt:1")).toBe(false);
    expect(values.get(`gmail:draft:${logicalId}`)).toMatchObject({status: "deleted"});
  });

  it("rolls back provider mapping when dependent rebasing validation fails", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<rollback-draft@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after: GmailDraftState = {...state, text: "After", version: 1};
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text + "\n",
    }).raw;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        return json({id: providerId, message: {id: "provider-message"}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 1,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("pending:action:2", {
      type: "draftUpdate",
      draftId: logicalId,
      after,
      expectedBefore: "not-the-create-output",
      dependsOn: [1],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/no longer matches/);

    expect(values.get(`gmail:draft:${logicalId}`)).toEqual({
      logicalId, createdAt: 1, status: "active", version: 1,
    });
    expect(values.has(`gmail:draft:${providerId}`)).toBe(false);
    expect(values.has("gmail:draftAlias:provider-draft")).toBe(false);
    expect(values.get("pending:action:1")).toEqual({type: "draftCreate", draft: state});
    expect(values.get("pending:action:2")).toEqual({
      type: "draftUpdate",
      draftId: logicalId,
      after,
      expectedBefore: "not-the-create-output",
      dependsOn: [1],
    });
    expect(values.get("gmail:draftWriteReceipt:1")).toEqual({
      draftId: providerId, messageId: "provider-message",
    });
    expect(values.has("gmail:decision:1")).toBe(false);
  });

  it("skips descendants invalidated by a rejected intermediate draft action", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Created",
      rfcMessageId: "<rejected-middle@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const firstUpdate = {...state, text: "First update", version: 1};
    const secondUpdate = {...state, text: "Second update", version: 2};
    const expectedSecondBase = await gmailDraftStateFingerprint(firstUpdate);
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId), subject: state.subject, text: state.text,
    }).raw;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && init.method === "POST") {
        return json({id: providerId, message: {id: "provider-message"}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: "provider-message", threadId: "provider-thread", internalDate: "1", raw,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 2,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("pending:action:2", {
      type: "draftUpdate",
      draftId: logicalId,
      after: firstUpdate,
      expectedBefore: await gmailDraftStateFingerprint(state),
      dependsOn: [1],
    });
    storage.kv.put("pending:action:3", {
      type: "draftUpdate",
      draftId: logicalId,
      after: secondUpdate,
      expectedBefore: expectedSecondBase,
      dependsOn: [1, 2],
    });

    await gatekeeper.rejectAction(2);
    await gatekeeper.applyAction(1);

    expect(values.get("pending:action:3")).toMatchObject({
      expectedBefore: expectedSecondBase,
      dependsOn: [1, 2],
    });
    await expect(gatekeeper.applyAction(3)).rejects.toThrow(/prerequisite was rejected/i);
  });

  it("merges a discovered provider alias and applies create, update, and delete in order", async () => {
    const logicalId = "provisional-draft";
    const providerId = "provider-draft";
    const rfcMessageId = "<draft@gadgets.invalid>";
    const state: GmailDraftState = {
      logicalId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Original",
      rfcMessageId,
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const after: GmailDraftState = {
      ...state,
      logicalId: providerId,
      text: "Approved update",
      version: 1,
    };
    const expectedBefore = await gmailDraftStateFingerprint(state);
    const expectedAfter = await gmailDraftStateFingerprint(after);
    let providerMessageId = "provider-message-1";
    let providerRaw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(rfcMessageId),
      from: "Mailbox Owner <me@example.com>",
      to: ["Provider Display <to@example.com>"],
      subject: state.subject,
      text: state.text,
    }).raw;
    const writes: string[] = [];
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/messages" && !init.method) {
        return json({messages: [{id: providerMessageId, threadId: "provider-thread"}]});
      }
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: providerId, message: {id: providerMessageId}}]});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return json({
          id: providerId,
          message: {
            id: providerMessageId,
            threadId: "provider-thread",
            internalDate: "1",
            raw: providerRaw,
          },
        });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "PUT") {
        writes.push("update");
        providerRaw = (JSON.parse(String(init.body)) as {message: {raw: string}}).message.raw;
        providerMessageId = "provider-message-2";
        return json({id: providerId, message: {id: providerMessageId}});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        writes.push("delete");
        return new Response(null, {status: 204});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${logicalId}`, {
      logicalId, createdAt: 1, status: "active", version: 2,
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {type: "draftCreate", draft: state});
    storage.kv.put("pending:action:2", {
      type: "draftUpdate",
      draftId: providerId,
      after,
      expectedBefore,
      expectedProviderMessageId: "provider-message-1",
      dependsOn: [],
    });
    storage.kv.put("pending:action:3", {
      type: "draftDelete",
      draftId: logicalId,
      expectedSnapshot: expectedAfter,
      dependsOn: [1],
    });
    storage.kv.put("gmail:applying:1", Date.now());

    await expect(gatekeeper.applyAction(2)).rejects.toThrow(/pending prerequisite/);
    expect(writes).toEqual([]);
    expect(values.get("gmail:draftAlias:provider-draft")).toBe(logicalId);
    expect(values.get("pending:action:2")).toMatchObject({draftId: logicalId, dependsOn: [1]});
    expect(values.get("pending:action:3")).toMatchObject({dependsOn: [1, 2]});

    await gatekeeper.applyAction(1);
    expect([...values.keys()].filter(key => key.startsWith("gmail:draft:"))).toEqual([
      `gmail:draft:${logicalId}`,
    ]);
    expect(values.get("gmail:draftAlias:provider-draft")).toBe(logicalId);
    expect(values.get("pending:action:2")).toMatchObject({draftId: logicalId, dependsOn: [1]});
    expect(values.get("pending:action:3")).toMatchObject({dependsOn: [1, 2]});

    await gatekeeper.applyAction(2);
    const approvedUpdate = await parseMimeMessage(providerRaw);
    expect(approvedUpdate.text).toContain("Approved update");
    expect(approvedUpdate.to?.[0]).toMatchObject({address: "to@example.com"});

    await gatekeeper.applyAction(3);
    expect(writes).toEqual(["update", "delete"]);
    expect(values.get(`gmail:draft:${logicalId}`)).toMatchObject({status: "deleted"});
    expect(values.has("pending:action:2")).toBe(false);
    expect(values.has("pending:action:3")).toBe(false);
  });

  it("keeps a failed pending delete hidden and restores the draft after rejection", async () => {
    const providerId = "provider-draft";
    const messageId = "provider-message";
    const threadId = "provider-thread";
    const state: GmailDraftState = {
      logicalId: providerId,
      providerId,
      messageId,
      threadId,
      from: "me@example.com",
      replyTo: [],
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      subject: "Subject",
      text: "Body",
      rfcMessageId: "<draft-delete@gadgets.invalid>",
      timestamp: 1,
      attachments: [],
      version: 0,
    };
    const raw = new GmailApi("me@example.com", async () => "token").buildOutbound({
      ...outboundSpec(state.rfcMessageId),
      subject: state.subject,
      text: state.text,
    }).raw;
    let deletes = 0;
    const {gatekeeper, storage, values} = actionHarness((url, init) => {
      if (url.pathname === "/gmail/v1/users/me/drafts" && !init.method) {
        return json({drafts: [{id: providerId, message: {id: messageId}}]});
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && !init.method) {
        return url.searchParams.get("format") === "full"
          ? json(draftFull(providerId, messageId, threadId, state))
          : json({
              id: providerId,
              message: {id: messageId, threadId, internalDate: "1", raw},
            });
      }
      if (url.pathname === `/gmail/v1/users/me/drafts/${providerId}` && init.method === "DELETE") {
        deletes++;
        return json({error: "failed"}, 500);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    storage.kv.put(`gmail:draft:${providerId}`, {
      logicalId: providerId, providerId, createdAt: 1, status: "active", version: 0,
    });
    storage.kv.put("pending:action:1", {
      type: "draftDelete",
      draftId: providerId,
      expectedSnapshot: await gmailDraftStateFingerprint(state),
      expectedProviderMessageId: messageId,
      dependsOn: [],
    });

    await expect(gatekeeper.applyAction(1)).rejects.toThrow(/Gmail API drafts\.delete failed/);
    expect(deletes).toBe(1);
    expect(values.has("pending:action:1")).toBe(true);

    const session = await gatekeeper.startSession(approvalQueue() as never);
    expect(await (await session.listDrafts()).next()).toBeNull();

    await gatekeeper.rejectAction(1);
    const restored = await (await session.listDrafts()).next();
    expect(restored).toHaveLength(1);
    expect(restored![0].info.id).toBe(providerId);
  });
});
