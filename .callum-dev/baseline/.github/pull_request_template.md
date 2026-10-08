# Why

<!--
The problem this solves, in plain language, for a head of engineering rather than an engineer.
Two or three short paragraphs at most. Lead with the user-visible or team-visible consequence,
not the code. No file paths, function names or low-level detail unless they are the point.
Never use the em dash; use a plain dash "-" instead.
-->

# What this does

<!--
What changes, described by outcome rather than by file. Short paragraphs, no changelog-style
file lists. If there is a judgement call, a trade-off, or a caveat the reviewer should look at
closely, add a "## Worth reviewing carefully" subsection here and say so plainly; otherwise omit it.
If the change has a known limitation or deliberately leaves something for later, add a
"## Limitation" subsection; otherwise omit it.
-->

# Evidence

<!--
How we know it works, stated honestly. Only report verification that actually happened, as
recorded in the intent or commits - never invent tests or results.
For UI changes: copy every screenshot or clip image link (e.g. ![description](https://...))
from the intent verbatim, one per line, each with a one-line caption. Do not alter the URLs.
If the change could only be validated statically (e.g. container or CI config), say so plainly
and name what will prove it for real.
-->

# Linked issue

<!--
Exactly one line. Take N from the branch name's "issue-<N>-" segment.
- Default: write `Closes #N` alone on the line.
- If the intent says the issue must stay open (research-only, under review, or one part of a
  multi-part issue): write `Refs #N` instead.
Anywhere else in this description, never put close/closes/fix/fixes/resolve/resolves directly
before an issue number - GitHub treats that as a closing reference even when negated.
-->
