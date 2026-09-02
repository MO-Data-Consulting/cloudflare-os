import { RpcTarget, type RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type {
  AccountDescription, SupportedResource, VendorDescription,
} from '@gadgets/workshop-shared/gatekeeper'

/** Everything the backend sends about one connected account. */
export interface AccountEvent {
  id: number
  description: AccountDescription
  vendor: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
  vendorId: string
}

export interface AccountHandlers {
  add(event: AccountEvent): void
  remove(id: number): void
  ready?(): void
}

/**
 * Gadget connection pickers need forced ambient accounts too. The ordinary Connectors page hides
 * those accounts because users cannot manage or disconnect them, but a gadget still needs to bind
 * their resources. Keeping this option here prevents individual pickers from silently falling back
 * to an OAuth flow that an auto-provisioned vendor does not have.
 */
export function subscribeConnectionAccounts(
  authenticatedApi: RpcStub<AuthenticatedApi>,
  subscriber: ConnectedAccountsSubscriber,
) {
  return authenticatedApi.subscribeConnectedAccounts(subscriber, {
    includeForcedAutoProvisionedAccounts: true,
  })
}

/**
 * The one client-side implementation of the connected-accounts subscription protocol. After a
 * Durable Object reset the session re-registers this subscriber and the restarted object
 * replays `add` per current account, then `ready()` — so handlers must treat `add` as an
 * upsert and keep `ready` (optional) idempotent.
 *
 * Accepted staleness: an account removed while the registration was dead ghosts until the
 * component re-subscribes. Removes have exactly one source today, the owner's own disconnect
 * (census note at dbSubscriber.remove in workshop-backend's user.ts). A replay-boundary prune
 * lived here once and was deleted: the DO's replay is lossy by design, so pruning against it
 * removed live accounts more often than ghosts. Reconsider if a new remove path appears.
 */
export class AccountsSubscriberAdapter extends RpcTarget implements ConnectedAccountsSubscriber {
  #handlers: AccountHandlers

  constructor(handlers: AccountHandlers) {
    super()
    this.#handlers = handlers
  }

  add(id: number, description: AccountDescription, vendor: VendorDescription,
      supportedResources: SupportedResource[] = [], credentialsValid: boolean = true,
      vendorId: string = ''): void {
    this.#handlers.add({ id, description, vendor, supportedResources, credentialsValid, vendorId })
  }

  remove(id: number): void {
    this.#handlers.remove(id)
  }

  ready(): void {
    this.#handlers.ready?.()
  }
}
