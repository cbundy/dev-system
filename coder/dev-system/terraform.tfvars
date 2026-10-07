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

# The Template Admin token for push-next.sh, mounted only into workspaces with
# the template_testing parameter on. Inert until the directory is set up (see
# "Testing template changes from a workspace" in README.md).
template_tester_secrets_dir = "/etc/dev-system/template-tester"

# Uncomment for private per-repo images (see "Private images" in README.md).
# registry_auth_config = "/etc/coder/registry/config.json"

# Uncomment to share one gh login between all workspaces (see "Sharing one gh
# login" in README.md).
# gh_volume_name = "dev-system-gh"
