// The answers of the designer, the builder and the fixer (docs/factory-loop/v2/SPEC.md 8.1, 8.7,
// 9.7): `design-v2` (a brief, a question or a split with its children; named so beside v1's
// `design` until the delete wave), `build` (the PR's title, summary and evidence, or that it
// cannot, with a reason) and `fix` (each finding fixed or declined, with reasons).
//
// Each contract is { check(input, job), summary(input) }: check gives { ok: true, outcome } or
// every problem at once, as contract.mjs's checks do; summary is the answer script's few words on
// what it recorded. contract.mjs imports this module, so the loop and bin/factory-answer check
// alike. ES2023 alone, nothing of Node or the engine. Its types are contracts-work.d.mts's.
//
// STUB of build unit U1. U5 fills it; until then every answer is refused.

function notBuilt(name) {
  return Object.freeze({
    check: () => ({ ok: false, problems: [`the ${name} contract is not built yet (U5), so no ${name} answer can be recorded`] }),
    summary: () => `${name} answer`,
  })
}

export const CONTRACTS = Object.freeze({ 'design-v2': notBuilt('design-v2'), build: notBuilt('build'), fix: notBuilt('fix') })
