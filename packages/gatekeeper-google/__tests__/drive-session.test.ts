import { describe, expect, it, vi } from "vitest";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import { DriveSessionCore, driveFileToEntry } from "../src/drive-session";
import { DriveApiRequestError, type DriveFile, type DriveListFilesOptions } from "../src/drive-api";
import type { ObserverCheck } from "../src/observers";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

const file = (overrides: Partial<DriveFile> = {}): DriveFile => ({
  id: "file-1",
  name: "Quarterly plan",
  mimeType: "application/pdf",
  modifiedTime: "2026-01-02T03:04:05Z",
  ...overrides,
});

function core(overrides: {
  scope?: { kind: "account" } | { kind: "sharedDrive"; driveId: string } |
    { kind: "file"; fileId: string };
  files?: DriveFile[];
  getFile?: (id: string) => Promise<DriveFile>;
  getDrive?: (id: string) => Promise<{ id: string; name: string }>;
  listFiles?: (options: DriveListFilesOptions) => Promise<{
    files: DriveFile[];
    nextPageToken?: string;
  }>;
  prepareObservation?: (ids: string[]) => Promise<ObserverCheck<string>>;
  authorize?: (description: ObservationDescription) => Promise<void>;
  observerIds?: () => string[];
} = {}) {
  let listFiles = vi.fn(overrides.listFiles ?? (async () => ({ files: overrides.files ?? [file()] })));
  let getFile = vi.fn(overrides.getFile ?? (async (id: string) => file({ id })));
  let getDrive = vi.fn(overrides.getDrive ??
    (async (id: string) => ({ id, name: "Current shared drive" })));
  let prepared: string[][] = [];
  let authorizations: ObservationDescription[] = [];
  let events: string[] = [];
  let session = new DriveSessionCore({
    api: { listFiles, getFile, getDrive },
    scope: overrides.scope ?? { kind: "account" },
    prepareObservation: overrides.prepareObservation ?? (async (ids: string[]) => {
      prepared.push(ids);
      return {
        excludeObservers: ["excluded"],
        pendingSets: ids,
        commit: () => events.push("commit"),
      };
    }),
    observerIds: overrides.observerIds ?? (() => ["excluded"]),
    authorize: async (description: ObservationDescription) => {
      authorizations.push(description);
      events.push("authorize");
      await overrides.authorize?.(description);
    },
  });
  return { session, listFiles, getFile, getDrive, prepared, authorizations, events };
}

describe("Drive metadata mapping", () => {
  it("maps the complete declared metadata shape without provider-only fields", () => {
    expect(driveFileToEntry(file({
      size: "123",
      parents: ["folder-1"],
      owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
      webViewLink: "https://drive.google.com/open?id=file-1",
    }))).toEqual({
      id: "file-1",
      name: "Quarterly plan",
      mimeType: "application/pdf",
      isFolder: false,
      modifiedTime: new Date("2026-01-02T03:04:05Z"),
      size: 123,
      owner: { displayName: "Ada", emailAddress: "ada@example.com" },
      parentId: "folder-1",
      webViewLink: "https://drive.google.com/open?id=file-1",
    });
  });

  it("omits owner metadata for shared-drive entries", () => {
    let entry = driveFileToEntry(file({
      driveId: "drive-1",
      owners: [{ displayName: "Unexpected owner", emailAddress: "owner@example.com" }],
    }));
    expect(entry.driveId).toBe("drive-1");
    expect(entry).not.toHaveProperty("owner");
  });

  it.each([
    ["folder", "application/vnd.google-apps.folder", undefined],
    ["shortcut", "application/vnd.google-apps.shortcut", { targetId: "target-1" }],
  ] as const)("omits size for a %s", (_kind, mimeType, shortcutDetails) => {
    let entry = driveFileToEntry(file({ mimeType, size: "123", shortcutDetails }));
    expect(entry).not.toHaveProperty("size");
    expect(entry.shortcut).toEqual(shortcutDetails);
  });
});

