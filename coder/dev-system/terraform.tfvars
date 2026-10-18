# The homelab's values for this template's variables (main.tf), committed so
# that no push can drop one. `coder templates push` reads terraform.tfvars from
# the template directory on every push, so coder/push.sh (and even a plain
# `coder templates push`) applies all of them, to dev-system and orchestrator
# alike. A --variable flag overrides a value here for one push: push.sh sets
# remote_control_default_mode per template, and push-next.sh always clears
# template_tester_secrets_dir, so dev-system-next workspaces never get the
# Template Admin token.

# The Docker hosts a workspace can be created on (a JSON list in a string, because
# Coder's tfvars parser cannot read a list of objects). Order matters: the first is the
# default and the host of every workspace from before the choice, so only append; never
# reorder, rename a value or remove an entry a workspace uses. The Coder server's ssh
# config supplies the key. Host 1 is the workspace LXC (cbundy/network#141).
docker_hosts = <<-EOT
[
  {"value": "host-1", "name": "Coder host 1", "url": "ssh://coder@192.168.1.245"},
  {"value": "host-2", "name": "Coder host 2", "url": "ssh://coder@192.168.1.246"}
]
EOT

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

# The Coder CLI login token, mounted only into workspaces with the coder_login
# parameter on. Inert until the directory is set up (see "Coder CLI login
# (opt-in)" in README.md).
coder_login_secrets_dir = "/etc/dev-system/coder-login"

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

# The per-workspace token folders for the "GitHub login: This workspace's own token"
# choice (see "Sharing one gh login" in README.md): <dir>/<owner>/<workspace>/gh-token,
# for a workspace that works as another GitHub account. Kept out of secrets_dir, which
# every workspace mounts.
workspace_secrets_dir = "/etc/dev-system/workspace-secrets"
