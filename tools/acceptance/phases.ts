export type AcceptancePhase = 'permissions' | 'lifecycle' | 'final'

export function casesForPhase<T>(cases: readonly T[], phase: AcceptancePhase): readonly T[] {
  if (cases.length !== 16) throw new Error('The acceptance matrix must contain exactly 16 budgeted cases.')
  const [start, end] = phase === 'permissions' ? [0, 10] : phase === 'lifecycle' ? [10, 14] : [14, 16]
  return cases.slice(start, end)
}

export function assertPhaseMayStart(phases: Partial<Record<AcceptancePhase, string>>, phase: AcceptancePhase): void {
  const prior: AcceptancePhase | undefined = phase === 'permissions' ? undefined : phase === 'lifecycle' ? 'permissions' : 'lifecycle'
  if (phases[phase] && phases[phase] !== 'pending') throw new Error(`Phase ${phase} was already started; it cannot be replayed.`)
  if (prior && phases[prior] !== 'completed') throw new Error(`Phase ${phase} requires completed phase ${prior}.`)
}

export function assertLivePreflight(readiness: string, coldstartVerified: boolean): void {
  if (readiness !== 'ready') throw new Error('This run has not passed its zero-prompt preflight.')
  if (!coldstartVerified) throw new Error('This run has not passed the bound two-MCP cold-start check.')
}

export function assertZeroPromptPreflightRetry(input: {
  readiness: string
  phases: Partial<Record<AcceptancePhase, string>>
  previousPrompts: number
  previousReservations: number
  ledgerUnchanged: boolean
  serviceMatches: boolean
  pathsMatch: boolean
}): void {
  if (input.readiness !== 'blocked' || Object.values(input.phases).some((state) => state !== undefined && state !== 'pending')
    || input.previousPrompts !== 0 || input.previousReservations !== 0 || !input.ledgerUnchanged || !input.serviceMatches || !input.pathsMatch) {
    throw new Error('Blocked preflight cannot be retried unless the same run is unchanged, zero-prompt, and has no started phases.')
  }
}
