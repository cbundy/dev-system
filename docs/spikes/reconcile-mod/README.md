# reconcile-spike (archived experiment)

Results: [FINDINGS.md](FINDINGS.md), with the raw log in [evidence/log.jsonl](evidence/log.jsonl).
Original follow-up brief: [CONVERSION-BRIEF.md](CONVERSION-BRIEF.md).

Moved here on 2026-10-16 from the `spike/reconcile-mod` branch, where it ran. Runtime paths and
workspace commands in the findings describe that original setup, not this archive's location.
The conclusions went into [the v1 loop spec](../../factory-loop/SPEC.md)
and [its decisions](../../factory-loop/DECISIONS.md).

Investigated one question before implementation: can a Claude Code mod (a hooks module plugin) drive
the orchestrator loop inside a Remote Control session? It does nothing to any repo. It only
logs what it observes and shows its state in the session title.

See [the findings](FINDINGS.md#3-checks-and-results) for the checks and their results,
[the original setup](FINDINGS.md#2-the-spike-setup) for loading details, and
[reproducing](FINDINGS.md#8-reproducing) for the original workspace commands.
