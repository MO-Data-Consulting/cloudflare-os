import {
  openAgentSession, type AgentSessionOptions, type WorkshopAgentSession,
} from "@gadgets/integration-tests/agent-session";
import { startHarness, type WorkerConfig } from "@gadgets/integration-tests/harness";
import { NetworkInterceptor } from "@gadgets/integration-tests/network-interceptor";

export type LocalModelAccess = {
  kind: "gateway";
  gateway: string;
  accountId: string;
  apiToken: string;
} | {
  kind: "direct";
  accountId: string;
  apiToken: string;
};

export type LocalEvalTarget = AsyncDisposable & { session: WorkshopAgentSession };

function value(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const candidate = environment[key]?.trim();
  return candidate === "" ? undefined : candidate;
}

/** Resolve credentials used only for model inference from the local Workshop. */
export function resolveModelAccess(
    environment: NodeJS.ProcessEnv = process.env): LocalModelAccess {
  const gateway = value(environment, "CF_AI_GATEWAY");
  const gatewayAccountId = value(environment, "CF_AI_GATEWAY_ACCOUNT_ID");
  const gatewayApiToken = value(environment, "CF_AI_GATEWAY_API_TOKEN");
  if (gateway !== undefined || gatewayAccountId !== undefined || gatewayApiToken !== undefined) {
    if (gateway === undefined || gatewayAccountId === undefined || gatewayApiToken === undefined) {
      throw new Error(
        "Local AI Gateway evals require CF_AI_GATEWAY, CF_AI_GATEWAY_ACCOUNT_ID, and " +
        "CF_AI_GATEWAY_API_TOKEN together",
      );
    }
    return {
      kind: "gateway",
      gateway,
      accountId: gatewayAccountId,
      apiToken: gatewayApiToken,
    };
  }

  const accountId = value(environment, "CLOUDFLARE_ACCOUNT_ID");
  const apiToken = value(environment, "CLOUDFLARE_API_TOKEN");
  if (accountId !== undefined && apiToken !== undefined) {
    return { kind: "direct", accountId, apiToken };
  }
  throw new Error(
    "Local Workshop evals need model credentials: configure the CF_AI_GATEWAY trio or " +
    "CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_API_TOKEN",
  );
}

function configureGateway(
    config: WorkerConfig, access: Extract<LocalModelAccess, { kind: "gateway" }>): void {
  config.vars = {
    ...config.vars,
    CF_AI_GATEWAY: access.gateway,
    CF_AI_GATEWAY_ACCOUNT_ID: access.accountId,
    CF_AI_GATEWAY_API_TOKEN: access.apiToken,
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
    CF_AI_GATEWAY_USE_BINDING: "false",
  };
}

function allowsModelEgress(
    access: LocalModelAccess, url: URL, method: string): boolean {
  const account = encodeURIComponent(access.accountId);
  if (access.kind === "gateway") {
    const gateway = encodeURIComponent(access.gateway);
    if (method === "POST") {
      return url.origin === "https://gateway.ai.cloudflare.com" &&
        url.pathname === `/v1/${account}/${gateway}/workers-ai/v1/chat/completions`;
    }
    const logPrefix =
        `/client/v4/accounts/${account}/ai-gateway/gateways/${gateway}/logs/`;
    const logId = url.pathname.slice(logPrefix.length);
    return method === "GET" && url.origin === "https://api.cloudflare.com" &&
      url.pathname.startsWith(logPrefix) && logId !== "" && !logId.includes("/");
  }
  return method === "POST" && url.origin === "https://api.cloudflare.com" &&
    url.pathname === `/client/v4/accounts/${account}/ai/v1/chat/completions`;
}

/** Start an isolated local workerd Workshop and one fresh agent session. */
export async function openLocalEvalTarget(
    access: LocalModelAccess, modelId: string, turnTimeoutMs: number): Promise<LocalEvalTarget> {
  const interceptor = new NetworkInterceptor(
      [() => new Response("External network access is disabled during this eval.", { status: 403 })],
      (url, method) => allowsModelEgress(access, url, method));
  interceptor.install();
  try {
    const harness = await startHarness({
      gatekeepers: [],
      enableGadgetExecution: true,
      ...(access.kind === "gateway"
        ? { patchWorkshop: (config: WorkerConfig) => configureGateway(config, access) }
        : {}),
    });
    const options: AgentSessionOptions = { modelId, turnTimeoutMs };
    if (access.kind === "direct") {
      options.userModel = {
        profile: { type: "agent", id: modelId, name: modelId },
        config: {
          provider: "cloudflare",
          model: modelId,
          accountId: access.accountId,
          apiToken: access.apiToken,
        },
      };
    }
    try {
      const session = await openAgentSession(harness.url, options);
      return {
        session,
        [Symbol.asyncDispose]: async () => {
          const failures: Error[] = [];
          try {
            try {
              await session.close();
            } catch (error) {
              failures.push(error instanceof Error ? error : new Error(String(error)));
            }
            try {
              await harness.server.close();
            } catch (error) {
              failures.push(error instanceof Error ? error : new Error(String(error)));
            }
          } finally {
            interceptor.uninstall();
          }
          const first = failures.at(0);
          if (failures.length === 1 && first !== undefined) throw first;
          if (failures.length > 1) throw new AggregateError(failures, "Eval target cleanup failed");
        },
      };
    } catch (error) {
      let closeError: Error | undefined;
      try {
        await harness.server.close();
      } catch (failure) {
        closeError = failure instanceof Error ? failure : new Error(String(failure));
      } finally {
        interceptor.uninstall();
      }
      if (closeError !== undefined) {
        throw new Error(
          `Eval session setup failed and cleanup also failed: ${closeError.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error) {
    interceptor.uninstall();
    throw error;
  }
}
