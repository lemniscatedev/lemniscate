export interface CostState {
  quantity: bigint;
  cost: bigint;
  realized: bigint;
}

export function emptyCostState(): CostState {
  return { quantity: 0n, cost: 0n, realized: 0n };
}

export function addAtCost(state: CostState, quantity: bigint, cost: bigint): void {
  state.quantity += quantity;
  state.cost += cost;
}

/** Remove remaining cost proportionally, consuming rounding dust on a full exit. */
export function removeAtAverageCost(state: CostState, requested: bigint): bigint {
  if (state.quantity <= 0n || requested <= 0n) return 0n;
  const quantity = requested < state.quantity ? requested : state.quantity;
  const cost = quantity === state.quantity ? state.cost : (state.cost * quantity) / state.quantity;
  state.quantity -= quantity;
  state.cost -= cost;
  return cost;
}
