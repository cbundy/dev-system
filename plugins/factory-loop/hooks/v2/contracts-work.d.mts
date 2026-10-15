// The types of contracts-work.mjs. contract.mjs imports its CONTRACTS.
import type { V2Contract } from '../contract.mjs'

export const CONTRACTS: Readonly<Record<'design-v2' | 'build' | 'fix', V2Contract>>