describe("Drive session scope", () => {
  it("lists the connected account and authorizes every returned file before committing", async () => {
    let { session, listFiles, prepared, authorizations, events } = core();
    let page = await (await session.list()).next();

    expect(page?.map(entry => entry.id)).toEqual(["file-1"]);
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({ corpus: { kind: "user" } }));
    expect(prepared).toEqual([["file-1"]]);
    expect(authorizations[0].excludeObservers).toEqual(["excluded"]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it.each([
    ["account", { kind: "account" }],
    ["shared drive", { kind: "sharedDrive", driveId: "drive-1" }],
  ] as const)("audits and rejects an empty %s search", async (_label, scope) => {
    let { session, prepared, authorizations, events } = core({ scope, files: [] });

    let cursor = await session.search({ namePrefix: "missing" });
    await expect(cursor.next()).rejects
      .toThrow(new Error("An empty Drive search cannot be shared safely."));

    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([expect.objectContaining({
      title: "Search Google Drive metadata",
      description: expect.stringContaining('name starts with "missing"'),
      excludeObservers: ["excluded"],
    })]);
    expect(authorizations[0]).not.toHaveProperty("prohibitAllSharing");
    expect(authorizations[0].description).not.toContain("0");
    expect(events).toEqual(["authorize"]);
  });

  it("ends a search cleanly after an earlier page disclosed results", async () => {
    let { session, listFiles } = core({
      listFiles: async options => options.pageToken === "page-2"
        ? { files: [] }
        : { files: [file()], nextPageToken: "page-2" },
    });

    let cursor = await session.search({ namePrefix: "Quarterly" });
    expect((await cursor.next())?.map(entry => entry.id)).toEqual(["file-1"]);
    await expect(cursor.next()).resolves.toBeNull();
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("pins shared-drive reads and drops a foreign result before observation", async () => {
    let local = file({ id: "local", driveId: "drive-1" });
    let foreign = file({ id: "foreign", driveId: "drive-2" });
    let { session, listFiles, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [local, foreign],
    });

    let page = await (await session.list()).next();
    expect(page?.map(entry => entry.id)).toEqual(["local"]);
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({
      corpus: { kind: "drive", driveId: "drive-1" },
    }));
    expect(prepared).toEqual([["local"]]);
  });

  it("re-applies the shared-drive corpus pin on every page", async () => {
    let { session, listFiles } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      listFiles: async options => options.pageToken === "page-2"
        ? { files: [file({ id: "local-2", driveId: "drive-1" })] }
        : { files: [file({ id: "local-1", driveId: "drive-1" })], nextPageToken: "page-2" },
    });

    let cursor = await session.list();
    expect((await cursor.next())?.map(entry => entry.id)).toEqual(["local-1"]);
    expect((await cursor.next())?.map(entry => entry.id)).toEqual(["local-2"]);
    expect(listFiles).toHaveBeenNthCalledWith(1, expect.objectContaining({
      corpus: { kind: "drive", driveId: "drive-1" },
    }));
    expect(listFiles).toHaveBeenNthCalledWith(2, expect.objectContaining({
      corpus: { kind: "drive", driveId: "drive-1" },
      pageToken: "page-2",
    }));
  });

  it("refuses a direct lookup outside a shared drive before authorizing it", async () => {
    let { session, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-2" }),
    });

    await expect(session.getEntry("foreign")).rejects.toThrow(/outside this Drive binding/);
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });

  it.each([403, 404])(
    "does not reveal whether the account can read a shared-drive probe rejected with %d",
    async status => {
      let { session, prepared } = core({
        scope: { kind: "sharedDrive", driveId: "drive-1" },
        getFile: async () => { throw new DriveApiRequestError(status); },
      });

      let outside = new Error("The requested file is outside this Drive binding.");
      await expect(session.getEntry("foreign")).rejects.toThrow(outside);
      await expect(session.list({ directParentId: "foreign" })).rejects.toThrow(outside);
      expect(prepared).toEqual([]);
    },
  );

  it("preserves a shared-drive provider outage", async () => {
    let { session } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async () => { throw new DriveApiRequestError(500); },
    });

    await expect(session.getEntry("file-1")).rejects
      .toThrow("Google Drive API request failed: 500");
  });

  it.each([
    "dailyLimitExceeded",
    "rateLimitExceeded",
    "userRateLimitExceeded",
  ])("preserves a shared-drive quota failure reported as %s", async reason => {
    let error = new DriveApiRequestError(403, reason);
    let { session } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async () => { throw error; },
    });

    await expect(session.getEntry("file-1")).rejects.toThrow(error);
  });

  it("refuses another file ID without calling Google for a file-scoped binding", async () => {
    let { session, getFile } = core({ scope: { kind: "file", fileId: "file-1" } });
    await expect(session.getEntry("file-2")).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("lists an exact-file binding without scanning the connected account", async () => {
    let { session, listFiles, getFile, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async id => file({ id, trashed: false }),
    });

    await expect((await session.list()).next())
      .resolves.toEqual([expect.objectContaining({ id: "file-1" })]);
    expect(getFile).toHaveBeenCalledWith("file-1");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([["file-1"]]);
  });

  it("omits a trashed file from an exact-file listing", async () => {
    let { session, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ trashed: true }),
    });

    await expect((await session.list()).next()).resolves.toBeNull();
    expect(prepared).toEqual([["file-1"]]);
  });

  it("omits an exact file whose trash state is absent", async () => {
    let { session, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
    });

    await expect((await session.list()).next()).resolves.toBeNull();
    expect(prepared).toEqual([["file-1"]]);
  });

  it("still returns a trashed exact file from getEntry", async () => {
    let { session, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ trashed: true }),
    });

    await expect(session.getEntry("file-1")).resolves
      .toEqual(expect.objectContaining({ id: "file-1" }));
    expect(prepared).toEqual([["file-1"]]);
  });

  it("rejects an exact-file listing when the provider returns a different id", async () => {
    let { session, listFiles } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ id: "file-other" }),
    });

    await expect((await session.list()).next()).rejects.toThrow(/outside this Drive binding/);
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("reads current shared-drive scope metadata and observes its root ID", async () => {
    let { session, getDrive, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
    });
    await expect(session.getScope()).resolves.toEqual({
      kind: "sharedDrive", driveId: "drive-1", name: "Current shared drive",
    });
    expect(getDrive).toHaveBeenCalledWith("drive-1");
    expect(prepared).toEqual([["drive-1"]]);
  });

  it("refuses a shared-drive scope read when the provider returns another drive", async () => {
    let { session, getDrive, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getDrive: async () => ({ id: "drive-other", name: "Spoofed name" }),
    });

    await expect(session.getScope()).rejects.toThrow(/outside this Drive binding/);
    expect(getDrive).toHaveBeenCalledTimes(1);
    expect(getDrive).toHaveBeenCalledWith("drive-1");
    expect(prepared).toEqual([]);
  });

  it("refuses a file scope read when the provider returns another file", async () => {
    let { session, getFile, prepared } = core({
      scope: { kind: "file", fileId: "file-1" },
      getFile: async () => file({ id: "file-other", name: "Spoofed name" }),
    });

    await expect(session.getScope()).rejects.toThrow(/outside this Drive binding/);
    expect(getFile).toHaveBeenCalledWith("file-1");
    expect(prepared).toEqual([]);
  });

  it("treats the shared-drive root id as in scope", async () => {
    let { session, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "drive-1", name: "Drive root", mimeType: FOLDER_MIME_TYPE })],
    });

    let page = await (await session.list()).next();
    expect(page?.map(entry => entry.id)).toEqual(["drive-1"]);
    expect(prepared).toEqual([["drive-1"]]);
  });

  it("drops a My Drive file when the provider ignores the shared-drive corpus", async () => {
    let { session, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "mydrive-file" })],
    });

    await expect((await session.list()).next()).resolves.toBeNull();
    expect(prepared).toEqual([[]]);
    expect(authorizations).toHaveLength(1);
  });
});

