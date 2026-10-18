# Frozen old saved queries

Copies of the saved queries of docs/metrics.md as they stood before they moved to the factory
database (dev-system#652), one file per block, each reading the old `factory.events` table (and
`nomistakes.*`, which is empty in the compare). `tests/metrics-queries.test.js` runs each one on an
old-format store and the rewritten query of the doc on the new store loaded from the same rows, and
compares the answers.

Do not edit them: they are the answers the rewrite is held to. They are deleted with the old event
path (dev-system#656), together with `extra-old-rows.jsonl` beside this folder's parent.
