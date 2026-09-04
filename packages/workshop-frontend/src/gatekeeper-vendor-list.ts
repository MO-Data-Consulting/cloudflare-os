export function mergeAvailableGatekeeperVendors<T extends { id: string }>(
  vendors: T[],
  addable: T[],
): T[] {
  const byId = new Map<string, T>()
  for (const vendor of [...vendors, ...addable]) {
    if (!byId.has(vendor.id)) byId.set(vendor.id, vendor)
  }
  return [...byId.values()]
}
