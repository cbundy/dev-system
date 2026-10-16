# gh-auth spike: findings

Investigation of 2026-10-16, gh 2.102.0 (which builds on `cli/go-gh` v2.16.1, per its `go.mod`),
in the Coder workspace `devsystem`. Source links point at those exact tags. Probes used a scratch
`GH_CONFIG_DIR` and fake tokens only: no `gh auth login`, `refresh` or `logout` was run, and no
GitHub token was created, rotated or revoked.

## Summary

- **Keep one shared gh login as the default, and do not split the login out of gh's config.** gh
  has no setting that moves its login away from its settings, but nothing in the shared directory
  needs to be per workspace. gh keeps its per-machine state elsewhere, in the container's home.
- **Sharing is safe.** gh's tokens (`gho_`) never expire or refresh on their own. The login file
  is only written when someone logs in, refreshes, switches account or logs out. gh writes it in
  place with no lock, so two writes at the very same moment can lose one. In practice that only
  happens when two people sign in at once.
- **A per-workspace shared/private choice is feasible and can be backwards compatible** (default
  shared), but it buys little today. A private login is still the owner's own account with the same
  power, so it does not make a workspace safer. Each private login also uses one of GitHub's 10
  slots for the GitHub CLI app, the limit that forced sharing in the first place.
