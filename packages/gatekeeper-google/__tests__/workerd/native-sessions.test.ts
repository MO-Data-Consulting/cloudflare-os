import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, HookController, HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  applyDriveCreation, DriveCreationStore, rejectDriveCreation, revertDriveCreation,
  type DriveCreationStorage,
} from "../../src/drive-creation";
import type { DriveBindingScope } from "../../src/drive-session";
import type {
  DriveCreationHandle, GoogleDriveReadSession, GoogleDriveSession,
} from "../../src/drive-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi } from "../../src/docs-api";
import { DriveApi } from "../../src/drive-api";
import { applyDriveDocEdit, GoogleDriveSessionImpl, rejectDriveDocEdit } from "../../src/google";
import { GoogleSheetsApi } from "../../src/sheets-api";

const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";
let providerUrls: string[];
let createdFiles: Map<string, Record<string, unknown>>;
let docsState: Map<string, { text: string; revision: number; namedRanges: Set<string> }>;
let docsMutationCount: number;
let loseNextDocsResponse: boolean;

async function getAccessToken(): Promise<string> {
  return "access-token";
}

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];
  readonly actions: { id: number; description: ActionDescription }[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.actions.push({ id: action, description });
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

function providerFile(
  id: string, mimeType: string, overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: id === "doc-1" ? "Quarterly plan" : "Forecast",
    mimeType,
    modifiedTime: "2026-08-20T12:00:00Z",
    trashed: false,
    ...overrides,
  };
}

function providerDocument(
  documentId: string, state: { text: string; revision: number; namedRanges: Set<string> },
) {
  let index = 1;
  const content = state.text ? state.text.split("\n\n").map(text => {
    const startIndex = index;
    const paragraphText = `${text}\n`;
    index += paragraphText.length;
    return {
      startIndex, endIndex: index,
      paragraph: {
        paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
        elements: [{
          startIndex, endIndex: index,
          textRun: { content: paragraphText, textStyle: {} },
        }],
      },
    };
  }) : [];
  return {
    documentId, title: createdFiles.get(documentId)?.name ?? "Quarterly plan",
    revisionId: `revision-${state.revision}`,
    tabs: [{
      documentTab: {
        body: { content }, lists: {},
        namedRanges: Object.fromEntries([...state.namedRanges].map(name => [name, {}])),
      },
      childTabs: [],
    }],
  };
}

function installProvider() {
  const urls: string[] = [];
  createdFiles = new Map();
  docsState = new Map([["doc-1", { text: "", revision: 1, namedRanges: new Set() }]]);
  docsMutationCount = 0;
  loseNextDocsResponse = false;
  vi.stubGlobal("fetch", vi.fn(async (
    input: string | URL | Request, init?: RequestInit,
  ) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    urls.push(url.toString());
    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/drive/v3/files")) {
      if (request.method === "GET") return Response.json({ files: [] });
      if (request.method === "POST") {
        const body = await request.json() as {
          name: string; mimeType: string; parents: string[];
          appProperties: { gadgetsCreationRequestId: string };
        };
        const created = providerFile(`created-${createdFiles.size + 1}`, body.mimeType, {
          name: body.name,
          parents: body.parents,
          appProperties: body.appProperties,
          capabilities: { canTrash: true },
          ...(body.parents[0] === "shared-1" ? { driveId: "shared-1" } : {}),
        });
        createdFiles.set(created.id, created);
        if (body.mimeType === DOC_MIME) {
          docsState.set(created.id, { text: "", revision: 1, namedRanges: new Set() });
        }
        return Response.json(created);
      }
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.includes("/drive/v3/files/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (request.method === "PATCH") {
        const current = createdFiles.get(id);
        if (!current) throw new Error(`Unknown created file: ${id}`);
        const trashed = { ...current, trashed: true };
        createdFiles.set(id, trashed);
        return Response.json(trashed);
      }
      const created = createdFiles.get(id);
      if (created) return Response.json(created);
      if (id === "root") {
        return Response.json(providerFile(id, FOLDER_MIME, {
          name: "My Drive", capabilities: { canAddChildren: true },
        }));
      }
      if (id === "shared-1") {
        return Response.json(providerFile(id, FOLDER_MIME, {
          name: "Team Drive", driveId: id, capabilities: { canAddChildren: true },
        }));
      }
      const mimeType = id === "doc-1" ? DOC_MIME : SHEET_MIME;
      return Response.json(providerFile(id, mimeType));
    }
    if (url.hostname === "docs.googleapis.com") {
      const documentId = decodeURIComponent(url.pathname.split("/").at(-1)!.split(":")[0]);
      const state = docsState.get(documentId);
      if (!state) throw new Error(`Unknown Docs document: ${documentId}`);
      if (request.method === "POST") {
        const body = await request.json() as { requests: Record<string, any>[] };
        for (const operation of body.requests) {
          if (operation.createNamedRange) {
            state.namedRanges.add(operation.createNamedRange.name);
          } else if (operation.deleteContentRange) {
            const { startIndex, endIndex } = operation.deleteContentRange.range;
            state.text = state.text.slice(0, startIndex - 1) + state.text.slice(endIndex - 1);
          } else if (operation.insertText) {
            const at = Math.max(0, operation.insertText.location.index - 1);
            let text = operation.insertText.text as string;
            if (!state.text && !at) text = text.replace(/^\n/, "");
            state.text = state.text.slice(0, at) + text + state.text.slice(at);
          }
        }
        state.revision++;
        docsMutationCount++;
        if (loseNextDocsResponse) {
          loseNextDocsResponse = false;
          throw new Error("Docs response was lost after a successful write");
        }
        return Response.json({ writeControl: { requiredRevisionId: `revision-${state.revision}` } });
      }
      return Response.json(providerDocument(documentId, state));
    }
    throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
  }));
  return urls;
}

