import { describe, expect, it } from 'vitest'
import { mergeAvailableGatekeeperVendors } from './gatekeeper-vendor-list'

describe('mergeAvailableGatekeeperVendors', () => {
  it('lists an ambient vendor with resources only once', () => {
    const resourceVendor = { id: 'custom', source: 'resources' }
    const addableVendor = { id: 'custom', source: 'ambient' }

    expect(mergeAvailableGatekeeperVendors([resourceVendor], [addableVendor])).toEqual([
      resourceVendor,
    ])
  })

  it('keeps ambient-only vendors in their original order', () => {
    const resourceVendor = { id: 'google', source: 'resources' }
    const contextVendor = { id: 'context', source: 'ambient' }
    const schedulerVendor = { id: 'scheduler', source: 'ambient' }

    expect(
      mergeAvailableGatekeeperVendors(
        [resourceVendor],
        [contextVendor, schedulerVendor],
      ),
    ).toEqual([resourceVendor, contextVendor, schedulerVendor])
  })
})
