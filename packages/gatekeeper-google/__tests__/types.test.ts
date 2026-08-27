/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript6";
import {
  DOCS_TYPES_MODULE_PREFIX, DRIVE_TYPES_MODULE_PREFIX, stripTypeModulePrefix,
} from "../src/type-bundle";

const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");

function sourcePath(name: string): string {
  return join(SOURCE_DIR, name);
}

function source(name: string): string {
  return readFileSync(sourcePath(name), "utf8");
}

function compileAgentTypes(sourceText: string): string[] {
  const fileName = "/agent-types.ts";
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };
  const baseHost = ts.createCompilerHost(options);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: name => name === fileName || baseHost.fileExists(name),
    getSourceFile: (name, languageVersion, onError, shouldCreateNewSourceFile) =>
      name === fileName
        ? ts.createSourceFile(name, sourceText, languageVersion, true)
        : baseHost.getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile),
    readFile: name => name === fileName ? sourceText : baseHost.readFile(name),
  };
  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program).map(diagnostic =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("embedded agent declarations", () => {
  it("compiles the exact Google Doc agent declaration bundle without module dependencies", () => {
    const types = [
      source("docs-read-types.txt"),
      stripTypeModulePrefix(source("docs-types.txt"), DOCS_TYPES_MODULE_PREFIX),
    ].join("\n");

    expect(compileAgentTypes(types)).toEqual([]);
  });

  it("compiles the exact Google Drive agent declaration bundle without module dependencies", () => {
    const types = [
      source("docs-read-types.txt"),
      stripTypeModulePrefix(source("docs-types.txt"), DOCS_TYPES_MODULE_PREFIX),
      source("sheets-types.txt"),
      stripTypeModulePrefix(source("drive-types.txt"), DRIVE_TYPES_MODULE_PREFIX),
    ].join("\n");

    expect(compileAgentTypes(types)).toEqual([]);
  });

  it("keeps the Drive declaration aligned after module-only imports", () => {
    const modulePrefix =
      'import type { GoogleDocReadSession } from "./docs-read-types";\n' +
      'import type { GoogleDocSession } from "./docs-types";\n' +
      'import type { GoogleSpreadsheetSession } from "./sheets-types";\n\n';
    const driveTypes = source("drive-types.d.ts");
    expect(driveTypes.startsWith(modulePrefix)).toBe(true);
    expect(source("drive-types.txt")).toBe(driveTypes);
  });

  it("keeps Drive Docs authority read-only", () => {
    const readTypes = source("docs-read-types.d.ts");
    expect(readTypes).toContain("export interface GoogleDocReadSession");
    expect(readTypes).not.toContain("replaceText");
    expect(readTypes).not.toContain("appendText");
    expect(source("docs-types.d.ts")).toContain(
      "export interface GoogleDocSession extends GoogleDocReadSession",
    );
  });

  it("keeps arbitrary Drive Docs read-only while created Docs are writable", () => {
    const driveTypes = source("drive-types.d.ts");
    expect(driveTypes).toContain(
      "openGoogleDoc(fileId: string): Promise<GoogleDocReadSession>",
    );
    expect(driveTypes).toContain(
      "openCreatedGoogleDoc(handle: DriveCreationHandle<\"googleDoc\">): Promise<GoogleDocSession>",
    );
    expect(driveTypes).toContain(
      "openGoogleSheet(fileId: string): Promise<GoogleSpreadsheetSession>",
    );
  });

  it("splits Drive creation authority from read-only sessions", () => {
    const types = [
      source("docs-read-types.txt"),
      stripTypeModulePrefix(source("docs-types.txt"), DOCS_TYPES_MODULE_PREFIX),
      source("sheets-types.txt"),
      stripTypeModulePrefix(source("drive-types.txt"), DRIVE_TYPES_MODULE_PREFIX),
      `
        declare const account: GoogleDriveSession;
        declare const sharedDrive: GoogleDriveSession;
        declare const file: GoogleDriveReadSession;
        declare const handle: DriveCreationHandle<"googleDoc">;
        declare const folderHandle: DriveCreationHandle<"folder">;
        declare const nestedDoc: GoogleDocReadSession;
        declare const directDoc: GoogleDocSession;
        declare const sheet: GoogleSpreadsheetSession;

        const readDoc: Promise<GoogleDocReadSession> = account.openGoogleDoc("doc-1");
        const createdDoc: Promise<GoogleDocSession> = account.openCreatedGoogleDoc(handle);
        const docCreation: Promise<DriveCreationHandle<"googleDoc">> =
          account.createGoogleDoc({ name: "Quarterly plan" });
        const sheetCreation: Promise<DriveCreationHandle<"googleSheet">> =
          account.createGoogleSheet({ name: "Forecast", parentId: "folder-1" });
        const folderCreation: Promise<DriveCreationHandle<"folder">> =
          account.createFolder({ name: "Archive" });
        // @ts-expect-error Folder handles cannot open writable Docs.
        account.openCreatedGoogleDoc(folderHandle);
        account.getCreationResult({ id: 1, kind: "googleDoc", name: "Quarterly plan" });
        sharedDrive.createGoogleDoc({ name: "Quarterly plan" });
        sharedDrive.createGoogleSheet({ name: "Forecast" });
        sharedDrive.createFolder({ name: "Archive", parentId: "folder-2" });
        sharedDrive.getCreationResult({ id: 2, kind: "folder", name: "Archive" });

        // @ts-expect-error Exact-file Drive sessions remain read-only.
        file.createGoogleDoc({ name: "Denied" });
        // @ts-expect-error Exact-file Drive sessions cannot query creation actions.
        file.getCreationResult({ id: 1, kind: "googleDoc", name: "Denied" });
        // @ts-expect-error Exact-file Drive sessions cannot open writable created Docs.
        file.openCreatedGoogleDoc(handle);
        // @ts-expect-error Nested Docs sessions expose no Drive creation methods.
        nestedDoc.createFolder({ name: "Denied" });
        // @ts-expect-error Direct Docs bindings retain only their existing document API.
        directDoc.createGoogleDoc({ name: "Denied" });
        // @ts-expect-error Nested and direct Sheets sessions expose no Drive creation methods.
        sheet.createGoogleSheet({ name: "Denied" });
      `,
    ].join("\n");

    expect(compileAgentTypes(types)).toEqual([]);
  });
});
