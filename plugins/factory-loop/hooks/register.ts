// factory-loop: the issue orchestrator as one code loop (docs/factory-loop/SPEC.md).
//
// This build carries the pure plan (plan.ts) and its tests only. The observe adapters, the
// executors and the pass driver come in phase 3 of the conversion, so this module loads and
// registers nothing: installing the plugin today changes no session.
import type { Register } from 'claude-code'

export const register: Register = () => {}
