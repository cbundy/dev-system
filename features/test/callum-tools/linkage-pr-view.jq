# The stub `gh pr view` answer for check-pr-linkage.test.sh and fix-linkage.test.sh,
# shared so the two suites cannot drift. Not a test itself: it does not match *.test.sh.
# Inputs (--rawfile / --arg): head, base, body (the stub state files), api (the body
# the API derives closingIssuesReferences from; empty means the real body).
# Equivalent to the node program the stubs used to start on every call; the PR that
# introduced this file records the byte-for-byte parity check.
(if $api == "" then $body else $api end) as $apiBody
| ($base | rtrimstr("\n")) as $baseRef
| {
    headRefName: ($head | rtrimstr("\n")),
    baseRefName: $baseRef,
    body: $body,
    closingIssuesReferences: (
      if $baseRef == "main"
      then [ $apiBody | match("\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*(?:([\\w.-]+)/([\\w.-]+))?#(\\d+)\\b"; "gi")
             | .captures | {number: (.[2].string | tonumber),
                             repository: {owner: {login: (.[0].string // "local")}, name: (.[1].string // "repo")}} ]
        | sort_by(.number)
      else [] end)
  }
