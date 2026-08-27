import type { RpcStub } from "capnweb";
import type {
  ActionHistoryFilter, ActionHistoryPage, AiChatAuthorInfo, AiChatHistoryPage, AiChatMessage,
  AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, AiModelConfig, AuthenticatedApi, Overseer,
  PublicApi, WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import {
  type ConnectedAccount, connect, listConnectedAccounts, nextUsernames, signUp, stubFor, waitFor,
  RpcTarget,
} from "./rpc-client.js";

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

type UserModel = {
  profile: AiChatAuthorInfo;
  config: AiModelConfig;
};

/** Configuration for one fresh local Workshop account and workspace. */
export type AgentSessionOptions = {
  modelId: string;
  userModel?: UserModel;
  ambientVendorIds?: readonly string[];
  usernamePrefix?: string;
  turnTimeoutMs?: number;
};

/** How one observed agent activation ended. */
export type AgentTurnOutcome =
  | { status: "completed" }
  | { status: "error"; message: string; code?: string }
  | { status: "timedOut"; message: string };

/** Canonical state observed after one agent activation ends. */
export type AgentTurnResult = {
  outcome: AgentTurnOutcome;
  history: AiChatMessage[];
  workpieces: WorkpieceSummary[];
  usage: {
    lastStepTokens?: number;
    observedCumulativeChatCostUsd?: number;
  };
};

/** Filters accepted by the public action-history API. */
export type ActionListOptions = { beforeId?: number; filter?: ActionHistoryFilter };

/**
 * Drives a fresh local Workshop account and workspace through the public Cap'n Web API.
 * `runTurn()` observes one active-to-idle agent activation. It does not claim that late callbacks
 * have settled; tests that trigger an approval continuation must use `approveActionAndWait()`.
 */
export interface WorkshopAgentSession extends AsyncDisposable {
  readonly username: string;
  runTurn(prompt: string): Promise<AgentTurnResult>;
  approveActionAndWait(id: number): Promise<AgentTurnResult>;
  listActions(options?: ActionListOptions): Promise<ActionHistoryPage>;
  connectedAccount(vendorId: string): ConnectedAccount;
  close(): Promise<void>;
}

type AgentErrorMessage = AiChatMessage & { type: "error" };
type PendingTurnEvent =
  | { type: "metadata"; chat: AiChatMetadata; latestSequence: number }
  | { type: "error"; entry: AgentErrorMessage };

class TurnObserver {
  readonly result: Promise<AgentTurnOutcome>;
  readonly timeoutFailure: Promise<never>;
  #resolveResult: (outcome: AgentTurnOutcome) => void = () => {};
  #rejectTimeout: (error: Error) => void = () => {};
  #chatId: number | undefined;
  #pendingEvents: PendingTurnEvent[] = [];
  #sawActive = false;
  #error: {
    outcome: Extract<AgentTurnOutcome, { status: "error" }>;
    sequence: number;
  } | undefined;
  #startSequence = -1;
  #outcome: AgentTurnOutcome | undefined;
  #timer: ReturnType<typeof setTimeout>;

  constructor(chatId: number | undefined, timeoutMs: number) {
    this.#chatId = chatId;
    this.result = new Promise(resolve => { this.#resolveResult = resolve; });
    this.timeoutFailure = new Promise<never>((_resolve, reject) => {
      this.#rejectTimeout = reject;
    });
    this.timeoutFailure.catch(() => {});
    this.#timer = setTimeout(() => {
      const message = `Timed out after ${timeoutMs}ms waiting for the agent activation`;
      this.#finish({ status: "timedOut", message });
      this.#rejectTimeout(new Error(message));
    }, timeoutMs);
  }

  get outcome(): AgentTurnOutcome | undefined {
    return this.#outcome;
  }

  get startSequence(): number {
    return this.#startSequence;
  }

  attach(chatId: number): void {
    this.#chatId = chatId;
    const events = this.#pendingEvents;
    this.#pendingEvents = [];
    for (const event of events) {
      if (event.type === "metadata") {
        this.metadata(event.chat, event.latestSequence);
      } else {
        this.message(event.entry);
      }
    }
  }

  metadata(chat: AiChatMetadata, latestSequence: number): void {
    if (this.#chatId === undefined) {
      this.#pendingEvents.push({ type: "metadata", chat, latestSequence });
      return;
    }
    if (chat.id !== this.#chatId || this.#outcome !== undefined) return;
    if (chat.activeAgent !== undefined) {
      if (!this.#sawActive) {
        this.#startSequence = latestSequence;
        if (this.#error !== undefined && this.#error.sequence <= latestSequence) {
          this.#error = undefined;
        }
      }
      this.#sawActive = true;
    } else if (this.#sawActive || this.#error !== undefined) {
      this.#finish(this.#error?.outcome ?? { status: "completed" });
    }
  }

  message(entry: AiChatMessage): void {
    if (entry.type !== "error") return;
    if (this.#chatId === undefined) {
      this.#pendingEvents.push({ type: "error", entry });
      return;
    }
    if (entry.chatId !== this.#chatId ||
        (this.#sawActive && entry.sequence <= this.#startSequence)) return;
    const outcome: Extract<AgentTurnOutcome, { status: "error" }> = entry.code === undefined
      ? { status: "error", message: entry.message }
      : { status: "error", message: entry.message, code: entry.code };
    this.#error = { outcome, sequence: entry.sequence };
  }

  race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.timeoutFailure]);
  }

  dispose(): void {
    clearTimeout(this.#timer);
  }

  #finish(outcome: AgentTurnOutcome): void {
    if (this.#outcome !== undefined) return;
    this.#outcome = outcome;
    this.#resolveResult(outcome);
  }
}

class ChatSubscriber extends RpcTarget implements AiChatSubscriber {
  observer: TurnObserver | undefined;
  readonly #latestSequence = new Map<number, number>();

  streamGeneration(_generation: number): void {}
  metadata(chat: AiChatMetadata): void {
    this.observer?.metadata(chat, this.latestSequence(chat.id));
  }
  deleted(_chatId: number): void {}
  message(entry: AiChatMessage): void {
    this.#latestSequence.set(entry.chatId, entry.sequence);
    this.observer?.message(entry);
  }
  changeApplied(
      _chatId: number, _generation: number, _revision: number, _author: AiChatAuthorInfo,
      _change: CodeChange, _submission?: { clientId: string; seq: number }): void {}
  stream(_chatId: number, _event: AiChatStreamEvent): void {}

  latestSequence(chatId: number): number {
    return this.#latestSequence.get(chatId) ?? -1;
  }
}

class WorkpieceSubscriber extends RpcTarget implements WorkpiecesSubscriber {
  readonly entries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly readiness: Promise<void>;
  #resolveReady: () => void = () => {};

  constructor() {
    super();
    this.readiness = new Promise(resolve => { this.#resolveReady = resolve; });
  }

  entry(summary: WorkpieceSummary): void { this.entries.set(summary.id, summary); }
  removed(id: WorkpieceId): void { this.entries.delete(id); }
  ready(): void { this.#resolveReady(); }
}

class WorkshopAgentSessionImpl implements WorkshopAgentSession {
  readonly username: string;
  readonly #modelId: string;
  readonly #publicApi: RpcStub<PublicApi>;
  readonly #authenticatedApi: RpcStub<AuthenticatedApi>;
  readonly #workspace: RpcStub<Overseer>;
  readonly #accounts: ReadonlyMap<string, ConnectedAccount>;
  readonly #chatSubscriber = new ChatSubscriber();
  readonly #workpieceSubscriber = new WorkpieceSubscriber();
  readonly #turnTimeoutMs: number;
  #chatSubscriberStub: RpcStub<ChatSubscriber> | undefined;
  #chatSubscription: RpcStub<{}> | undefined;
  #workpieceSubscriberStub: RpcStub<WorkpieceSubscriber> | undefined;
  #workpieceSubscription: RpcStub<{}> | undefined;
  #chatId: number | undefined;
  #activeTurn: TurnObserver | undefined;
  #closePromise: Promise<void> | undefined;
  #terminal = false;
  #closed = false;

  constructor(options: {
    username: string;
    modelId: string;
    publicApi: RpcStub<PublicApi>;
    authenticatedApi: RpcStub<AuthenticatedApi>;
    workspace: RpcStub<Overseer>;
    accounts: ReadonlyMap<string, ConnectedAccount>;
    turnTimeoutMs: number;
  }) {
    this.username = options.username;
    this.#modelId = options.modelId;
    this.#publicApi = options.publicApi;
    this.#authenticatedApi = options.authenticatedApi;
    this.#workspace = options.workspace;
    this.#accounts = options.accounts;
    this.#turnTimeoutMs = options.turnTimeoutMs;
  }

  async initialize(): Promise<void> {
    this.#chatSubscriberStub = stubFor(this.#chatSubscriber);
    this.#chatSubscription = await this.#workspace.subscribeToChat(this.#chatSubscriberStub);
    this.#workpieceSubscriberStub = stubFor(this.#workpieceSubscriber);
    this.#workpieceSubscription = await this.#workspace.subscribeToWorkpieces(
        this.#workpieceSubscriberStub);
    await this.#workpieceSubscriber.readiness;
  }

  runTurn(prompt: string): Promise<AgentTurnResult> {
    this.#assertOpen();
    if (this.#activeTurn !== undefined) throw new Error("An agent activation is already running");
    const chatId = this.#chatId;
    const observer = new TurnObserver(chatId, this.#turnTimeoutMs);
    const operation = chatId === undefined
      ? () => this.#startChat(prompt, observer)
      : () => Promise.resolve(this.#workspace.sendChatMessage(chatId, prompt, this.#modelId));
    return this.#observeOperation(observer, operation);
  }

  approveActionAndWait(id: number): Promise<AgentTurnResult> {
    this.#assertOpen();
    const chatId = this.#chatId;
    if (chatId === undefined) throw new Error("The session has no chat to resume");
    if (this.#activeTurn !== undefined) throw new Error("An agent activation is already running");
    const observer = new TurnObserver(chatId, this.#turnTimeoutMs);
    return this.#observeOperation(
        observer, () => Promise.resolve(this.#workspace.approveAction(id)));
  }

  listActions(options?: ActionListOptions): Promise<ActionHistoryPage> {
    this.#assertOpen();
    return this.#workspace.listActions(options);
  }

  connectedAccount(vendorId: string): ConnectedAccount {
    this.#assertOpen();
    const account = this.#accounts.get(vendorId);
    if (account === undefined) throw new Error(`No connected account for vendor "${vendorId}"`);
    return account;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #startChat(prompt: string, observer: TurnObserver): Promise<void> {
    const creating = Promise.resolve(this.#workspace.newChat(prompt, this.#modelId));
    creating.then(chatId => {
      if (this.#closed) return;
      if (this.#activeTurn !== observer || observer.outcome?.status === "timedOut") {
        Promise.resolve(this.#workspace.stopAgent(chatId)).catch(() => {});
        return;
      }
      this.#chatId = chatId;
      observer.attach(chatId);
    }, () => {});
    this.#chatId = await observer.race(creating);
    observer.attach(this.#chatId);
  }

  async #observeOperation(
      observer: TurnObserver, start: () => Promise<void>): Promise<AgentTurnResult> {
    this.#activeTurn = observer;
    this.#chatSubscriber.observer = observer;
    const operation = start();
    operation.catch(() => {});
    try {
      try {
        await observer.race(operation);
      } catch (error) {
        if (observer.outcome?.status !== "timedOut") throw error;
      }
      const outcome = observer.outcome ?? await observer.result;
      if (outcome.status === "timedOut") {
        this.#terminal = true;
        if (this.#chatId !== undefined) {
          Promise.resolve(this.#workspace.stopAgent(this.#chatId)).catch(() => {});
        }
      }
      return this.#snapshot(outcome, observer.startSequence);
    } finally {
      observer.dispose();
      if (this.#chatSubscriber.observer === observer) this.#chatSubscriber.observer = undefined;
      if (this.#activeTurn === observer) this.#activeTurn = undefined;
    }
  }

  async #snapshot(
      observedOutcome: AgentTurnOutcome, startSequence: number): Promise<AgentTurnResult> {
    const chatId = this.#chatId;
    const workpieces = [...this.#workpieceSubscriber.entries.values()];
    if (chatId === undefined) {
      return { outcome: observedOutcome, history: [], workpieces, usage: {} };
    }
    const [history, chats] = await Promise.all([
      loadAllChatHistory(before => this.#workspace.getChatHistory(chatId, before)),
      this.#workspace.listChats(),
    ]);
    const newMessages = history.filter(message => message.sequence > startSequence);
    const error = newMessages.find(message => message.type === "error");
    let outcome: AgentTurnOutcome = observedOutcome;
    if (error !== undefined && observedOutcome.status !== "timedOut") {
      outcome = error.code === undefined
        ? { status: "error", message: error.message }
        : { status: "error", message: error.message, code: error.code };
    }
    const metadata = chats.find(chat => chat.id === chatId);
    if (metadata === undefined) throw new Error(`Chat ${chatId} disappeared`);
    const usage: AgentTurnResult["usage"] = {};
    if (metadata.totalTokens !== undefined) usage.lastStepTokens = metadata.totalTokens;
    if (metadata.totalCost !== undefined) {
      usage.observedCumulativeChatCostUsd = metadata.totalCost;
    }
    return { outcome, history, workpieces, usage };
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    let stopError: Error | undefined;
    let deleteError: Error | undefined;
    try {
      if (this.#activeTurn !== undefined && this.#chatId !== undefined) {
        try {
          await this.#workspace.stopAgent(this.#chatId);
        } catch (error) {
          stopError = error instanceof Error ? error : new Error(String(error));
        }
      }
      try {
        await this.#workspace.deleteSelf();
      } catch (error) {
        deleteError = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      this.#chatSubscription?.[Symbol.dispose]();
      this.#workpieceSubscription?.[Symbol.dispose]();
      this.#chatSubscriberStub?.[Symbol.dispose]();
      this.#workpieceSubscriberStub?.[Symbol.dispose]();
      this.#workspace[Symbol.dispose]();
      this.#authenticatedApi[Symbol.dispose]();
      this.#publicApi[Symbol.dispose]();
    }
    if (stopError !== undefined && deleteError !== undefined) {
      throw new AggregateError([stopError, deleteError], "Agent shutdown and workspace deletion failed");
    }
    if (stopError !== undefined) throw stopError;
    if (deleteError !== undefined) throw deleteError;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("WorkshopAgentSession is closed");
    if (this.#terminal) throw new Error("WorkshopAgentSession cannot continue after a timeout");
  }
}

/** Open one fresh local account and workspace for deterministic tests or real-model evals. */
export async function openAgentSession(
    baseUrl: URL, options: AgentSessionOptions): Promise<WorkshopAgentSession> {
  const publicApi = connect(baseUrl);
  let authenticatedApi: RpcStub<AuthenticatedApi> | undefined;
  let workspace: RpcStub<Overseer> | undefined;
  let session: WorkshopAgentSessionImpl | undefined;
  try {
    const username = nextUsernames(options.usernamePrefix ?? "agent").at(0);
    if (username === undefined) throw new Error("Failed to allocate an agent-session username");
    const authenticated = authenticatedApi = await signUp(publicApi, username);
    if (options.userModel !== undefined) {
      await authenticated.addModel(options.userModel.profile, options.userModel.config);
    }
    const models = await authenticated.listModels();
    if (!models.some(model => model.id === options.modelId)) {
      throw new Error(`Model "${options.modelId}" is not available to the test account`);
    }
    await authenticated.setQuickModel(null);
    await authenticated.setPreferredModel(options.modelId);
    await authenticated.completeOnboarding();

    const accounts = new Map<string, ConnectedAccount>();
    for (const vendorId of options.ambientVendorIds ?? []) {
      await authenticated.provisionAmbientAccount(vendorId);
      const account = await waitFor(`the ${vendorId} account to be provisioned`, async () =>
        (await listConnectedAccounts(authenticated)).find(entry => entry.vendorId === vendorId)
          ?? null);
      accounts.set(vendorId, account);
    }

    workspace = await authenticated.newGadget();
    session = new WorkshopAgentSessionImpl({
      username,
      modelId: options.modelId,
      publicApi,
      authenticatedApi,
      workspace,
      accounts,
      turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    });
    await session.initialize();
    return session;
  } catch (error) {
    if (session !== undefined) {
      await session.close();
    } else {
      workspace?.[Symbol.dispose]();
      authenticatedApi?.[Symbol.dispose]();
      publicApi[Symbol.dispose]();
    }
    throw error;
  }
}

/** Load every compacted page of one canonical chat history in ascending sequence order. */
export async function loadAllChatHistory(
    loadPage: (beforeSequence?: number) => Promise<AiChatHistoryPage>): Promise<AiChatMessage[]> {
  let page = await loadPage();
  let messages = page.messages;
  const boundaries = new Set<number>();
  while (page.compacted !== undefined) {
    const boundary = page.compacted.to;
    if (boundaries.has(boundary)) {
      throw new Error(`Chat history repeated compaction boundary ${boundary}`);
    }
    boundaries.add(boundary);
    page = await loadPage(boundary);
    messages = [...page.messages, ...messages];
  }
  return messages;
}
