import { describe, expect, it } from "vitest";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { accountCoversVendorResources } from "../src/provisioning-policy.js";

function resource(urlPattern: string, title = urlPattern): SupportedResource {
  return { urlPattern, title, description: title };
}

describe("accountCoversVendorResources", () => {
  it("detects a stored account capability that predates a new resource type", () => {
    let file = resource("https://data.example/files/:fileId", "Data File");
    let library = resource("https://data.example/library", "Data Library");

    expect(accountCoversVendorResources([file], [file, library])).toBe(false);
    expect(accountCoversVendorResources([file, library], [file, library])).toBe(true);
  });

  it("uses the URL pattern as the stable resource-type identity", () => {
    let oldResource = resource("https://data.example/library", "Old title");
    let renamedResource = resource("https://data.example/library", "New title");

    expect(accountCoversVendorResources([oldResource], [renamedResource])).toBe(true);
    expect(accountCoversVendorResources([oldResource], [])).toBe(true);
  });
});
