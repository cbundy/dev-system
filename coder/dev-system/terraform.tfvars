# The homelab's values for this template's variables (main.tf), committed so
# that no push can drop one. `coder templates push` reads terraform.tfvars from
# the template directory on every push, so coder/push.sh (and even a plain
# `coder templates push`) applies all of them, to dev-system and orchestrator
# alike. A --variable flag overrides a value here for one push: push.sh sets
# remote_control_default_mode per template, and push-next.sh always clears
# template_tester_secrets_dir, so dev-system-next workspaces never get the
# Template Admin token.

# The workspace LXC (cbundy/network#141); the Coder server's ssh config supplies the key.
docker_host = "ssh://coder@192.168.1.245"

# The OTLP collector: Claude Code and codex telemetry from every workspace.
otlp_endpoint = "http://192.168.1.10:4318"

# Whose GitHub text the factory trusts (cbundy/dev-system#307), as
# CALLUM_FLOW_TRUSTED_AUTHORS in every workspace of both templates: login:numeric_id,
# verified with `gh api users/cbundy --jq .id`. The image bakes no list.
trusted_authors = "cbundy:13131067"

# The Template Admin token for push-next.sh, mounted only into workspaces with
# the template_testing parameter on. Inert until the directory is set up (see
# "Testing template changes from a workspace" in README.md).
template_tester_secrets_dir = "/etc/dev-system/template-tester"

# Credentials for private per-repo images (see "Private images" in README.md). The
# dev-system and Orchestrator templates were pushed with this path by hand; setting it here
# keeps every push, orchestrator-loop included, able to pull a private image.
registry_auth_config = "/run/secrets/ghcr-config.json"

# The volume for the "GitHub login: shared" workspace choice, its default (see "Sharing
# one gh login" in README.md): GitHub keeps at most 10 tokens per user for the GitHub CLI
# app, so with a login per workspace each new sign-in revoked the oldest workspace's
# token. A workspace that picks private gets a login of its own.
gh_volume_name = "dev-system-gh"

# The volume for the "Claude login: shared" workspace choice (see "Sharing one Claude
# login" in README.md). Each workspace picks shared or private (the default); shared
# ones use one Claude login and keep their own history and settings.
claude_auth_volume_name = "dev-system-claude-auth"
