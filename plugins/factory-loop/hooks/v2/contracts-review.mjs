// The reviewer's answer (docs/factory-loop/v2/SPEC.md 8.2): `review`, a verdict (approve, or
// changes with at least one error finding), the findings with ids r<round>-<k>, a summary and a
// bump.
//
// Each contract is { check(input, job), summary(input) }: check gives { ok: true, outcome } or
// every problem at once, as contract.mjs's checks do; summary is the answer script's few words on
// what it recorded. contract.mjs imports this module, so the loop and bin/factory-answer check
// alike. ES2023 alone, nothing of Node or the engine. Its types are contracts-review.d.mts's.
//
// STUB of build unit U1. U6 fills it; until then every answer is refused.

function notBuilt(name) {
  return Object.freeze({
    check: () => ({ ok: false, problems: [`the ${name} contract is not built yet (U6), so no ${name} answer can be recorded`] }),
    summary: () => `${name} answer`,
  })
}

export const CONTRACTS = Object.freeze({ review: notBuilt('review') })
