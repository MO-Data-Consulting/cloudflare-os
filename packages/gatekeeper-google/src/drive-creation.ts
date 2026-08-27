import type { ActionKind, ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { formatApprovalField, sanitizeApprovalTitle } from "./approval-format";
import { hasDriveCreationMarker, type DriveApi, type DriveFile } from "./drive-api";
import {
  isDriveFileInScope, validateDriveCreationParent,
  type DriveBindingScope, type DriveCreationParent,
} from "./drive-session";
import type { DriveCreationHandle, DriveCreationKind } from "./drive-types";
import { PendingActionStore, type PendingActionStorage } from "./pending-action-store";
import { obsContext } from "./observability";

const OUTCOME_PREFIX = "drive:action:outcome:";
const NEXT_OUTCOME_SEQUENCE_KEY = "drive:action:nextOutcomeSequence";
const MAX_PENDING_CREATIONS = 100;
const MAX_TERMINAL_OUTCOMES = 100;

const MIME_TYPE_BY_KIND: Record<DriveCreationKind, string> = {
  googleDoc: "application/vnd.google-apps.document",
  googleSheet: "application/vnd.google-apps.spreadsheet",
  folder: "application/vnd.google-apps.folder",
};

const KIND_LABEL: Record<DriveCreationKind, string> = {
  googleDoc: "Google Doc",
  googleSheet: "Google Sheet",
  folder: "folder",
};

/** Auto-approval kind for creating one blank native Google Doc. */
export const CREATE_GOOGLE_DOC_ACTION: ActionKind = {
  tag: "createGoogleDoc",
  label: "Google Doc creation",
};

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive-creation", vendorId: "google",
});

/** Synchronous Durable Object KV operations used by Drive creation state. */
export type DriveCreationStorage = PendingActionStorage;

/** Narrow provider surface used by creation callbacks. */
export type DriveCreationApi = Pick<
  DriveApi, "getFile" | "findFileByCreationRequestId" | "createFile" | "trashFile"
>;

/** Authoritative request persisted until the approval callback reaches a terminal state. */
export type DriveCreationAction = {
  actionType: "create";
  kind: DriveCreationKind;
  name: string;
  parentId: string;
  parentAuthority: DriveCreationParent["authority"];
  requestId: string;
  submittedAt: number;
};

/** Markdown mutation queued against one logical Drive-created Google Doc. */
export type DriveDocEditPayload =
  | { type: "replaceText"; oldMarkdown: string; newMarkdown: string }
  | { type: "appendText"; markdown: string };

/** Drive-only pending Doc edit stored in the binding-wide approval sequence. */
export type DriveDocEditAction = {
  actionType: "docEdit";
  driveCreationId: number;
  submittedAt: number;
  edit: DriveDocEditPayload;
  writeId: string;
  invalidatedReason?: string;
};

/** Every Drive action sharing one binding-local approval sequence. */
export type DriveAction = DriveCreationAction | DriveDocEditAction;

/** Persisted callback outcome; provider metadata is intentionally represented only by file ID. */
export type StoredDriveCreationOutcome =
  | { status: "applying"; createdFileId?: string }
  | { status: "rejected" }
  | { status: "failed"; message: string; createdFileId?: string }
  | {
      status: "created"; kind: DriveCreationKind; fileId: string; requestId: string;
    }
  | { status: "reverted" };

/** Current authoritative state before created metadata is freshly observed. */
export type StoredDriveCreationState =
  | { status: "pending"; lastError?: string }
  | { status: "rejected" }
  | { status: "created"; kind: DriveCreationKind; fileId: string }
  | { status: "reverted" };

type StoredDocEditReceipt = { actionType: "docEdit" };

type StoredOutcomeRecord = {
  sequence: number;
  outcome: StoredDriveCreationOutcome | StoredDocEditReceipt;
};

/** Durable mixed-action storage with bounded receipts and persistent created-Doc identities. */
export class DriveCreationStore {
  #actions: PendingActionStore<DriveAction>;

