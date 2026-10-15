// The triage agent's answer (docs/factory-loop/v2/SPEC.md 5.2): `triage`, one choice of the menu
// (retry, fix, redesign, park, drop), its reason, and the instructions or the question the choice
// needs, each within its limit, and no other field.
//
// Each contract is { check(input, job), summary(input) }: check gives { ok: true, outcome } or
// every problem at once, as contract.mjs's checks do; summary is the answer script's few words on
// what it recorded. contract.mjs imports this module, so the loop and bin/factory-answer check
// alike. ES2023 alone, nothing of Node or the engine. Its types are contracts-triage.d.mts's.
//
// STUB of build unit U1. U2 fills it; until then every answer is refused.

function notBuilt(name) {
  return Object.freeze({
    check: () => ({ ok: false, problems: [`the ${name} contract is not built yet (U2), so no ${name} answer can be recorded`] }),
    summary: () => `${name} answer`,
  })
}

export const CONTRACTS = Object.freeze({ triage: notBuilt('triage') })
