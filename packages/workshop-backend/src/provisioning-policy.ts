// The provisioning policy for auto-provisioning ("ambient") gatekeepers — those that mint a connected
// account with no OAuth flow (VendorDescription.autoProvisionsAccount, e.g. the Context Library).
//
// Each such vendor has a three-state mode (see AmbientGatekeeperMode), set per deployment by the
// admin and stored in AdminConfig.ambientGatekeeperModes:
//   - 'disabled': not available; no account is provisioned, and any existing one stays dormant.
//   - 'optional': users opt in from the Connectors page; not forced on anyone. THE DEFAULT — we don't
//                 impose ambient authority on every user unless an admin explicitly turns it on.
//   - 'enabled':  auto-provisioned for every user (forced); they can't remove it.
//
// These helpers are the single chokepoint for that decision; UserDurableObject reads AdminConfig and
// calls them when provisioning, listing, and surfacing ambient accounts.

import { AmbientGatekeeperMode } from "@gadgets/workshop-shared/api";
import type { SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { AdminConfig } from "./admin-config.js";

export const DEFAULT_AMBIENT_GATEKEEPER_MODE: AmbientGatekeeperMode = "optional";

/**
 * The configured mode for an ambient vendor, defaulting to "optional" when the admin hasn't set one.
 * Tolerates a config persisted before this field existed (ambientGatekeeperModes may be undefined).
 */
export function ambientGatekeeperMode(config: AdminConfig, vendorId: string): AmbientGatekeeperMode {
  return config.ambientGatekeeperModes?.[vendorId.toLowerCase()] ?? DEFAULT_AMBIENT_GATEKEEPER_MODE;
}

/**
 * Whether this vendor's account is auto-provisioned for every user ("enabled" mode). Such accounts
 * are "forced": created for everyone, not user-removable, and hidden from the Connectors list.
 * ("optional" accounts are user-managed; "disabled" ones aren't offered.)
 */
export function shouldAutoProvisionAccount(config: AdminConfig, vendorId: string): boolean {
  return ambientGatekeeperMode(config, vendorId) === "enabled";
}

/**
 * Whether an existing ambient account exposes every resource type its currently-deployed vendor
 * advertises. Stored WorkerEntrypoint capabilities can remain pinned to the Worker version that
 * created them, so an otherwise healthy account may predate a newly-added resource type. Resource
 * patterns are the stable type identity; titles and descriptions can change without needing a new
 * account.
 */
export function accountCoversVendorResources(
    accountResources: SupportedResource[], vendorResources: SupportedResource[]): boolean {
  const accountPatterns = new Set(accountResources.map(resource => resource.urlPattern));
  return vendorResources.every(resource => accountPatterns.has(resource.urlPattern));
}