  constructor(private storage: DriveCreationStorage) {
    this.#actions = new PendingActionStore(storage);
  }

  submit(action: DriveCreationAction): number {
    return this.#actions.submit(action);
  }

  submitDocEdit(action: DriveDocEditAction): number {
    return this.#actions.submit(action);
  }

  pendingCount(): number {
    return this.#actions.list().filter(({ action }) => action.actionType === "create").length;
  }

  getDriveAction(id: number): DriveAction | undefined {
    return this.#actions.get(id);
  }

  getAction(id: number): DriveCreationAction | undefined {
    const action = this.#actions.get(id);
    return action?.actionType === "create" ? action : undefined;
  }

  getDocEdit(id: number): DriveDocEditAction | undefined {
    const action = this.#actions.get(id);
    return action?.actionType === "docEdit" ? action : undefined;
  }

  isDocEdit(id: number): boolean {
    const outcome = this.#storedOutcome(id);
    return this.getDocEdit(id) !== undefined ||
      (outcome !== undefined && "actionType" in outcome);
  }

  listDocEdits(driveCreationId: number): { id: number; action: DriveDocEditAction }[] {
    return this.#actions.list().flatMap(({ id, action }) =>
      action.actionType === "docEdit" && action.driveCreationId === driveCreationId
        ? [{ id, action }]
        : []);
  }

  invalidateDocEdits(driveCreationId: number, reason: string): void {
    for (const { id, action } of this.listDocEdits(driveCreationId)) {
      if (!action.invalidatedReason) this.putDocEdit(id, { ...action, invalidatedReason: reason });
    }
  }

  docEdits(driveCreationId: number): DriveDocEditStore {
    return new DriveDocEditStore(this, driveCreationId);
  }

  putDocEdit(id: number, action: DriveDocEditAction): void {
    this.#actions.put(id, action);
  }

  removeAction(id: number): void {
    this.#actions.remove(id);
  }

  getOutcome(id: number): StoredDriveCreationOutcome | undefined {
    const outcome = this.#storedOutcome(id);
    return outcome && !("actionType" in outcome) ? outcome : undefined;
  }

  putApplying(id: number, createdFileId?: string): void {
    this.#putOutcome(id, {
      status: "applying", ...(createdFileId ? { createdFileId } : {}),
    });
  }

  putFailure(id: number, message: string, createdFileId?: string): void {
    this.#putOutcome(id, {
      status: "failed", message, ...(createdFileId ? { createdFileId } : {}),
    });
  }

  finish(id: number, outcome: Exclude<StoredDriveCreationOutcome, { status: "failed" }>): void {
    this.#putOutcome(id, outcome);
    this.removeAction(id);
    this.#pruneTerminalOutcomes();
  }

  finishDocEdit(id: number): void {
    this.#putOutcome(id, { actionType: "docEdit" });
    this.removeAction(id);
    this.#pruneTerminalOutcomes();
  }

  cleanupTerminal(id: number): void {
    this.removeAction(id);
    this.#pruneTerminalOutcomes();
  }

  #outcomeKey(id: number): string {
    return `${OUTCOME_PREFIX}${id}`;
  }

  #storedOutcome(id: number): StoredOutcomeRecord["outcome"] | undefined {
    return this.storage.get<StoredOutcomeRecord>(this.#outcomeKey(id))?.outcome;
  }

  #putOutcome(id: number, outcome: StoredOutcomeRecord["outcome"]): void {
    let sequence = this.storage.get<number>(NEXT_OUTCOME_SEQUENCE_KEY) ?? 1;
    this.storage.put(NEXT_OUTCOME_SEQUENCE_KEY, sequence + 1);
    this.storage.put(this.#outcomeKey(id), { sequence, outcome } satisfies StoredOutcomeRecord);
  }

  #pruneTerminalOutcomes(): void {
    const retainedCreationIds = new Set(this.#actions.list().map(({ id, action }) =>
      action.actionType === "create" ? id : action.driveCreationId));
    let prunable = [...this.storage.list<StoredOutcomeRecord>({ prefix: OUTCOME_PREFIX })]
      .map(([key, { sequence, outcome }]) => ({
        id: Number(key.slice(OUTCOME_PREFIX.length)), key, sequence, outcome,
      }))
      .filter(({ id, outcome }) => {
        if (!Number.isFinite(id) || retainedCreationIds.has(id)) return false;
        return "actionType" in outcome ||
          outcome.status !== "created" || outcome.kind !== "googleDoc";
      })
      .toSorted((a, b) => a.sequence - b.sequence);
    for (let record of prunable.slice(0, -MAX_TERMINAL_OUTCOMES)) {
      this.storage.delete(record.key);
    }
  }
}