class TestStorage implements DriveCreationStorage {
  entries = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.entries.get(key) as T | undefined;
  }

  put<T>(key: string, value: T): void {
    this.entries.set(key, value);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  list<T>({ prefix }: { prefix: string }): Iterable<[string, T]> {
    return [...this.entries]
      .filter(([key]) => key.startsWith(prefix)) as [string, T][];
  }
}

function newSession(
  scope: DriveBindingScope = { kind: "account" },
  storage = new TestStorage(),
) {
  const queue = new TestApprovalQueue();
  const queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  const driveApi = new DriveApi(getAccessToken);
  const session = new RpcStub(new GoogleDriveSessionImpl(
    driveApi,
    new GoogleDocsApi(getAccessToken),
    new GoogleSheetsApi(getAccessToken),
    scope,
    storage,
    queueStub,
    async fileIds => ({ pendingSets: fileIds, commit() {} }),
    () => [],
  ));
  return { driveApi, queue, session, storage };
}

beforeEach(() => {
  providerUrls = installProvider();
});
afterEach(() => vi.unstubAllGlobals());

describe("Drive nested native sessions", () => {
  it("pipelines a Doc call before resolving its disposable child stub", async () => {
    using session = newSession().session;

    const docPromise = session.openGoogleDoc("doc-1");
    const metadataPromise = docPromise.getMetadata();
    using doc = await docPromise;

    expect(await metadataPromise).toEqual({
      title: "Quarterly plan",
      lastModified: new Date("2026-08-20T12:00:00Z"),
    });
    expect(await doc.getContent()).toBe("");
  });

  it("returns the existing Sheet target with bounded range validation", async () => {
    using session = newSession().session;
    using sheet = await session.openGoogleSheet("sheet-1");

    await expect(Promise.resolve(sheet.readRange("A:A")))
      .rejects.toThrow(/Invalid or unbounded A1 range/);
    expect(providerUrls.some(url => new URL(url).hostname === "sheets.googleapis.com"))
      .toBe(false);
  });

  it("gives each child an independently disposable approval-queue stub", async () => {
    const { queue, session } = newSession();
    try {
      const doc = await session.openGoogleDoc("doc-1");
      try {
        session[Symbol.dispose]();
        await expect(doc.getMetadata()).resolves.toEqual(expect.objectContaining({
          title: "Quarterly plan",
        }));
        expect(queue.observations).toHaveLength(2);

        doc[Symbol.dispose]();
        await expect(Promise.resolve(doc.getContent())).rejects.toThrow();
      } finally {
        doc[Symbol.dispose]();
      }
    } finally {
      session[Symbol.dispose]();
    }
  });
});

