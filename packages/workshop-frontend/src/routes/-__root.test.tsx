// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuthenticatedApi } from "../AuthContext";
import { Route as RootRoute } from "./__root";

vi.mock("../RpcContext", () => ({
  useRpcStub: () => ({}),
  useConnectionLost: () => false,
}));

vi.mock("../useAuth", () => ({
  CF_ACCESS_MODE: false,
  useAuth: () => ({
    isAuthenticated: false,
    authenticatedApi: null,
    isLoading: false,
    error: null,
    logout: vi.fn(),
    login: vi.fn(),
  }),
}));

vi.mock("../LoginPage", async () => {
  const { Link } = await import("@tanstack/react-router");
  return {
    default: () => <Link to="/signup">Create one</Link>,
  };
});

vi.mock("@cloudflare/kumo", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Toasty: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../FeatureFlagsContext", () => ({
  FeatureFlagsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/Header", () => ({ default: () => null }));
vi.mock("../components/AppShell/AppShell", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../OnboardingWizard", () => ({ default: () => null }));
vi.mock("../components/billing/AccountSelectionModal", () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => {};

describe("root route public navigation", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.restoreAllMocks();
  });

  it("does not expose the previous protected child while navigating to signup", async () => {
    const homeRoute = createRoute({
      getParentRoute: () => RootRoute,
      path: "/",
      component: () => {
        useAuthenticatedApi();
        return <p>Home</p>;
      },
    });
    const signupRoute = createRoute({
      getParentRoute: () => RootRoute,
      path: "/signup",
      component: () => <p>Signup</p>,
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: RootRoute.addChildren([homeRoute, signupRoute]),
    });
    const reportedErrors: string[] = [];
    const report = (error: unknown) => reportedErrors.push(String(error));
    vi.spyOn(console, "error").mockImplementation((...args) => {
      reportedErrors.push(args.map(String).join(" "));
    });

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container, {
      onCaughtError: report,
      onUncaughtError: report,
    });
    await act(async () => root!.render(<RouterProvider router={router} />));

    const signupLink = container.querySelector("a");
    expect(signupLink?.textContent).toBe("Create one");
    await act(async () => signupLink!.click());

    expect(router.state.location.pathname).toBe("/signup");
    expect(container.textContent).toContain("Signup");
    expect(reportedErrors.join("\n")).not.toContain(
      "useAuthenticatedApi must be used within an AuthProvider",
    );
  });
});