/** Pending-action adapter restricted to one logical Drive-created Doc. */
export class DriveDocEditStore {
  constructor(
    private store: DriveCreationStore,
    private driveCreationId: number,
  ) {}

  get(id: number): DriveDocEditAction | undefined {
    const action = this.store.getDocEdit(id);
    return action?.driveCreationId === this.driveCreationId ? action : undefined;
  }

  list(): { id: number; action: DriveDocEditAction }[] {
    return this.store.listDocEdits(this.driveCreationId);
  }

  put(id: number, action: DriveDocEditAction): void {
    if (action.driveCreationId !== this.driveCreationId || !this.get(id)) {
      throw new Error(`Unknown pending Google Drive Doc edit: ${id}`);
    }
    this.store.putDocEdit(id, action);
  }

  remove(id: number): void {
    if (this.get(id)) this.store.removeAction(id);
  }
}

/** Reject empty names before any provider lookup. */
export function validateDriveCreationName(name: string): void {
  if (!name.trim()) throw new Error("Google Drive creation name must not be empty");
}

/** Reject submissions before provider lookup once the binding has 100 unresolved creates. */
export function assertDriveCreationCapacity(storage: DriveCreationStorage): void {
  if (new DriveCreationStore(storage).pendingCount() >= MAX_PENDING_CREATIONS) {
    throw new Error(
      "Too many pending Google Drive creations. Resolve existing actions before adding more.",
    );
  }
}

/** Persist one request and submit its manual approval description. */
export async function submitDriveCreation<Kind extends DriveCreationKind>(options: {
  storage: DriveCreationStorage;
  approvalQueue: Pick<ApprovalQueue, "submitAction">;
  kind: Kind;
  name: string;
  parent: DriveCreationParent;
  requestId?: string;
}): Promise<DriveCreationHandle<Kind>> {
  validateDriveCreationName(options.name);
  assertDriveCreationCapacity(options.storage);
  let action: DriveCreationAction = {
    actionType: "create",
    kind: options.kind,
    name: options.name,
    parentId: options.parent.id,
    parentAuthority: options.parent.authority,
    requestId: options.requestId ?? crypto.randomUUID(),
    submittedAt: Date.now(),
  };
  let store = new DriveCreationStore(options.storage);
  let id = store.submit(action);
  try {
    await options.approvalQueue.submitAction(id, {
      title: sanitizeApprovalTitle(`Create ${KIND_LABEL[action.kind]}: ${action.name}`),
      description: [
        `Create a blank ${KIND_LABEL[action.kind]} in Google Drive. ` +
          "The new item inherits the destination folder's permissions.",
        formatApprovalField("Name", action.name),
        formatApprovalField("Destination folder", options.parent.name),
        formatApprovalField("Destination folder ID", options.parent.id),
      ].join("\n\n"),
      implementsRevert: true,
      ...(action.kind === "googleDoc"
        ? { actionKind: CREATE_GOOGLE_DOC_ACTION, autoApprovable: true }
        : { awaitDecision: true }),
    });
  } catch (error) {
    store.removeAction(id);
    throw error;
  }
  return { id, kind: options.kind, name: action.name };
}

/** Provider and durable state required by Drive creation callbacks. */
export type DriveCreationRuntime = {
  storage: DriveCreationStorage;
  api: DriveCreationApi;
  scope: DriveBindingScope;
};