describe("Drive creation RPC", () => {
  it("authorizes a local pending result without provider access", async () => {
    const { queue, session } = newSession();
    const handle = await session.createGoogleDoc({ name: "Quarterly plan" });
    queue.observations.splice(0);
    providerUrls.splice(0);

    await expect(session.getCreationResult(handle)).resolves.toEqual({ status: "pending" });
    expect(providerUrls).toEqual([]);
    expect(queue.observations).toEqual([{
      title: "Read Google Drive creation result",
      description: "Read the current outcome of a Google Drive creation request.",
    }]);
    session[Symbol.dispose]();
  });

  it("reopens a pending Doc handle across callbacks and replays simulated edits", async () => {
    const storage = new TestStorage();
    const callbackA = newSession({ kind: "account" }, storage);
    const handle = await callbackA.session.createGoogleDoc({ name: "Quarterly plan" });
    const docPromise = callbackA.session.openCreatedGoogleDoc(handle);
    const initialAppend = docPromise.appendText("Initial paragraph.");
    const docA = await docPromise;

    await initialAppend;
    expect(await docA.getContent()).toBe("Initial paragraph.");
    expect(callbackA.queue.actions.map(({ description }) => description)).toEqual([
      expect.objectContaining({
        actionKind: { tag: "createGoogleDoc", label: "Google Doc creation" },
        autoApprovable: true,
      }),
      expect.objectContaining({
        actionKind: { tag: "editDocument", label: "Document edits" },
        autoApprovable: true,
      }),
    ]);
    expect(callbackA.queue.actions.every(({ description }) => !("awaitDecision" in description)))
      .toBe(true);
    expect(providerUrls.some(url => new URL(url).hostname === "docs.googleapis.com")).toBe(false);
    docA[Symbol.dispose]();
    callbackA.session[Symbol.dispose]();

    const serializedHandle = structuredClone(handle);
    const callbackB = newSession({ kind: "account" }, storage);
    const docB = await callbackB.session.openCreatedGoogleDoc(serializedHandle);
    await docB.replaceText("Initial paragraph.", "Revised paragraph.");
    await docB.appendText("\n\nFinal paragraph.");

    expect(await docB.getContent()).toBe(
      "Revised paragraph.\n\nFinal paragraph.",
    );
    expect(callbackB.queue.actions.map(({ id, description }) => ({
      id, tag: description.actionKind?.tag, awaitDecision: "awaitDecision" in description,
    }))).toEqual([
      { id: 3, tag: "editDocument", awaitDecision: false },
      { id: 4, tag: "editDocument", awaitDecision: false },
    ]);
    expect(providerUrls.some(url => new URL(url).hostname === "docs.googleapis.com")).toBe(false);
    docB[Symbol.dispose]();
    callbackB.session[Symbol.dispose]();

    const runtime = {
      storage, driveApi: callbackB.driveApi, docsApi: new GoogleDocsApi(getAccessToken),
      scope: { kind: "account" } as const,
    };
    await applyDriveCreation(
      { storage, api: callbackB.driveApi, scope: runtime.scope }, handle.id,
    );
    const latestPendingEdit = Math.max(...new DriveCreationStore(storage)
      .listDocEdits(handle.id).map(({ action }) => action.submittedAt));
    const applied = newSession({ kind: "account" }, storage);
    const pendingDoc = await applied.session.openCreatedGoogleDoc(serializedHandle);
    await expect(pendingDoc.getMetadata()).resolves.toEqual({
      title: "Quarterly plan", lastModified: new Date(latestPendingEdit),
    });
    pendingDoc[Symbol.dispose]();
    applied.session[Symbol.dispose]();
    loseNextDocsResponse = true;
    await expect(applyDriveDocEdit(runtime, 2)).rejects.toThrow(/response was lost/);
    await applyDriveDocEdit(runtime, 2);
    await applyDriveDocEdit(runtime, 2);
    await applyDriveDocEdit(runtime, 3);
    await applyDriveDocEdit(runtime, 4);

    const callbackC = newSession({ kind: "account" }, storage);
    const docC = await callbackC.session.openCreatedGoogleDoc(serializedHandle);
    await expect(docC.getMetadata()).resolves.toEqual({
      title: "Quarterly plan", lastModified: new Date("2026-08-20T12:00:00Z"),
    });
    await expect(docC.getContent()).resolves.toBe(
      "Revised paragraph.\n\nFinal paragraph.",
    );
    expect(callbackC.queue.observations).toContainEqual({
      title: "Read app-created Google Doc content",
      description: "Read the current document body as Markdown.",
    });
    expect(docsMutationCount).toBe(3);
    expect([...docsState.get("created-1")!.namedRanges]).toHaveLength(3);
    expect(new DriveCreationStore(storage).pendingCount()).toBe(0);
    docC[Symbol.dispose]();
    callbackC.session[Symbol.dispose]();
  });

  it("rejects non-Doc and terminal creation handles without provider Docs access", async () => {
    const rejected = newSession();
    const rejectedHandle = await rejected.session.createGoogleDoc({ name: "Rejected" });
    await rejectDriveCreation(
      { storage: rejected.storage, api: rejected.driveApi, scope: { kind: "account" } },
      rejectedHandle.id,
    );
    await expect(Promise.resolve(rejected.session.openCreatedGoogleDoc(rejectedHandle)))
      .rejects.toThrow(/rejected/);
    rejected.session[Symbol.dispose]();

    const reverted = newSession();
    const revertedHandle = await reverted.session.createGoogleDoc({ name: "Reverted" });
    const revertedRuntime = {
      storage: reverted.storage, api: reverted.driveApi, scope: { kind: "account" } as const,
    };
    await applyDriveCreation(revertedRuntime, revertedHandle.id);
    await revertDriveCreation(revertedRuntime, revertedHandle.id);
    await expect(Promise.resolve(reverted.session.openCreatedGoogleDoc(revertedHandle)))
      .rejects.toThrow(/reverted/);
    reverted.session[Symbol.dispose]();

    const sheet = newSession();
    const sheetHandle = await sheet.session.createGoogleSheet({ name: "Forecast" });
    const forgedDocHandle: DriveCreationHandle<"googleDoc"> = {
      ...sheetHandle, kind: "googleDoc",
    };
    providerUrls.splice(0);
    await expect(Promise.resolve(sheet.session.openCreatedGoogleDoc(forgedDocHandle)))
      .rejects.toThrow(/Google Doc/);
    expect(providerUrls).toEqual([]);
    sheet.session[Symbol.dispose]();
  });

  it("refuses an edit callback until its creation has been applied", async () => {
    const callback = newSession();
    const handle = await callback.session.createGoogleDoc({ name: "Quarterly plan" });
    const doc = await callback.session.openCreatedGoogleDoc(handle);
    await doc.appendText("Draft");
    providerUrls.splice(0);

    await expect(applyDriveDocEdit({
      storage: callback.storage, driveApi: callback.driveApi,
      docsApi: new GoogleDocsApi(getAccessToken), scope: { kind: "account" },
    }, 2)).rejects.toThrow(/creation.*first/i);
    expect(providerUrls).toEqual([]);
    doc[Symbol.dispose]();
    callback.session[Symbol.dispose]();
  });

  it("rebuilds provisional simulation after an edit is rejected", async () => {
    const callback = newSession();
    const handle = await callback.session.createGoogleDoc({ name: "Quarterly plan" });
    const doc = await callback.session.openCreatedGoogleDoc(handle);
    await doc.appendText("Draft");
    await doc.replaceText("Draft", "Revised");
    const store = new DriveCreationStore(callback.storage);
    const creation = store.getAction(handle.id)!;
    store.putDocEdit(3, { ...store.getDocEdit(3)!, submittedAt: creation.submittedAt + 10_000 });
    providerUrls.splice(0);

    await expect(rejectDriveDocEdit({
      storage: callback.storage,
      driveApi: callback.driveApi,
      docsApi: new GoogleDocsApi(getAccessToken),
      scope: { kind: "account" },
    }, 2)).resolves.toBe(true);
    await expect(rejectDriveDocEdit({
      storage: callback.storage,
      driveApi: callback.driveApi,
      docsApi: new GoogleDocsApi(getAccessToken),
      scope: { kind: "account" },
    }, 2)).resolves.toBe(false);

    expect(await doc.getContent()).toBe("");
    await expect(doc.getMetadata()).resolves.toEqual({
      title: "Quarterly plan", lastModified: new Date(creation.submittedAt),
    });
    expect(store.getDocEdit(3)?.invalidatedReason).toMatch(/could not be replayed/i);
    expect(providerUrls).toEqual([]);
    doc[Symbol.dispose]();
    callback.session[Symbol.dispose]();
  });

  it("authorizes before rejecting changed created-Doc properties", async () => {
    const callback = newSession();
    const handle = await callback.session.createGoogleDoc({ name: "Quarterly plan" });
    await applyDriveCreation(
      { storage: callback.storage, api: callback.driveApi, scope: { kind: "account" } },
      handle.id,
    );
    const original = createdFiles.get("created-1")!;
    const variants = [
      { label: "marker", override: { appProperties: { gadgetsCreationRequestId: "wrong" } } },
      { label: "MIME type", override: { mimeType: SHEET_MIME } },
      { label: "trash state", override: { trashed: true } },
    ];

    for (const { label, override } of variants) {
      createdFiles.set("created-1", { ...original, ...override });
      callback.queue.observations.splice(0);
      providerUrls.splice(0);
      const doc = await callback.session.openCreatedGoogleDoc(handle);
      await expect(Promise.resolve(doc.getContent()), label).rejects.toThrow();
      expect(callback.queue.observations, label).toHaveLength(1);
      expect(providerUrls.some(url => new URL(url).hostname === "docs.googleapis.com"), label)
        .toBe(false);
      doc[Symbol.dispose]();
    }

    createdFiles.set("created-1", { ...original, id: "returned-another-id" });
    callback.queue.observations.splice(0);
    const wrongId = await callback.session.openCreatedGoogleDoc(handle);
    await expect(Promise.resolve(wrongId.getContent()))
      .rejects.toThrow(/outside this Drive binding/);
    expect(callback.queue.observations).toEqual([]);
    wrongId[Symbol.dispose]();
    callback.session[Symbol.dispose]();
  });

  it("refuses a created Doc that moved outside its shared drive", async () => {
    const callback = newSession({ kind: "sharedDrive", driveId: "shared-1" });
    const handle = await callback.session.createGoogleDoc({ name: "Quarterly plan" });
    const runtime = {
      storage: callback.storage, api: callback.driveApi,
      scope: { kind: "sharedDrive", driveId: "shared-1" } as const,
    };
    await applyDriveCreation(runtime, handle.id);
    const created = createdFiles.get("created-1")!;
    createdFiles.set("created-1", { ...created, driveId: "other-drive" });
    callback.queue.observations.splice(0);

    const doc = await callback.session.openCreatedGoogleDoc(handle);
    await expect(Promise.resolve(doc.getContent()))
      .rejects.toThrow(/outside this Drive binding/);
    expect(callback.queue.observations).toEqual([]);
    doc[Symbol.dispose]();
    callback.session[Symbol.dispose]();
  });

  it("round-trips handles and authoritative created outcomes through a real RPC stub", async () => {
    const { driveApi, queue, session, storage } = newSession();
    const rpc = session;

    const doc = await rpc.createGoogleDoc({ name: "Quarterly plan" });
    const sheet = await rpc.createGoogleSheet({ name: "Forecast" });
    const folder = await rpc.createFolder({ name: "Planning" });

    expect([doc, sheet, folder]).toEqual([
      { id: 1, kind: "googleDoc", name: "Quarterly plan" },
      { id: 2, kind: "googleSheet", name: "Forecast" },
      { id: 3, kind: "folder", name: "Planning" },
    ]);
    expect(queue.actions[0]?.description).toEqual(expect.objectContaining({
      implementsRevert: true,
      actionKind: { tag: "createGoogleDoc", label: "Google Doc creation" },
      autoApprovable: true,
    }));
    expect("awaitDecision" in queue.actions[0]!.description).toBe(false);
    expect(queue.actions.slice(1).map(({ description }) => description)).toEqual(
      Array(2).fill(expect.objectContaining({
        implementsRevert: true, awaitDecision: true,
      })),
    );
    expect(queue.actions.slice(1).every(({ description }) => !("actionKind" in description)))
      .toBe(true);

    await applyDriveCreation(
      { storage, api: driveApi, scope: { kind: "account" } }, doc.id,
    );
    providerUrls.splice(0);
    const tampered = { ...doc, kind: "folder", name: "Forged" } as DriveCreationHandle;

    await expect(rpc.getCreationResult(tampered)).resolves.toEqual({
      status: "created",
      kind: "googleDoc",
      entry: expect.objectContaining({
        id: "created-1", name: "Quarterly plan", mimeType: DOC_MIME,
      }),
    });
    expect(providerUrls.some(url => url.includes("/drive/v3/files/created-1"))).toBe(true);
    rpc[Symbol.dispose]();
  });

  it("denies a cast file-scoped creation before provider access or action submission", async () => {
    const { queue, session, storage } = newSession({ kind: "file", fileId: "doc-1" });
    const readSession: GoogleDriveReadSession = session;
    const bypass = readSession as unknown as GoogleDriveSession;
    providerUrls.splice(0);

    await expect(Promise.resolve(bypass.createFolder({ name: "Not allowed" })))
      .rejects.toThrow(/outside this Drive binding/);
    expect(providerUrls).toEqual([]);
    expect(queue.actions).toEqual([]);
    expect(new DriveCreationStore(storage).pendingCount()).toBe(0);
    session[Symbol.dispose]();
  });
});