describe("Drive parent folder probe", () => {
  it("rejects a parent from another shared drive before listing", async () => {
    let { session, listFiles, getFile, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-2", mimeType: FOLDER_MIME_TYPE }),
    });

    await expect(session.list({ directParentId: "folder-x" }))
      .rejects.toThrow(/outside this Drive binding/);
    expect(getFile).toHaveBeenCalledWith("folder-x");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });

  it("observes a readable non-folder parent before disclosing its type", async () => {
    let { session, listFiles, getFile, prepared, authorizations, events } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-1", mimeType: "application/pdf" }),
    });

    await expect(session.list({ directParentId: "file-x" }))
      .rejects.toThrow(/must identify a folder/);
    expect(getFile).toHaveBeenCalledWith("file-x");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([["file-x"]]);
    expect(authorizations).toEqual([expect.objectContaining({
      title: "Check Google Drive folder",
      excludeObservers: ["excluded"],
    })]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("does not disclose a readable non-folder parent when observation is denied", async () => {
    let { session, listFiles, prepared, authorizations, events } = core({
      getFile: async id => file({ id, mimeType: "application/pdf" }),
      authorize: async () => { throw new Error("denied"); },
    });

    await expect(session.list({ directParentId: "file-x" })).rejects.toThrow("denied");
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([["file-x"]]);
    expect(authorizations).toHaveLength(1);
    expect(events).toEqual(["authorize"]);
  });

  it("rejects a parent probe on a file-scoped binding without calling Google", async () => {
    let { session, getFile, listFiles } = core({ scope: { kind: "file", fileId: "file-1" } });

    await expect(session.list({ directParentId: "folder-x" }))
      .rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
    expect(listFiles).not.toHaveBeenCalled();
  });

  it("observes the parent-folder probe before listing its children", async () => {
    let { session, authorizations, events } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "child-1", driveId: "drive-1", parents: ["folder-1"] })],
      getFile: async id => file({ id, driveId: "drive-1", mimeType: FOLDER_MIME_TYPE }),
    });

    await (await session.list({ directParentId: "folder-1" })).next();
    expect(authorizations[0].title).toBe("Check Google Drive folder");
    expect(authorizations[1].title).toBe("Read Google Drive metadata");
    expect(events).toEqual(["authorize", "commit", "authorize", "commit"]);
  });

  it("rejects search when the parent is outside the shared drive", async () => {
    let { session, listFiles, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-2", mimeType: FOLDER_MIME_TYPE }),
    });

    await expect(session.search({ directParentId: "folder-x" }))
      .rejects.toThrow(/outside this Drive binding/);
    expect(listFiles).not.toHaveBeenCalled();
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });
});