/** Read persisted state by authoritative numeric action ID. */
export function readDriveCreationState(
  storage: DriveCreationStorage, actionId: number,
): StoredDriveCreationState {
  let store = new DriveCreationStore(storage);
  let outcome = store.getOutcome(actionId);
  if (outcome?.status === "failed") {
    return { status: "pending", lastError: outcome.message };
  }
  if (outcome?.status === "applying") return { status: "pending" };
  if (outcome?.status === "created") {
    return { status: "created", kind: outcome.kind, fileId: outcome.fileId };
  }
  if (outcome) return outcome;
  if (store.getAction(actionId)) return { status: "pending" };
  throw new Error(`Unknown Google Drive creation action: ${actionId}`);
}

/** Apply or idempotently recover one approved creation. */
export async function applyDriveCreation(
  runtime: DriveCreationRuntime, actionId: number,
): Promise<void> {
  if (runtime.scope.kind === "file") {
    throw new Error("The requested file is outside this Drive binding.");
  }
  let store = new DriveCreationStore(runtime.storage);
  let outcome = store.getOutcome(actionId);
  if (outcome && outcome.status !== "failed" && outcome.status !== "applying") {
    store.cleanupTerminal(actionId);
    return;
  }
  let action = store.getAction(actionId);
  if (!action) throw new Error(`Unknown pending Google Drive creation action: ${actionId}`);
  let recoverableCreatedFileId = outcome?.status === "failed" || outcome?.status === "applying"
    ? outcome.createdFileId
    : undefined;
  store.putApplying(actionId, recoverableCreatedFileId);

  let created: DriveFile;
  try {
    let parent = await runtime.api.getFile(action.parentId);
    if (parent.id !== action.parentId) {
      throw new Error("The requested file is outside this Drive binding.");
    }
    validateDriveCreationParent(runtime.scope, parent, action.parentAuthority);
    if (recoverableCreatedFileId) {
      created = await runtime.api.getFile(recoverableCreatedFileId);
      assertCreatedFileIdentity(action, created, recoverableCreatedFileId);
    } else {
      created = await runtime.api.findFileByCreationRequestId(action.requestId) ??
        await runtime.api.createFile({
          name: action.name,
          mimeType: MIME_TYPE_BY_KIND[action.kind],
          parentId: action.parentId,
          requestId: action.requestId,
        });
      assertCreatedFileIdentity(action, created);
      recoverableCreatedFileId = created.id;
    }
    validateCreatedFile(runtime.scope, action, created);
  } catch (error) {
    store.putFailure(actionId, failureMessage(error), recoverableCreatedFileId);
    logger.warn("Drive creation action failed", {
      event: "drive.creation.apply.failed", actionId, operation: "apply", error,
    });
    throw error;
  }

  store.finish(actionId, {
    status: "created", kind: action.kind, fileId: created.id, requestId: action.requestId,
  });
}

/** Serialize callbacks for each action while retaining crash recovery in durable state. */
export class DriveCreationCoordinator {
  #inFlight = new Map<number, Promise<unknown>>();

  /** Apply one approved creation after any earlier callback for the same action. */
  apply(runtime: DriveCreationRuntime, actionId: number): Promise<void> {
    return this.run(actionId, () => applyDriveCreation(runtime, actionId));
  }

  /** Reject one creation after any earlier callback for the same action. */
  reject(runtime: DriveCreationRuntime, actionId: number): Promise<boolean> {
    return this.run(actionId, () => rejectDriveCreation(runtime, actionId));
  }

  /** Revert one creation after any earlier callback for the same action. */
  revert(runtime: DriveCreationRuntime, actionId: number): Promise<boolean> {
    return this.run(actionId, () => revertDriveCreation(runtime, actionId));
  }