- **The real need behind "private" is a different or narrower identity.** The GitHub App work
  (#378, #379, #381) covers that better. Its workspace setting should be a per-workspace
  choice, like `claude_login`.

Recommended now: no template or image change. Three small follow-ups are listed at the end
([Recommendation](#5-recommendation)), along with a design brief for a `gh_login` choice in case one
is wanted later.

## 1. What gh keeps in `GH_CONFIG_DIR`

| File | Where | What it holds | Per container? |
|---|---|---|---|
| `hosts.yml` | `GH_CONFIG_DIR` | The login: per host, each account's `oauth_token`, the active `user`, its token copied to the host-level `oauth_token`, and the host's `git_protocol` | No: this is the login |
| `config.yml` | `GH_CONFIG_DIR` | Preferences only: `git_protocol` default, `editor`, `pager`, `prompt`, `browser`, aliases, accessibility and spinner flags, `version` | No: user preferences, nothing machine-specific |
| `state.yml` | `$XDG_STATE_HOME/gh` (else `~/.local/state/gh`) | gh's update-check timestamp | Yes, and already outside `GH_CONFIG_DIR` |
| `device-id` | the same state dir | gh's telemetry device id | Yes, and already outside |
| extensions | `~/.local/state/gh/extensions`, `~/.local/share/gh` | installed extensions | Yes, and already outside |
| caches | `$XDG_CACHE_HOME/gh` | API and run-log caches | Yes, and already outside |

Evidence:

- The real workspace ([evidence/workspace-persist-gh.txt](evidence/workspace-persist-gh.txt)):
  `/persist/gh` is the Docker volume `dev-system-gh` and holds exactly `config.yml` and `hosts.yml`.
  `hosts.yml` has one account (`cbundy`) with a 40-character `gho_` token, stored as plain text.
  `gh auth status` reports `tokenSource: /persist/gh/hosts.yml`. `~/.local/state/gh` holds only
  `device-id`.
- Paths in source: `config.yml` and `hosts.yml` are always `ConfigDir()` joined with a fixed name
  ([go-gh config.go L227-L233](https://github.com/cli/go-gh/blob/v2.16.1/pkg/config/config.go#L227-L233)).
  `ConfigDir()` is `GH_CONFIG_DIR`, else `XDG_CONFIG_HOME/gh`, else `~/.config/gh`
  ([L250-L265](https://github.com/cli/go-gh/blob/v2.16.1/pkg/config/config.go#L250-L265)).
  `StateDir()`, `DataDir()` and `CacheDir()` follow the XDG variables and never `GH_CONFIG_DIR`
  ([L268-L314](https://github.com/cli/go-gh/blob/v2.16.1/pkg/config/config.go#L268-L314)).
  `state.yml` ([ghcmd/cmd.go L325](https://github.com/cli/cli/blob/v2.102.0/internal/ghcmd/cmd.go#L325)),
  `device-id` ([telemetry.go](https://github.com/cli/cli/blob/v2.102.0/internal/telemetry/telemetry.go))
  and extensions ([extension/manager.go L64](https://github.com/cli/cli/blob/v2.102.0/pkg/cmd/extension/manager.go#L64))
  all live in the state or data dir.
- Probe 1 ([evidence/probe-gh-config.out](evidence/probe-gh-config.out)): a config write in an empty
  `GH_CONFIG_DIR` creates only `config.yml` (mode 600).
- Nothing in dev-system writes gh config (no `gh config set`, `gh alias set` or
  `gh extension install` anywhere in the image, plugins, templates or scripts), so `config.yml` is
  gh's defaults.

**Can the login be split from the settings?** gh has no setting for it: there is no variable for the
hosts file's path, and `hosts.yml` always sits beside `config.yml`. A symlink does work, unlike
Claude's `.credentials.json`. gh reads `hosts.yml` with a plain open and writes it in place, both of
which follow a symlink. So `/persist/gh/hosts.yml -> /persist/gh-auth/hosts.yml` keeps the login in
another volume, and the link survives `gh auth switch` and `gh config set` (probe 4). A dangling
link, meaning an empty shared volume, reads as "not logged in". The first write creates the target
file with mode 600 (probe 5). A single file bind-mounted by the runtime would work for the same
reason (in-place writes keep the inode, probe 3), but Docker named volumes cannot be mounted as one
file, so on Coder that would mean a host path.

**Splitting is not worth doing.** As the table shows, gh already keeps its per-container state out
of `GH_CONFIG_DIR`. What is left beside the login is the owner's preferences, which are better
shared. This is unlike Claude, whose config dir mixes the login with per-container history, PIDs
and trust, which is why Claude needed `CLAUDE_SECURESTORAGE_CONFIG_DIR`. A symlink split would add
a seeding and migration step to `dev-init` for no user-visible gain.

**Keyring vs file.** `gh auth login` and `gh auth refresh` try the system keyring first and fall back
to plain text in `hosts.yml` when that fails
([config.go L419-L453](https://github.com/cli/cli/blob/v2.102.0/internal/config/config.go#L419-L453),
[refresh.go L212](https://github.com/cli/cli/blob/v2.102.0/pkg/cmd/auth/refresh/refresh.go#L212);
keyring calls time out after 60s, [keyring.go](https://github.com/cli/cli/blob/v2.102.0/internal/keyring/keyring.go)).
The image has no D-Bus session bus and no secret service, so the token lands in `hosts.yml`, which is
what makes sharing the directory share the login. If an image ever gained a working keyring, new
logins would go into that container's keyring and stop being shared. Passing `--insecure-storage` to
`gh auth login` would pin today's behaviour (follow-up 2 below).

## 2. Is sharing safe?

**Tokens do not expire or refresh.** gh signs in through the GitHub CLI OAuth app's device flow and
stores only an access token. It has no refresh-token handling at all (no `refresh_token`,
`expires_in` or `offline_access` anywhere in gh 2.102.0's source). GitHub's docs say OAuth app tokens
only expire when an app opts in to expiring tokens. Otherwise a token ends only when it is revoked,
or when it goes unused for a year
([Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation),
[Authorizing OAuth apps: expiring access tokens](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).
Despite its name, `gh auth refresh` is a new device-flow sign-in that mints a new token with new
scopes ([refresh.go L49](https://github.com/cli/cli/blob/v2.102.0/pkg/cmd/auth/refresh/refresh.go#L49)).
`gh auth logout` does not revoke anything on GitHub
([logout.go L42](https://github.com/cli/cli/blob/v2.102.0/pkg/cmd/auth/logout/logout.go#L42)).

**When `hosts.yml` is written.** gh writes `hosts.yml` only when the hosts part of its config changed
([go-gh config.go Write, L160-L190](https://github.com/cli/go-gh/blob/v2.16.1/pkg/config/config.go#L160-L190)).
The only code that changes it is `gh auth login`, `refresh`, `switch` and `logout`, plus
`gh config set -h <host>` and a one-off config-version migration. `gh auth status`, `gh auth token`,
`gh auth setup-git` (which writes `~/.gitconfig`) and every ordinary command only read it. So in
normal running nothing writes the shared file.

**How it is written.** In place, not by temp file and rename: `os.OpenFile(..., O_TRUNC)` then a
single write, with no file lock. gh's mutex only guards one process
([writeFile, L329-L344](https://github.com/cli/go-gh/blob/v2.16.1/pkg/config/config.go#L329-L344)).
Probe 3 confirms the inode does not change across `gh config set -h` and `gh auth switch`.
Consequences, from probe 6 and probe 7:

- A reader that opens the file between the truncate and the write sees an empty or partial
  `hosts.yml`. A fast shell reader caught that 4 times in 5,944 reads while a writer ran 150 writes
  back to back. A real `gh` reader, slowed by its own start-up, caught it 0 times in 151 reads. A
  reader that hits the window sees "not logged in" for that one command. The file itself is
  never left broken.
- Two writers at the same moment can lose one update, because each read the old file before
  writing. A `gh auth switch` racing a `gh config set -h` lost one of the two changes in 22 and then 30
  rounds out of 40 (two runs; the saved output is the second). On a shared volume the realistic case is two people signing in at once, from
  two workspaces, within the same few milliseconds. The fix is the one the README already gives:
  sign in again from one workspace.
- A symlinked or bind-mounted single `hosts.yml` keeps working, because in-place writes never
  replace the file (probes 3 and 4). A write by rename would have broken both.

**What sharing does mean.** Everyone who can open a workspace on the volume holds the token and can
act as the owner's GitHub account (already in the README). If GitHub ever revokes that one token,
for example because it leaked into a public repo or was revoked in GitHub's settings, every
workspace loses gh at once, and one sign-in from any workspace restores all of them. dev-login reads
a 401 as "logged out" and offers the sign-in (`gh_login_state` in `images/base/gh.sh`).

The current README's "gh rewrites `hosts.yml` on login, logout or a token refresh" reads as if gh
refreshes tokens by itself. It does not. Follow-up 1 below corrects that wording.

## 3. A per-workspace shared/private choice

**Feasible, and backwards compatible if the default is shared.** It would be the `claude_login`
pattern with the opposite default. Coder gives a parameter's default to an existing workspace on its
next update (#268). So a `gh_login` parameter that defaults to `shared` leaves every current
workspace exactly as it is, with no plan change. (`claude_login` defaults to private because private
was what existed before. For gh, shared is what exists.) A workspace switched to private would stop
mounting the shared volume and would see its own persist volume's `/persist/gh` again. That holds
either the empty directory from the image or an old login from before sharing, which may have been
revoked since. A revoked one shows as logged out and the Log in page offers a new sign-in. No image
change is needed, because the image already treats `/persist/gh` as just a directory. See the
[design brief](#design-brief-a-gh_login-choice-only-if-wanted-later) below.

**The 10-token limit, verified.** GitHub's docs say: "There is a limit of ten tokens that are issued
per user/application/scope combination, and a rate limit of ten tokens created per hour." When an
app creates an eleventh token for the same user and scopes, GitHub revokes one existing token. It
picks the oldest token that has never been used (and is more than a minute old). If every token has
been used, it picks the least recently used one. Hitting the hourly limit revokes nothing; it
prompts the user to re-authorise
([Authorizing OAuth apps: creating multiple tokens](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).

What that means here:

- Every gh sign-in through dev-login asks for the same scopes (`repo`, `read:org`, `gist`,
  `workflow`), as the real workspace's token shows. So every dev-system login, on Coder or on the
  desktop, draws from the same budget of 10. That budget also covers the GitHub CLI on the
  owner's own computers.
- The homelab has 18 workspaces across the three templates (`coder list`, read-only). That is why a
  login per workspace kept revoking the oldest one.
- Because GitHub revokes the least recently used token, the shared token, which every running
  workspace uses all day, is the last to go. A few private workspaces would not endanger it. Their
  own logins would, though: a private workspace left stopped for a while is the first to be
  revoked once more than about 10 logins exist. It then needs a new sign-in on start.
- So shared should stay the default. Private only stays healthy while the total number of private
  logins, plus the shared one, plus the owner's own machines, stays under 10.

**What private would and would not give.** A private login made through the Log in page is the same
GitHub account with the same scopes, only a different token. It does not narrow what an agent in
that workspace can do, and it does not separate the owner's actions from the agents'. It helps in
two cases only:

1. **A workspace that should act as a different GitHub account**, such as a test or machine user,
   which has its own budget of 10.
2. **Isolating sign-outs**: signing out in that workspace does not sign out the others.

Neither is needed today. The first is what the GitHub App identity (#382) is for, done better.

## 4. Alternatives

| Option | Identity and reach | Expiry and refresh | Fit here |
|---|---|---|---|
| **Shared gh login** (today) | The owner's account, `repo` + `workflow` scopes, on every workspace | Never expires; nothing to refresh | Works now. One token for all, so it never runs into the 10-token limit |
| **Private gh login per workspace** | The same account, the same scopes | Never expires, but the least recently used logins are revoked past 10 | Feasible ([section 3](#3-a-per-workspace-sharedprivate-choice)). Little gain, and it spends the budget |
| **`GH_TOKEN` from a secret** (e.g. a file in `/run/secrets/dev-system`, exported by the runtime) | Whatever token is stored: a classic PAT, or a fine-grained PAT scoped to chosen repos | A PAT expires on the date set at creation, or never | gh reads `GH_TOKEN` before `hosts.yml` ([go-gh auth.go L63-L75](https://github.com/cli/go-gh/blob/v2.16.1/pkg/auth/auth.go#L63-L75)). `gh auth login`, `refresh` and `switch` refuse while it is set ([writeable.go](https://github.com/cli/cli/blob/v2.102.0/pkg/cmd/auth/shared/writeable.go)), and dev-login already reports it as state `token` and starts no sign-in. Rotation is by hand, and it is not part of the GitHub CLI app's 10-token budget |
| **Coder external auth** (README, "GitHub through Coder external auth") | The Coder user's linked GitHub account | With an OAuth app: no expiry. With a GitHub App user token: 8 hours, then a refresh ([GitHub docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)) | git over HTTPS already works through `GIT_ASKPASS` when a provider is linked. Setting `GH_TOKEN` from `data.coder_external_auth` freezes the token at build time, so it only suits a non-expiring OAuth app. It is still the owner's identity, and the link becomes required to build |
| **Fine-grained PAT** (through `GH_TOKEN` or `gh auth login --with-token`) | The owner's account, limited to chosen repos and permissions | Optional expiry; "infinite lifetimes are allowed"; at most 50 per user ([Managing PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)) | The only user-token option that narrows what a workspace can touch. Gaps that matter to the factory: no Checks API, no Packages, one organisation per token, no repos where the owner is only a collaborator |
| **GitHub App identity** (#378, #379, #381) | `callum-flow[bot]`, installation tokens limited to the repos the app is installed on | Short-lived (an hour); minted on demand from the app key by `dev-gh-app` (#377) | The right answer to "this workspace should not act as me". No 10-token limit (installation tokens are not OAuth grants). Attributes agent work to the bot. Still waits on the owner creating the app (#376) |

## 5. Recommendation

**Do not add a gh shared/private choice now, and do not split gh's login out of its config.** Keep one
shared gh login as the Coder default and the desktop default, exactly as today.

- Sharing the whole `/persist/gh` is already sharing "only the login", in effect. Everything gh keeps
  per machine lives outside it.
- Sharing is safe: tokens never refresh, and the file is written only on a sign-in, a sign-out or an
  account switch.
- A private login is the same account with the same power. It spends a slot of the 10-token budget,
  and it makes a stopped workspace the first to be logged out.
- When a workspace really should act as someone else, that is the GitHub App identity's job, not
  another user token.

Follow-ups worth doing (none is urgent):

1. **Docs accuracy** (docs only). In `coder/dev-system/README.md`, "Sharing one gh login", reword the
   "Concurrent writes" bullet: gh tokens never refresh or expire on their own. gh writes `hosts.yml`
   only on a sign-in, a refresh, an account switch or a sign-out, in place and without a lock. So
   only two sign-ins at the same moment can collide, and the fix is to sign in again once. In
   `images/base/README.md`, "What is shared and what is per repo", add one sentence: gh's
   per-machine state lives under `~/.local/state/gh`, outside `/persist/gh`, so sharing the
   directory shares only the login and preferences.
2. **Pin the token to the shared file** (image, small). Add `--insecure-storage` to dev-login's
   `gh auth login` and `gh auth refresh` calls. That keeps today's behaviour if a future image or
   runtime ever exposes a keyring, which would otherwise quietly stop the login being shared.
   It needs a matching check in the image's dev-login tests.
3. **For the GitHub App work** (#379): make the workspace's identity a per-workspace parameter
   (like `claude_login`), with `user` as the default, rather than only a template-wide variable. A
   workspace can then opt in to the bot one at a time during the trial (#380). That is the
   per-workspace GitHub choice that is worth having.

### Design brief: a `gh_login` choice (only if wanted later)

If a workspace ever does need its own GitHub login, for example a different account:

- **Template (`coder/dev-system/main.tf`).** Add
  `data "coder_parameter" "gh_login"`, with `count = var.gh_volume_name == "" ? 0 : 1`,
  `default = "shared"`, `mutable = true`, and options "Shared with other workspaces" (`shared`) and
  "Private to this workspace" (`private`). Add
  `local.gh_login_shared = try(data.coder_parameter.gh_login[0].value, "shared") == "shared"`. The
  existing `/persist/gh` dynamic volume's `for_each` becomes
  `var.gh_volume_name != "" && local.gh_login_shared ? [var.gh_volume_name] : []`. Nothing else
  changes: no environment variable, no new volume, no startup-script step.
- **Backwards compatibility.** Every existing workspace gets `shared` on its next update (#268), so
  its plan is unchanged. Clearing `gh_volume_name` still turns sharing off everywhere and hides the
  choice. The `coder/test` suite should assert both: no plan change for a workspace without the
  parameter, and no mount for `private`.
- **Image.** No change. A private workspace uses `/persist/gh` on its own persist volume. dev-login
  already reports a revoked old login as logged out and offers the sign-in.
- **Docs.** Add a short "Private gh login" paragraph under "Sharing one gh login" in the Coder
  README. It should say that a private login is the same account unless someone signs in as
  another. It should explain the 10-token budget, and that idle private workspaces are revoked first.
  It should name `dev-restart-self --parameter gh_login=private` as the way to switch (`coder restart
  --parameter` does not work). On the desktop, nothing is needed: a repo already gets its own gh
  login by mounting its own volume at `/persist/gh`, as documented in `images/base/README.md`.

## What this spike could not verify

- **How many GitHub CLI tokens the owner holds right now.** GitHub shows the GitHub CLI app's grants
  under Settings, Applications, but there is no API for a user's own OAuth tokens, and that page
  was not opened. So the remaining headroom under 10 is not known.
- **A real single-file bind mount.** This container cannot create a mount namespace (`unshare -rm`
  is refused), so no bind mount was tried. That a bind-mounted `hosts.yml` works is inferred from the in-place write (same
  inode, probe 3) and from the source, not from running it.
- **Concurrency across two real containers.** The races were reproduced between processes on one
  filesystem, not across two workspaces on the shared Docker volume. Both see the same ext4 volume
  through a bind mount, so the behaviour should match, but that is not shown.
- **Coder's handling of expiring external-auth tokens.** Coder's docs do not say whether, or when,
  the token behind `data.coder_external_auth` is refreshed. The table relies on the existing README
  for the advice to use a non-expiring OAuth app.
