import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { resolveBinEntry } from "../../../scripts/bin-entry.js";

const WORKSHOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../workshop-backend");
const WATCHDOG = resolve(WORKSHOP_DIR, "../../scripts/with-timeout.ts");
const VALIDATED_ENTRY = join(WORKSHOP_DIR, ".wrangler/validate/src/server.ts");

function runNode(args: string[]): void {
  execFileSync(process.execPath, [
    WATCHDOG, "--idle", "60", "--max", "600", "--", process.execPath, ...args,
  ], { cwd: WORKSHOP_DIR, stdio: "inherit" });
}

function buildWorkshop(): void {
  runNode(["scripts/build-format-blueprints.mjs"]);
  runNode(["build-browser-runtime.mjs"]);
  const validator = resolveBinEntry(WORKSHOP_DIR, "capnweb-validate");
  if (validator === null) throw new Error("Cannot find the capnweb-validate executable");
  runNode([validator, "build", "--out", ".wrangler/validate"]);
}

/** Share one validated Worker build across isolated test-file processes. */
export default function setup(project: TestProject): () => void {
  if (!existsSync(VALIDATED_ENTRY)) {
    throw new Error("The integration-test Workshop build did not produce its validated entrypoint");
  }
  process.env.WORKSHOP_INTEGRATION_PREBUILT = "1";
  project.onTestsRerun(buildWorkshop);
  return () => { delete process.env.WORKSHOP_INTEGRATION_PREBUILT; };
}