  /** Serialize any lifecycle callback after an earlier callback for the same action ID. */
  run<T>(actionId: number, operation: () => Promise<T>): Promise<T> {
    let previous = this.#inFlight.get(actionId) ?? Promise.resolve();
    let current = previous.catch(() => {}).then(operation).finally(() => {
      if (this.#inFlight.get(actionId) === current) this.#inFlight.delete(actionId);
    });
    this.#inFlight.set(actionId, current);
    return current;
  }
}

/** Reject pending creation, first removing any file produced by a failed attempt. */
export async function rejectDriveCreation(
  runtime: DriveCreationRuntime, actionId: number,
): Promise<boolean> {
  let store = new DriveCreationStore(runtime.storage);
  let action = store.getAction(actionId);
  let outcome = store.getOutcome(actionId);
  if (outcome?.status === "rejected") {
    store.cleanupTerminal(actionId);
    return store.listDocEdits(actionId).length > 0;
  }
  if (outcome?.status === "created" || outcome?.status === "reverted") {
    throw new Error(`Google Drive creation action ${actionId} has already been applied`);
  }
  if (!action) throw new Error(`Unknown pending Google Drive creation action: ${actionId}`);

  let createdFileId = outcome?.status === "failed" || outcome?.status === "applying"
    ? outcome.createdFileId
    : undefined;
  if (!createdFileId) {
    let created = await runtime.api.findFileByCreationRequestId(action.requestId);
    if (created) {
      assertCreatedFileIdentity(action, created);
      createdFileId = created.id;
    }
  }
  if (createdFileId) await trashCreatedFile(runtime, createdFileId);
  store.invalidateDocEdits(
    actionId, `Google Drive creation action ${actionId} was rejected.`);
  let restart = store.listDocEdits(actionId).length > 0;
  store.finish(actionId, { status: "rejected" });
  return restart;
}

/** Trash a currently authorized created item and record its reverted state. */
export async function revertDriveCreation(
  runtime: DriveCreationRuntime, actionId: number,
): Promise<boolean> {
  let store = new DriveCreationStore(runtime.storage);
  let outcome = store.getOutcome(actionId);
  if (outcome?.status === "reverted") {
    store.cleanupTerminal(actionId);
    return store.listDocEdits(actionId).length > 0;
  }
  let fileId: string | undefined;
  if (outcome?.status === "created") fileId = outcome.fileId;
  else if (outcome?.status === "failed") fileId = outcome.createdFileId;
  if (!fileId) {
    throw new Error(`Google Drive creation action ${actionId} cannot be reverted`);
  }
  await trashCreatedFile(runtime, fileId);
  store.invalidateDocEdits(
    actionId, `Google Drive creation action ${actionId} was reverted.`);
  let restart = store.listDocEdits(actionId).length > 0;
  store.finish(actionId, { status: "reverted" });
  return restart;
}

async function trashCreatedFile(runtime: DriveCreationRuntime, fileId: string): Promise<void> {
  let file = await runtime.api.getFile(fileId);
  if (file.id !== fileId || runtime.scope.kind === "file" ||
      !isDriveFileInScope(runtime.scope, file)) {
    throw new Error("The requested file is outside this Drive binding.");
  }
  if (file.trashed === true) return;
  if (file.capabilities?.canTrash !== true) {
    throw new Error("The created Google Drive item cannot currently be moved to trash");
  }
  await runtime.api.trashFile(fileId);
}

function assertCreatedFileIdentity(
  action: DriveCreationAction, file: DriveFile, expectedFileId?: string,
): void {
  if (!hasDriveCreationMarker(file, action.requestId) ||
      (expectedFileId !== undefined && file.id !== expectedFileId)) {
    throw new Error("Google Drive creation marker matched unexpected file metadata");
  }
}
function validateCreatedFile(
  scope: DriveBindingScope, action: DriveCreationAction, file: DriveFile,
): void {
  if (scope.kind === "file" ||
      isDriveFileInScope(scope, file) === false ||
      file.name !== action.name ||
      file.mimeType !== MIME_TYPE_BY_KIND[action.kind] ||
      file.trashed !== false ||
      file.parents?.length !== 1 ||
      file.parents[0] !== action.parentId) {
    throw new Error("Google Drive creation marker matched unexpected file metadata");
  }
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