describe("Drive creation parent authorization", () => {
  it("resolves the account root alias to its canonical ID before authorizing it", async () => {
    let events: string[] = [];
    let { session, getFile } = core({
      getFile: async id => {
        events.push(`fetch:${id}`);
        return file({
          id: "root-id", name: "My Drive", mimeType: FOLDER_MIME_TYPE,
          capabilities: { canAddChildren: true },
        });
      },
      prepareObservation: async ids => {
        events.push(`prepare:${ids.join(",")}`);
        return { pendingSets: ids, commit: () => events.push("commit") };
      },
      authorize: async () => { events.push("authorize"); },
    });

    await expect(session.resolveCreationParent()).resolves.toEqual({
      id: "root-id", name: "My Drive",
    });
    expect(getFile).toHaveBeenCalledWith("root");
    expect(events).toEqual(["fetch:root", "prepare:root-id", "authorize", "commit"]);
  });

  it("uses and fetches the bound shared-drive root by default", async () => {
    let { session, getFile, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({
        id, name: "Team Drive", mimeType: FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true },
      }),
    });

    await expect(session.resolveCreationParent()).resolves.toEqual({
      id: "drive-1", name: "Team Drive",
    });
    expect(getFile).toHaveBeenCalledWith("drive-1");
    expect(prepared).toEqual([["drive-1"]]);
  });

  it("fetches an explicit nested folder ID exactly", async () => {
    let { session, getFile } = core({
      getFile: async id => file({
        id, name: "Nested", mimeType: FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true },
      }),
    });

    await expect(session.resolveCreationParent(" folder-with-spaces "))
      .resolves.toEqual({ id: " folder-with-spaces ", name: "Nested" });
    expect(getFile).toHaveBeenCalledWith(" folder-with-spaces ");
  });

  it("rejects an empty explicit parent ID before provider access", async () => {
    let { session, getFile } = core();
    await expect(session.resolveCreationParent("   "))
      .rejects.toThrow("parentId must not be empty");
    expect(getFile).not.toHaveBeenCalled();
  });

  it("rejects exact-file creation authority before provider access", async () => {
    let { session, getFile } = core({ scope: { kind: "file", fileId: "folder-1" } });
    await expect(session.resolveCreationParent("folder-1"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary file", "application/pdf"],
    ["shortcut", "application/vnd.google-apps.shortcut"],
  ])("rejects a %s as a creation destination", async (_kind, mimeType) => {
    let { session, prepared, authorizations, events } = core({
      getFile: async id => file({
        id, mimeType, capabilities: { canAddChildren: true },
      }),
    });

    await expect(session.resolveCreationParent("file-1"))
      .rejects.toThrow("Drive creation parent must identify a folder");
    expect(prepared).toEqual([["file-1"]]);
    expect(authorizations).toEqual([expect.objectContaining({
      title: "Check Google Drive creation destination",
    })]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it.each([undefined, false])(
    "rejects a folder whose canAddChildren capability is %s",
    async canAddChildren => {
      let { session, prepared, authorizations, events } = core({
        getFile: async id => file({
          id, mimeType: FOLDER_MIME_TYPE,
          capabilities: canAddChildren === undefined ? {} : { canAddChildren },
        }),
      });

      await expect(session.resolveCreationParent("folder-1"))
        .rejects.toThrow("Drive creation parent does not allow adding children");
      expect(prepared).toEqual([["folder-1"]]);
      expect(authorizations).toEqual([expect.objectContaining({
        title: "Check Google Drive creation destination",
      })]);
      expect(events).toEqual(["authorize", "commit"]);
    },
  );

  it("rejects a folder from another shared drive before observation", async () => {
    let { session, prepared } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({
        id, driveId: "drive-2", mimeType: FOLDER_MIME_TYPE,
        capabilities: { canAddChildren: true },
      }),
    });

    await expect(session.resolveCreationParent("folder-1"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(prepared).toEqual([]);
  });

  it("fails revalidation when an approved parent moves outside the binding", async () => {
    let request = 0;
    let { session } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({
        id, driveId: request++ === 0 ? "drive-1" : "drive-2",
        mimeType: FOLDER_MIME_TYPE, capabilities: { canAddChildren: true },
      }),
    });

    await expect(session.resolveCreationParent("folder-1"))
      .resolves.toEqual({ id: "folder-1", name: "Quarterly plan" });
    await expect(session.revalidateCreationParent("folder-1"))
      .rejects.toThrow(/outside this Drive binding/);
  });

  it.each([403, 404])(
    "normalizes a %s shared-drive creation-parent probe without observation",
    async status => {
      let { session, prepared, authorizations } = core({
        scope: { kind: "sharedDrive", driveId: "drive-1" },
        getFile: async () => { throw new DriveApiRequestError(status); },
      });

      await expect(session.resolveCreationParent("foreign"))
        .rejects.toThrow(new Error("The requested file is outside this Drive binding."));
      expect(prepared).toEqual([]);
      expect(authorizations).toEqual([]);
    },
  );

  it.each([
    ["explicit account parent", { kind: "account" } as const, "folder-1", "folder-2"],
    ["default shared-drive root", { kind: "sharedDrive", driveId: "drive-1" } as const,
      undefined, "drive-2"],
  ])("rejects a substituted response ID for an %s before observation",
    async (_name, scope, requestedId, returnedId) => {
      let { session, prepared, authorizations } = core({
        scope,
        getFile: async () => file({
          id: returnedId, driveId: scope.kind === "sharedDrive" ? scope.driveId : undefined,
          mimeType: FOLDER_MIME_TYPE, trashed: false,
          appProperties: { gadgetsCreationRequestId: "123e4567-e89b-42d3-a456-426614174000" },
          capabilities: { canAddChildren: true },
        }),
      });

      await expect(session.resolveCreationParent(requestedId))
        .rejects.toThrow(new Error("The requested file is outside this Drive binding."));
      expect(prepared).toEqual([]);
      expect(authorizations).toEqual([]);
    });
  it("does not reveal parent properties or commit observation when authorization fails", async () => {
    let prepared: string[][] = [];
    let committed = false;
    let { session } = core({
      getFile: async id => file({ id, mimeType: "application/pdf" }),
      prepareObservation: async ids => {
        prepared.push(ids);
        return { pendingSets: ids, commit: () => { committed = true; } };
      },
      authorize: async () => { throw new Error("denied"); },
    });

    await expect(session.resolveCreationParent("folder-1"))
      .rejects.toThrow("denied");
    expect(prepared).toEqual([["folder-1"]]);
    expect(committed).toBe(false);
  });
});

describe("Drive native sessions", () => {
  const docMime = "application/vnd.google-apps.document";
  const sheetMime = "application/vnd.google-apps.spreadsheet";

  it.each([
    ["account Doc", { kind: "account" } as const, docMime, "Google Doc"],
    ["account Sheet", { kind: "account" } as const, sheetMime, "Google Sheet"],
    ["shared-drive Doc", { kind: "sharedDrive", driveId: "drive-1" } as const,
      docMime, "Google Doc"],
    ["shared-drive Sheet", { kind: "sharedDrive", driveId: "drive-1" } as const,
      sheetMime, "Google Sheet"],
    ["exact-file Doc", { kind: "file", fileId: "file-1" } as const,
      docMime, "Google Doc"],
    ["exact-file Sheet", { kind: "file", fileId: "file-1" } as const,
      sheetMime, "Google Sheet"],
  ])("opens an in-scope native %s", async (_name, scope, mimeType, description) => {
    let { session, getFile } = core({
      scope,
      getFile: async id => file({
        id,
        mimeType,
        ...(scope.kind === "sharedDrive" ? { driveId: scope.driveId } : {}),
      }),
    });

    await expect(session.openNativeFile("file-1", mimeType, description))
      .resolves.toBe("file-1");
    expect(getFile).toHaveBeenCalledWith("file-1");
  });

  it("rejects another exact-file ID before calling Google", async () => {
    let { session, getFile } = core({ scope: { kind: "file", fileId: "file-1" } });

    await expect(session.openNativeFile("file-2", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(getFile).not.toHaveBeenCalled();
  });

  it("rejects a foreign shared-drive file without authorizing or tracking it", async () => {
    let { session, prepared, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      getFile: async id => file({ id, driveId: "drive-2", mimeType: docMime }),
    });

    await expect(session.openNativeFile("foreign", docMime, "Google Doc"))
      .rejects.toThrow(/outside this Drive binding/);
    expect(prepared).toEqual([]);
    expect(authorizations).toEqual([]);
  });

  it.each([403, 404])(
    "normalizes a %s shared-drive probe failure without authorizing or tracking it",
    async status => {
      let { session, prepared, authorizations } = core({
        scope: { kind: "sharedDrive", driveId: "drive-1" },
        getFile: async () => { throw new DriveApiRequestError(status); },
      });

      await expect(session.openNativeFile("foreign", docMime, "Google Doc"))
        .rejects.toThrow(new Error("The requested file is outside this Drive binding."));
      expect(prepared).toEqual([]);
      expect(authorizations).toEqual([]);
    },
  );
  it.each([
    ["wrong native type", sheetMime, undefined],
    ["folder", "application/vnd.google-apps.folder", undefined],
    ["blob", "application/pdf", undefined],
    ["shortcut", "application/vnd.google-apps.shortcut", { targetId: "target-1" }],
  ])("observes a %s before rejecting its MIME type", async (_name, mimeType, shortcutDetails) => {
    let { session, prepared, authorizations, events } = core({
      getFile: async id => file({ id, mimeType, shortcutDetails }),
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toThrow(/not a Google Doc/);
    expect(prepared).toEqual([["file-1"]]);
    expect(authorizations).toEqual([expect.objectContaining({ excludeObservers: ["excluded"] })]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("never follows a shortcut target implicitly", async () => {
    let getFile = vi.fn(async (id: string) => file({
      id,
      mimeType: "application/vnd.google-apps.shortcut",
      shortcutDetails: { targetId: "target-1", targetMimeType: docMime },
    }));
    let { session } = core({ getFile });

    await expect(session.openNativeFile("shortcut-1", docMime, "Google Doc"))
      .rejects.toThrow(/not a Google Doc/);
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(getFile).toHaveBeenCalledWith("shortcut-1");
  });

  it("forwards observer exclusions and commits only after authorization", async () => {
    let { session, authorizations, events } = core({
      getFile: async id => file({ id, mimeType: docMime }),
    });

    await session.openNativeFile("file-1", docMime, "Google Doc");

    expect(authorizations).toEqual([expect.objectContaining({
      title: "Open Google Doc from Google Drive",
      excludeObservers: ["excluded"],
    })]);
    expect(events).toEqual(["authorize", "commit"]);
  });

  it("leaves a denied file observation pending rather than observed", async () => {
    let state = "unknown";
    let { session } = core({
      getFile: async id => file({ id, mimeType: docMime }),
      prepareObservation: async ids => {
        state = "pending";
        return { pendingSets: ids, commit: () => { state = "observed"; } };
      },
      authorize: async () => { throw new Error("denied"); },
    });

    await expect(session.openNativeFile("file-1", docMime, "Google Doc"))
      .rejects.toThrow("denied");
    expect(state).toBe("pending");
  });
});

describe("Drive search validation", () => {
  it("requires at least one populated search filter", async () => {
    let { session } = core();
    await expect(session.search({ namePrefix: "   " })).rejects.toThrow(/at least one filter/);
  });

  it("requires strict RFC 3339 timestamps and an increasing range", async () => {
    let { session } = core();
    await expect(session.search({ modifiedAfter: "yesterday" })).rejects.toThrow(/RFC 3339/);
    await expect(session.search({
      modifiedAfter: "2026-02-01T00:00:00Z",
      modifiedBefore: "2026-01-01T00:00:00Z",
    })).rejects.toThrow(/modifiedAfter.*modifiedBefore/);
  });

  it("uses Drive relevance order only for full-text search", async () => {
    let { session, listFiles } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "local", driveId: "drive-1" })],
    });
    await (await session.search({ fullTextContains: "budget" })).next();
    expect(listFiles).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: null,
      corpus: { kind: "drive", driveId: "drive-1" },
    }));
  });

  it("rejects search on a file-scoped binding without listing", async () => {
    let { session, listFiles } = core({ scope: { kind: "file", fileId: "file-1" } });
    await expect(session.search({ namePrefix: "plan" })).rejects.toThrow(/getEntry/);
    expect(listFiles).not.toHaveBeenCalled();
  });
});

describe("Drive observation authorization", () => {
  it("does not commit an observation when authorization is denied", async () => {
    let { session, events } = core({
      authorize: async () => {
        throw new Error("denied");
      },
    });

    await expect((await session.list()).next()).rejects.toThrow(/denied/);
    expect(events).toEqual(["authorize"]);
  });

  it("includes the binding scope and a truncated query in the description", async () => {
    let longText = "salary-review-".repeat(8);
    let { session, authorizations } = core({
      scope: { kind: "sharedDrive", driveId: "drive-1" },
      files: [file({ id: "local", driveId: "drive-1" })],
    });

    await (await session.search({ namePrefix: "plan", fullTextContains: longText })).next();
    let observation = authorizations[0];
    expect(observation.title).toBe("Read Google Drive metadata");
    expect(observation.title).not.toContain(longText);
    expect(observation.title).not.toContain("plan");
    expect(observation.description).toContain("shared drive drive-1");
    expect(observation.description).toContain('name starts with "plan"');
    expect(observation.description).toContain("salary-review-");
    expect(observation.description).not.toContain(longText);
    expect(observation.description.length).toBeLessThanOrEqual(240);
  });
});
