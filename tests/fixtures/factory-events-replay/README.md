# Replay corpus

`old-rows.jsonl`: 128 rows of the development `factory.events` table (the old event store), one JSON
object per line with `ts` (the stored second, UTC), `device`, `repo`, `seq` and `raw` (the old line,
verbatim). It is the contiguous window 2026-10-16T02:00:00Z up to 02:30:00Z, all devices, taken on
2026-10-17. It holds four full v2 loop issue lifecycles (claim to merge on dev-system-scratch, issues
48, 49, 52 and 53), usage, loop entries, reviews and the skipped `delegated` and `merge_ready` lines.

Nothing was scrubbed beyond a scan: the window was searched for tokens, passwords, URLs with
credentials and key prefixes, and held none. The rows carry session ids, device names and repo names only.

`tests/factory-events-replay.test.js` loads it into a throwaway old-format `factory.events` and replays it.

Refresh (the window is fixed so the test's counts stay stable; refresh only to change the window):

```
psql "$AGENTSVIEW_PG_URL" -At -c "select json_build_object('ts', to_char(ts at time zone 'utc','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'device', device, 'repo', repo, 'seq', seq, 'raw', raw)::text from factory.events where ts >= '2026-10-16T02:00:00Z' and ts < '2026-10-16T02:30:00Z' order by ts, device, seq"
```

Re-serialise each line with `JSON.stringify`, re-scan for secrets, and update the counts in the test.
