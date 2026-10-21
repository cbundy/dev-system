# Coder workspace template "dev-system": one container per workspace from the
# dev-system base image (images/base), on a Docker host reached locally or
# over ssh://. The host is picked per workspace from variable docker_hosts
# (parameter docker_host, immutable: the volumes live on it), and the host-side
# pieces (secrets directories, the shared gh and Claude login volumes) are per
# host. See README.md next to this file. The
# same Terraform is also pushed as the "orchestrator" template, which only
# changes variables: the Remote Control mode default and the long-lived
# session's settings (variables remote_control_*); coder/push.sh holds each
# template's name, look and variables.
#
# Based on Coder's docker starter (coder/coder examples/templates/docker) and
# the preview template that lived in cbundy/network. Differences from the
# starter:
# - no volume over the home directory: the image's tools live under
#   /home/node/.local, and a home volume would freeze them at the first
#   start. State lives where the image README's Kubernetes / Coder contract
#   puts it, one volume per workspace at /persist, plus one at /workspaces
#   for the checkout (dev-init clones DEV_REPO_URL into
#   /workspaces/<repo name>, cbundy/dev-system#77);
# - the agent replaces the image entrypoint, so its startup_script runs
#   dev-init and starts Remote Control, as the image's devcontainer
#   postStartCommand does, in server mode by default when there is a repo;
# - logins without a shell: a "Log in" app proxies dev-login's page and a
#   "Logins" metadata row shows each tool's state;
# - image, CPU, memory, repo, Remote Control mode (default from variable
#   remote_control_default_mode), skip-permissions (bypass) and resume
#   parameters, the session-mode prompts and name format (variables
#   remote_control_*, set per template by coder/push.sh), OTLP telemetry
#   env (variable otlp_endpoint) and pinned provider versions;
# - runtime secrets from a directory on the Docker host (variable
#   secrets_dir), mounted read-only where the image looks for them, so the
#   agentsview session push is on in every workspace once the host has its
#   URL (cbundy/dev-system#103);
# - an opt-in Template Admin token for push-next.sh (variable
#   template_tester_secrets_dir, parameter template_testing), mounted only into
#   workspaces that turn the parameter on (cbundy/dev-system#118);
# - an opt-in Coder CLI login (variable coder_login_secrets_dir, parameter
#   coder_login): a host token directory mounted read-only only into workspaces
#   that turn the parameter on; dev-init logs the coder CLI in from it on each
#   start (cbundy/dev-system#540);
# - an optional shared gh login, chosen per workspace (parameter gh_login,
#   default shared; shared volume named by variable gh_volume_name): a named
#   volume over /persist/gh (cbundy/dev-system#195);
# - an optional shared Claude login, chosen per workspace (parameter
#   claude_login, shared volume named by variable claude_auth_volume_name):
#   only Claude's login directory is shared, so history and settings stay per
#   workspace;
# - optional registry credentials (variable registry_auth_config), read from a
#   file on the Coder server, so private per-repo images can be used.

terraform {
  required_providers {
    coder = {
      source  = "coder/coder"
      version = "2.19.0"
    }
    docker = {
      source  = "kreuzwerker/docker"
      version = "4.6.0"
    }
  }
}

# The Docker hosts a workspace can be created on, as a JSON list in a string: Coder's
# tfvars parser (used by `coder templates push`) accepts only strings, numbers and
# tuples of strings, so a list of objects would fail the push. Each entry has a stable
# `value` (the docker_host parameter's value; never rename or remove one a workspace
# uses), a display `name` and the `url` (unix:///... or ssh://user@host; the Coder
# server's ssh config supplies the key). The first entry is the default, so append only.
variable "docker_hosts" {
  default     = "[{\"value\":\"local\",\"name\":\"Local Docker\",\"url\":\"unix:///var/run/docker.sock\"}]"
  description = "Docker hosts for workspaces: a JSON list of {\"value\", \"name\", \"url\"} objects (url: the local socket, or ssh://user@host). The first is the default; with more than one, a workspace picks its host at creation (parameter docker_host). A string because Coder's tfvars parser cannot read a list of objects."
  type        = string
  validation {
    condition     = can(tolist(jsondecode(var.docker_hosts)))
    error_message = "docker_hosts must be valid JSON that decodes to a list of {\"value\", \"name\", \"url\"} objects."
  }
  validation {
    condition     = try(length(jsondecode(var.docker_hosts)) >= 1, true)
    error_message = "docker_hosts must have at least one entry."
  }
  validation {
    condition = try(alltrue([
      for h in jsondecode(var.docker_hosts) :
      try(h.value != "" && h.name != "" && h.url != "", false)
    ]), true)
    error_message = "Every docker_hosts entry needs a non-empty value, name and url."
  }
  validation {
    condition = try(
      length(distinct([for h in jsondecode(var.docker_hosts) : h.value])) == length(jsondecode(var.docker_hosts)),
      true
    )
    error_message = "The value of every docker_hosts entry must be unique."
  }
}

# What kind of workspace this template makes; coder/push.sh sets it per template.
# It becomes DEV_ROLE in the workspace (cbundy/dev-system#338), also read by the
# session-start health banner (#306).
variable "role" {
  default     = "dev"
  description = "The workspace's role, passed in as DEV_ROLE: dev, or orchestrator."
  type        = string

  validation {
    condition     = contains(["dev", "orchestrator"], var.role)
    error_message = "role must be dev or orchestrator."
  }
}

# How long a workspace stop waits for the factory loop to finish its running steps (the loop's
# wind-down mode, docs/factory-loop/v2/SPEC.md 10.11; cbundy/dev-system#842). Above 0 the template
# adds a stop script (wind-down.sh) that asks each loop to wind down and waits up to this many
# minutes, and the container gets that long plus a minute of Docker stop grace. 0 adds neither, so
# the stop is as before. coder/push.sh sets it per template: 10 for orchestrator-loop, 0 for the rest.
variable "wind_down_minutes" {
  default     = 0
  description = "Minutes a workspace stop waits for the factory loop to wind down. 0 (the default) adds no stop script and no extra container stop grace."
  type        = number

  validation {
    condition     = var.wind_down_minutes >= 0 && var.wind_down_minutes == floor(var.wind_down_minutes)
    error_message = "wind_down_minutes must be a whole number of at least 0."
  }
}

# The image turns Claude Code and codex telemetry export on when
# OTEL_EXPORTER_OTLP_ENDPOINT is set (cbundy/dev-system#68).
variable "otlp_endpoint" {
  default     = ""
  description = "OTLP http/protobuf endpoint for workspace telemetry, e.g. http://otel-gateway:4318. Empty disables export."
  type        = string
}

# The authors whose GitHub issue, PR and comment text the factory trusts
# (cbundy/dev-system#307). The image bakes no list: this variable is the only
# source, so every workspace gets it from the template, and callum-flow-issue-read
# and dev-doctor fail closed when it is missing or malformed.
variable "trusted_authors" {
  default     = ""
  description = "Comma-separated login:numeric_id entries, e.g. cbundy:13131067 (look the id up with: gh api users/<login> --jq .id). Set as CALLUM_FLOW_TRUSTED_AUTHORS in every workspace. Empty leaves it unset, and dev-doctor reports that as a failure."
  type        = string

  validation {
    condition     = var.trusted_authors == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9-]*(\\[bot\\])?:[1-9][0-9]*(,[A-Za-z0-9][A-Za-z0-9-]*(\\[bot\\])?:[1-9][0-9]*)*$", var.trusted_authors))
    error_message = "trusted_authors must be comma-separated login:numeric_id entries with no spaces, e.g. cbundy:13131067."
  }
}

# The Remote Control mode parameter's default, so one Terraform serves both
# templates: dev-system keeps auto, orchestrator pushes session (coder/push.sh).
variable "remote_control_default_mode" {
  default     = "auto"
  description = "Default of the Remote Control mode parameter: auto, session or server."
  type        = string
  validation {
    condition     = contains(["auto", "session", "server"], var.remote_control_default_mode)
    error_message = "remote_control_default_mode must be auto, session or server."
  }
}

# The orchestrator's long-lived session (cbundy/dev-system#164), generic so one
# Terraform serves both templates: coder/push.sh sets these per template, and
# the defaults keep dev-system's behaviour.
variable "remote_control_default_resume" {
  default     = false
  description = "Default of the remote_control_resume parameter: resume the workspace's last Claude conversation on every start (session mode)."
  type        = bool
}

variable "remote_control_default_skip_permissions" {
  default     = false
  description = "Default of the remote_control_skip_permissions parameter."
  type        = bool
}

variable "remote_control_prompt" {
  default     = ""
  description = "Session mode: the first message of a fresh conversation, e.g. a slash command (DEV_REMOTE_CONTROL_PROMPT). Empty sends none."
  type        = string
}

variable "remote_control_resume_prompt" {
  default     = ""
  description = "Session mode: the message sent when a conversation is resumed (DEV_REMOTE_CONTROL_RESUME_PROMPT). Empty sends none."
  type        = string
}

# The Claude plugins every workspace of the template gets (DEV_DEFAULT_PLUGINS, the
# image's plugins.sh format: <plugin>@<marketplace>=<source>#<ref>, whitespace
# separated). Empty keeps the image's default (callum-flow at the image's release);
# coder/push.sh sets it for orchestrator-loop, which also needs factory-loop.
variable "default_plugins" {
  default     = ""
  description = "The Claude plugins every workspace gets (DEV_DEFAULT_PLUGINS), e.g. 'callum-flow@callum=cbundy/dev-system#v0.37.0 factory-loop@callum=cbundy/dev-system#v0.37.0'. Empty keeps the image's default."
  type        = string
}

# Whether the template's default_plugins refs beat a ref the workspace repo's committed
# .claude/settings.json declares (DEV_DEFAULT_PLUGIN_REFS_WIN, the image's plugins.sh), so the
# template owns the plugin version. coder/push.sh turns it on for orchestrator-loop only.
variable "default_plugin_refs_win" {
  default     = false
  description = "Whether the default_plugins refs win over a ref the workspace repo declares (DEV_DEFAULT_PLUGIN_REFS_WIN=1), and dev-doctor fails on a missing default plugin or a marketplace at another ref."
  type        = bool
}

variable "remote_control_name_format" {
  default     = ""
  description = "Session mode: the Remote Control session name, with {name} replaced by the default name (DEV_REMOTE_CONTROL_NAME_FORMAT), e.g. '🔄 {name} orchestrator'. Empty keeps the default name."
  type        = string
}

# The image reads runtime secrets (agentsview-pg-url: the agentsview session
# push; factory-db-writer-url and factory-db-reader-url: the factory database roles, see
# docs/factory-db.md) from DEV_SECRETS_DIR, /run/secrets/dev-system. This host directory is
# mounted there read-only, so a file put on the Docker host once reaches every
# workspace and never passes through Terraform state or Coder. Docker creates
# a missing directory (empty, so the push stays off).
variable "secrets_dir" {
  default     = "/etc/dev-system/secrets"
  description = "Directory on the Docker host mounted read-only at /run/secrets/dev-system in every workspace, e.g. holding agentsview-pg-url, factory-db-writer-url and factory-db-reader-url, and per-repo evidence storage under evidence/<owner>/<repo>/ (container-url, write-sas, read-sas; see docs/evidence-storage.md), all owned 1000:1000, mode 0600. Empty mounts nothing."
  type        = string
}

# gh state normally lives in /persist/gh on the workspace's own persist volume,
# so every workspace needs its own gh login. A named Docker volume mounted over
# it instead shares one login between every workspace that keeps the gh_login
# parameter's default, shared, as the desktop devcontainer's dev-system-gh
# volume does. The volume is per Docker host (see docker_hosts): each host has
# its own, so the first shared workspace on a host signs in once for it. Empty
# offers no choice: every workspace keeps its own gh login. It is
# deliberately not a docker_volume resource: one tied to a workspace would be
# deleted, login and all, with that workspace. Docker creates it on first use
# and copies the image's node-owned /persist/gh into it.
variable "gh_volume_name" {
  default     = ""
  description = "Named Docker volume that workspaces choosing the shared gh login (parameter gh_login, the default) mount at /persist/gh, so they share one gh login (and one token). Created by Docker on first use, never deleted with a workspace. Empty keeps gh state on each workspace's own persist volume and hides the choice."
  type        = string
  validation {
    # Docker's volume name rule: [a-zA-Z0-9][a-zA-Z0-9_.-]+
    condition     = var.gh_volume_name == "" || can(regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]+$", var.gh_volume_name))
    error_message = "gh_volume_name must be empty or a Docker volume name: at least two characters, starting with a letter or digit, then letters, digits, '_', '.' or '-'."
  }
}

# Per-workspace gh tokens (the gh_login parameter's "token" choice). Each
# workspace's host directory <dir>/<lower(owner)>/<lower(workspace name)> holds
# a gh-token file and is bind-mounted alone at /run/secrets/dev-system-workspace.
# It must not sit under secrets_dir, which is mounted into every workspace: a
# token under it would reach all of them. Only the path passes through
# Terraform, never a token value.
variable "workspace_secrets_dir" {
  default     = ""
  description = "Directory on the Docker host holding one folder per workspace, <dir>/<lower(owner)>/<lower(workspace name)>/ (files owned 1000:1000, mode 0600: gh-token, factory-db-writer-url, factory-db-reader-url), whose folder is mounted read-only at /run/secrets/dev-system-workspace in every workspace when this is set; gh-token is used only when the workspace picks gh_login=token. Must not be equal to or under secrets_dir, which every workspace mounts. Empty turns the token choice off."
  type        = string
  validation {
    condition     = var.workspace_secrets_dir == "" || var.secrets_dir == "" || (var.workspace_secrets_dir != var.secrets_dir && !startswith(var.workspace_secrets_dir, "${var.secrets_dir}/"))
    error_message = "workspace_secrets_dir must not be secrets_dir or under it: secrets_dir is mounted into every workspace."
  }
}

# The volume behind the claude_login parameter's "shared" choice: a named
# Docker volume mounted at /persist/claude-auth, with
# CLAUDE_SECURESTORAGE_CONFIG_DIR pointing Claude's login (and only its
# login) there, in every workspace that picks shared. A "private" workspace
# gets neither and keeps its login in CLAUDE_CONFIG_DIR, as before. Not a
# docker_volume resource, for the reason given for gh_volume_name. Like it,
# the volume is per Docker host (see docker_hosts). Empty
# offers no choice: every workspace is private.
variable "claude_auth_volume_name" {
  default     = ""
  description = "Named Docker volume that workspaces choosing the shared Claude login (parameter claude_login) mount at /persist/claude-auth, so they share one Claude login. Created by Docker on first use, never deleted with a workspace. Empty keeps every workspace's Claude login private and hides the choice."
  type        = string
  validation {
    # Docker's volume name rule: [a-zA-Z0-9][a-zA-Z0-9_.-]+
    condition     = var.claude_auth_volume_name == "" || can(regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]+$", var.claude_auth_volume_name))
    error_message = "claude_auth_volume_name must be empty or a Docker volume name: at least two characters, starting with a letter or digit, then letters, digits, '_', '.' or '-'."
  }
}

# push-next.sh (beside this file) pushes the checked-out template as
# dev-system-next with a Template Admin session token. On Coder OSS that token
# can change any template, so it is kept out of secrets_dir (mounted into every
# workspace) and lives in its own host directory, mounted only into workspaces
# with the template_testing parameter on.
variable "template_tester_secrets_dir" {
  default     = ""
  description = "Directory on the Docker host holding coder-session-token for push-next.sh (owned 1000:1000, mode 0700). Mounted read-only at /run/secrets/dev-system-template-tester only into workspaces with the template_testing parameter on. Empty turns the feature off."
  type        = string
}

# The opt-in Coder CLI login: a Coder session token in coder-session-token,
# mounted only into workspaces with the coder_login parameter on, so a workspace
# that drives other workspaces (the factory loop's shadow and testbed runs) can
# use `coder ssh`. Only the path passes through Terraform, never the token. It
# must not sit under secrets_dir or workspace_secrets_dir, which reach workspaces
# that did not opt in.
variable "coder_login_secrets_dir" {
  default     = ""
  description = "Directory on the Docker host holding coder-session-token for the Coder CLI login (owned 1000:1000, mode 0700). Mounted read-only at /run/secrets/dev-system-coder-login only into workspaces with the coder_login parameter on. Must not be equal to or under secrets_dir or workspace_secrets_dir. Empty turns the feature off."
  type        = string
  validation {
    condition = (var.coder_login_secrets_dir == "" || (
      (var.secrets_dir == "" || (var.coder_login_secrets_dir != var.secrets_dir && !startswith(var.coder_login_secrets_dir, "${var.secrets_dir}/")))
      && (var.workspace_secrets_dir == "" || (var.coder_login_secrets_dir != var.workspace_secrets_dir && !startswith(var.coder_login_secrets_dir, "${var.workspace_secrets_dir}/")))
    ))
    error_message = "coder_login_secrets_dir must not be secrets_dir or workspace_secrets_dir, or under either: they reach workspaces that did not opt in."
  }
}

# The factory database migrator URL (cbundy/dev-system#888): factory-db-migrator-url,
# which factory-db-migrate uses at start-up to apply the image's migrations. It is the
# migrator role's secret, so it must not sit under secrets_dir or workspace_secrets_dir,
# which reach workspaces that must not hold it. Only the templates that run the loop
# are pushed with it (coder/push.sh).
variable "migrator_secrets_dir" {
  default     = ""
  description = "Directory on the Docker host holding factory-db-migrator-url (owned 1000:1000, mode 0700). Mounted read-only at /run/secrets/dev-system-migrator. Must not be equal to or under secrets_dir or workspace_secrets_dir. Empty turns the feature off."
  type        = string
  validation {
    condition = (var.migrator_secrets_dir == "" || (
      (var.secrets_dir == "" || (var.migrator_secrets_dir != var.secrets_dir && !startswith(var.migrator_secrets_dir, "${var.secrets_dir}/")))
      && (var.workspace_secrets_dir == "" || (var.migrator_secrets_dir != var.workspace_secrets_dir && !startswith(var.migrator_secrets_dir, "${var.workspace_secrets_dir}/")))
    ))
    error_message = "migrator_secrets_dir must not be secrets_dir or workspace_secrets_dir, or under either: they reach workspaces that must not hold the migrator URL."
  }
}

# Private images (e.g. a per-repo image built FROM the base image) need
# registry credentials for both the digest lookup and the pull. They are read
# from a Docker config.json on the machine running the provisioner, so the
# secret never enters Terraform state, template variables or parameters.
variable "registry_auth_config" {
  default     = ""
  description = "Path, on the Coder server / provisioner, to a Docker config.json holding registry credentials (docker login), used to resolve and pull private images. Empty uses anonymous access."
  type        = string
}

variable "registry_auth_address" {
  default     = "ghcr.io"
  description = "Registry host the credentials in registry_auth_config are for. Only used when registry_auth_config is set."
  type        = string
}

provider "docker" {
  host = local.docker_host_url

  dynamic "registry_auth" {
    for_each = var.registry_auth_config == "" ? [] : [var.registry_auth_config]
    content {
      address     = var.registry_auth_address
      config_file = registry_auth.value
    }
  }
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# Shown only when there is a real choice. Immutable: the workspace's volumes live on
# the host, and the shared GitHub and Claude logins are per host, not synced.
data "coder_parameter" "docker_host" {
  count        = length(local.docker_hosts) > 1 ? 1 : 0
  name         = "docker_host"
  display_name = "Docker host"
  description  = "The Docker host the workspace runs on. It cannot change later, because the workspace's volumes live on it. The shared GitHub and Claude logins are shared per host."
  type         = "string"
  default      = local.docker_hosts[0].value
  mutable      = false
  order        = 0

  dynamic "option" {
    for_each = local.docker_hosts
    content {
      name  = option.value.name
      value = option.value.value
    }
  }
}

data "coder_parameter" "image" {
  name         = "image"
  display_name = "Image"
  description  = "The dev-system base image, or a per-repo image built FROM it. Another image needs curl or wget (for the agent) and a non-root user."
  type         = "string"
  # :2 tracks the 2.x releases; there is no :latest.
  default = "ghcr.io/cbundy/dev-system/base:2"
  mutable = true
  order   = 1
}

data "coder_parameter" "repo_url" {
  name         = "repo_url"
  display_name = "Git repository (optional)"
  description  = "HTTPS clone URL, cloned into /workspaces/<repo name> on the first start. Empty uses the image's own DEV_REPO_URL (per-repo images), or no repo for the base image."
  type         = "string"
  default      = ""
  mutable      = false
  order        = 2
}

data "coder_parameter" "remote_control_mode" {
  name         = "remote_control_mode"
  display_name = "Remote Control mode"
  description  = "auto: server when the workspace has a repo, else session. session: one interactive Claude session. server: one session per conversation started in claude.ai, each in its own git worktree - needs a git repo, else they share the directory."
  type         = "string"
  # auto is resolved by the startup script, which alone knows whether a
  # per-repo image brings its own DEV_REPO_URL (cbundy/dev-system#108).
  default = var.remote_control_default_mode
  mutable = true
  order   = 3
  option {
    name  = "auto"
    value = "auto"
  }
  option {
    name  = "session"
    value = "session"
  }
  option {
    name  = "server"
    value = "server"
  }
}

data "coder_parameter" "remote_control_skip_permissions" {
  name         = "remote_control_skip_permissions"
  display_name = "Skip permissions (bypass)"
  description  = "Lets Claude act without asking you to approve tool use: bypass permissions, in both session and server modes. Only turn on for a workspace you are happy to let act unsupervised. Takes effect on the next workspace start."
  type         = "bool"
  default      = var.remote_control_default_skip_permissions
  mutable      = true
  order        = 4
}

data "coder_parameter" "remote_control_resume" {
  name         = "remote_control_resume"
  display_name = "Resume the conversation"
  description  = "Session mode: every start resumes the workspace's last Claude conversation, so it comes back as the same claude.ai session after a stop, restart, template update or crash. Off: every start is a new conversation. Ignored in server mode."
  type         = "bool"
  default      = var.remote_control_default_resume
  mutable      = true
  order        = 5
}

data "coder_parameter" "cpus" {
  name         = "cpus"
  display_name = "CPUs"
  description  = "CPU limit for the workspace container."
  type         = "number"
  default      = 2
  mutable      = true
  order        = 6
  validation {
    min = 1
    max = 16
  }
}

data "coder_parameter" "memory_gb" {
  name         = "memory_gb"
  display_name = "Memory (GB)"
  description  = "Hard memory limit for the workspace container."
  type         = "number"
  default      = 8
  mutable      = true
  order        = 7
  validation {
    min = 1
    max = 16
  }
}

data "coder_parameter" "template_testing" {
  name         = "template_testing"
  display_name = "Template testing (admin token)"
  description  = "Mounts a Template Admin session token into this workspace, so agents here can push template changes as dev-system-next with coder/dev-system/push-next.sh. On Coder OSS that token can push, change or delete any template, including dev-system. Only for a workspace developing dev-system. Needs the template's template_tester_secrets_dir variable; takes effect on the next workspace start."
  type         = "bool"
  default      = false
  mutable      = true
  order        = 8
}

data "coder_parameter" "coder_login" {
  name         = "coder_login"
  display_name = "Coder CLI login"
  description  = "Logs the coder CLI in inside this workspace with a session token from the host, so agents here can drive other workspaces (e.g. the factory loop's shadow and testbed runs). That token can reach every workspace its user can reach. Only for a workspace that drives other workspaces. Needs the template's coder_login_secrets_dir variable; takes effect on the next workspace start."
  type         = "bool"
  default      = false
  mutable      = true
  order        = 14
}

# Shared, private or own-API-key Claude login (variables
# claude_auth_volume_name and workspace_secrets_dir). Coder gives an existing
# workspace the default on its next update (#268), so every workspace that
# predates the choice stays private, exactly as before. The api-key choice
# needs workspace_secrets_dir: the workspace's Claude reads the key file there.
data "coder_parameter" "claude_login" {
  count        = (var.claude_auth_volume_name != "" || var.workspace_secrets_dir != "") ? 1 : 0
  name         = "claude_login"
  display_name = "Claude login"
  description  = "private: this workspace has its own Claude login, as before. shared: it uses the one Claude login shared by every workspace that picks shared, so it needs no sign-in once any of them is signed in; its history and settings stay its own. Anyone who can open a shared workspace holds that login, and signing out in one signs out all. api-key: it uses its own Anthropic API key from the file anthropic-api-key in the workspace's folder on the Docker host, shares nothing and needs no sign-in; Remote Control is off in that mode, so Claude runs headless in the tmux session claude (coder ssh, then tmux attach -t claude). Takes effect on the next workspace start."
  type         = "string"
  default      = "private"
  mutable      = true
  order        = 10
  dynamic "option" {
    for_each = local.claude_login_options
    content {
      name  = option.value.name
      value = option.value.value
    }
  }
}

# Shared, private or own-token gh login. With a volume (variable gh_volume_name)
# the default is shared, which is what every workspace got before the choice
# existed, and Coder gives an existing workspace the default on its next update
# (#268), so nothing changes for it; without one the default is private. A
# private login is a token of its own, one of GitHub's 10 per user for the
# GitHub CLI app (docs/spikes/gh-auth/). The token choice needs
# workspace_secrets_dir: the workspace logs in with the token file there.
data "coder_parameter" "gh_login" {
  count        = (var.gh_volume_name != "" || var.workspace_secrets_dir != "") ? 1 : 0
  name         = "gh_login"
  display_name = "GitHub login"
  description  = "shared: this workspace uses the one GitHub CLI login shared by every workspace that picks shared, so it needs no sign-in once any of them is signed in. Anyone who can open a shared workspace holds that login. private: it has its own GitHub CLI login, which uses one of GitHub's 10 tokens per user for the GitHub CLI; past that, GitHub revokes the least recently used one. token: it logs in with its own token file from the Docker host, so it uses no GitHub CLI login slot and shares nothing. Takes effect on the next workspace start."
  type         = "string"
  default      = var.gh_volume_name != "" ? "shared" : "private"
  mutable      = true
  order        = 11
  dynamic "option" {
    for_each = local.gh_login_options
    content {
      name  = option.value.name
      value = option.value.value
    }
  }
}

# Only with workspace_secrets_dir: extra trusted authors for a workspace whose
# own token acts as another account (appended to the template's list).
data "coder_parameter" "extra_trusted_authors" {
  count        = var.workspace_secrets_dir == "" ? 0 : 1
  name         = "extra_trusted_authors"
  display_name = "Extra trusted authors"
  description  = "Comma-separated login:numeric_id entries appended to the template's trusted authors in CALLUM_FLOW_TRUSTED_AUTHORS, e.g. someone:12345. Takes effect on the next workspace start."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 12
  validation {
    regex = "^([A-Za-z0-9][A-Za-z0-9-]*(\\[bot\\])?:[1-9][0-9]*(,[A-Za-z0-9][A-Za-z0-9-]*(\\[bot\\])?:[1-9][0-9]*)*)?$"
    error = "Use comma-separated login:numeric_id entries with no spaces, e.g. someone:12345."
  }
}

# Only with workspace_secrets_dir: the git email for a workspace whose own token
# replaces the owner's identity (passed as DEV_GIT_EMAIL when set).
data "coder_parameter" "git_email" {
  count        = var.workspace_secrets_dir == "" ? 0 : 1
  name         = "git_email"
  display_name = "Git email"
  description  = "The email address for commits in this workspace, passed as DEV_GIT_EMAIL. Empty leaves it to the image. Takes effect on the next workspace start."
  type         = "string"
  default      = ""
  mutable      = true
  order        = 13
  validation {
    regex = "^([^@\\s]+@[^@\\s]+\\.[^@\\s]+)?$"
    error = "Enter an email address such as name@example.com, or leave it empty."
  }
}

# The rollout ring (cbundy/dev-system#338), passed in as DEV_RING. Coder ignores
# parameter changes on an existing workspace's update or restart (#268), so the
# default is the right value for every workspace that never sets it.
data "coder_parameter" "ring" {
  name         = "ring"
  display_name = "Rollout ring"
  description  = "Which release ring this workspace belongs to, reported as DEV_RING: testbed, dev-system or consumer."
  type         = "string"
  default      = "consumer"
  mutable      = true
  order        = 9

  option {
    name  = "testbed"
    value = "testbed"
  }
  option {
    name  = "dev-system"
    value = "dev-system"
  }
  option {
    name  = "consumer"
    value = "consumer"
  }
}

locals {
  # The Docker hosts (variable docker_hosts), decoded once. The parameter exists only
  # with more than one host; with one, that host is used.
  docker_hosts      = jsondecode(var.docker_hosts)
  docker_host_value = try(data.coder_parameter.docker_host[0].value, local.docker_hosts[0].value)
  docker_host_url   = one([for h in local.docker_hosts : h.url if h.value == local.docker_host_value])
}

locals {
  # dev-login's page; coder_app.login proxies it.
  login_port = 8765
  # The Log in app as the owner reaches it (path-based, agent "main"), for
  # dev-login's log lines and notifications.
  login_page_url = "${data.coder_workspace.me.access_url}/@${data.coder_workspace_owner.me.name}/${data.coder_workspace.me.name}.main/apps/login/"

  # Lower case: Docker container names reject upper case.
  container_name = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"

  # Resource attribute keys are the telemetry gateway's contract (host, env).
  # The container name is [a-z0-9-] only, so it needs no percent-encoding.
  otel_env = var.otlp_endpoint == "" ? [] : [
    "OTEL_EXPORTER_OTLP_ENDPOINT=${var.otlp_endpoint}",
    "OTEL_RESOURCE_ATTRIBUTES=host=${local.container_name},env=coder",
  ]

  # Set for every workspace, so agents and dev-doctor read the same list; the
  # extra_trusted_authors parameter appends to the template's.
  trusted_authors_effective = join(",", compact([var.trusted_authors, try(data.coder_parameter.extra_trusted_authors[0].value, "")]))
  trusted_env = local.trusted_authors_effective == "" ? [] : [
    "CALLUM_FLOW_TRUSTED_AUTHORS=${local.trusted_authors_effective}",
  ]

  # The shared Claude login (parameter claude_login): Claude keeps its login,
  # and only its login, in the shared volume at /persist/claude-auth.
  claude_login         = try(data.coder_parameter.claude_login[0].value, "private")
  claude_login_shared  = local.claude_login == "shared"
  claude_login_api_key = local.claude_login == "api-key"
  claude_login_options = concat(
    var.claude_auth_volume_name != "" ? [{ name = "Shared with other workspaces", value = "shared" }] : [],
    [{ name = "Private to this workspace", value = "private" }],
    var.workspace_secrets_dir != "" ? [{ name = "This workspace's own Anthropic API key", value = "api-key" }] : [],
  )
  claude_auth_env = local.claude_login_shared ? ["CLAUDE_SECURESTORAGE_CONFIG_DIR=/persist/claude-auth"] : []

  # API-key mode: dev-init points Claude's apiKeyHelper at this file (only the
  # path is set here, never the key).
  claude_api_key_env = local.claude_login_api_key ? [
    "DEV_CLAUDE_AUTH=api-key",
    "DEV_CLAUDE_API_KEY_FILE=/run/secrets/dev-system-workspace/anthropic-api-key",
  ] : []

  # The gh login (parameter gh_login): shared, private or token.
  gh_login        = try(data.coder_parameter.gh_login[0].value, "private")
  gh_login_shared = local.gh_login == "shared"
  gh_login_token  = local.gh_login == "token"
  gh_login_options = concat(
    var.gh_volume_name != "" ? [{ name = "Shared with other workspaces", value = "shared" }] : [],
    [{ name = "Private to this workspace", value = "private" }],
    var.workspace_secrets_dir != "" ? [{ name = "This workspace's own token", value = "token" }] : [],
  )

  # The workspace's own folder on the Docker host. Lower case for the owner
  # and workspace name, as container_name does: the host folder is created in
  # lower case.
  workspace_secrets_host_dir = "${var.workspace_secrets_dir}/${lower(data.coder_workspace_owner.me.name)}/${lower(data.coder_workspace.me.name)}"

  # Token mode: dev-init logs gh in with the token file (only the path is set
  # here, never the token). DEV_GIT_EMAIL only when the parameter is set.
  git_email = try(data.coder_parameter.git_email[0].value, "")
  gh_token_env = concat(
    local.gh_login_token ? ["DEV_GH_TOKEN_FILE=/run/secrets/dev-system-workspace/gh-token"] : [],
    local.git_email != "" ? ["DEV_GIT_EMAIL=${local.git_email}"] : [],
  )

  # Opt-in Coder CLI login: dev-init reads the token from this path (only the
  # path is set here, never the token).
  coder_login_on  = var.coder_login_secrets_dir != "" ? tobool(data.coder_parameter.coder_login.value) : false
  coder_login_env = local.coder_login_on ? ["DEV_CODER_TOKEN_FILE=/run/secrets/dev-system-coder-login/coder-session-token"] : []

  # The owner's git identity; a token workspace acts as the token's account.
  git_identity_env = local.gh_login_token ? {} : {
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = data.coder_workspace_owner.me.email
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = data.coder_workspace_owner.me.email
  }

  # Docker labels, to trace orphaned resources back to their workspace.
  labels = {
    "coder.owner"        = data.coder_workspace_owner.me.name
    "coder.owner_id"     = data.coder_workspace_owner.me.id
    "coder.workspace_id" = data.coder_workspace.me.id
  }
}

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"

  # The agent replaces the image entrypoint (dev-entrypoint), so this does
  # its job, the way the image's devcontainer postStartCommand does:
  # dev-init, then the Remote Control supervisor in the background (log:
  # /tmp/dev-remote-control.log, attach: tmux attach -t claude). Both are
  # best effort, so the workspace always becomes ready.
  startup_script = <<-EOT
    # From base image 2.1.0, /workspaces is node-owned in the image, and Docker
    # gives a new volume that ownership. Older images lack the directory, so
    # Docker creates the volume root-owned: fix that once.
    [ -w /workspaces ] || sudo -n chown "$(id -u):$(id -g)" /workspaces \
      || echo "WARNING: /workspaces is not writable by $(id -un)"
    # The same for the shared Claude login volume (parameter claude_login)
    # first mounted by an image older than /persist/claude-auth: Docker
    # creates it root-owned, and it would stay so for every newer image.
    [ ! -d /persist/claude-auth ] || [ -w /persist/claude-auth ] \
      || sudo -n install -d -o "$(id -u)" -g "$(id -g)" -m 0700 /persist/claude-auth \
      || echo "WARNING: /persist/claude-auth is not writable by $(id -un)"

    # With a repo URL (the repo_url parameter or the image's own), the image
    # works in /workspaces/<repo name> and names the Remote Control session
    # after the repo. Without one, keep Claude on the volume and name the
    # session coder-<workspace> rather than the hostname. Done here, not in
    # env, because only the container knows the image's DEV_REPO_URL.
    # A name format (remote_control_name_format) is filled in by the image
    # instead, with the hostname, which is the workspace name.
    if [ -z "$${DEV_REPO_URL:-}" ]; then
      export DEV_WORKSPACE=/workspaces
      [ -n "$${DEV_REMOTE_CONTROL_NAME_FORMAT:-}" ] \
        || export DEV_REMOTE_CONTROL_NAME="coder-${lower(data.coder_workspace.me.name)}"
    fi

    # Remote Control mode "auto" (dev-system's default): server, one worktree
    # per claude.ai session, when there is a repo; else session, since server
    # mode without a repo puts every session in one shared directory. Resolved
    # here, before dev-init and dev-remote-control read it: the image accepts
    # only session or server. An explicit session or server passes through.
    if [ "$${DEV_REMOTE_CONTROL_MODE:-}" = auto ]; then
      if [ -n "$${DEV_REPO_URL:-}" ]; then
        export DEV_REMOTE_CONTROL_MODE=server
      else
        export DEV_REMOTE_CONTROL_MODE=session
      fi
    fi

    # A wind-down request left by the last stop is stale now: the stop script leaves it in place
    # so the loop starts nothing while the container is still up, and this clears it before the
    # loop (started by dev-init) plans. Runs whatever wind_down_minutes is. The file holds no
    # Terraform template sequences (wind-down-start.sh); a failure never blocks the start.
    ( ${file("${path.module}/wind-down-start.sh")} ) || echo "WARNING: wind-down cleanup failed - continuing"

    if ! command -v dev-init >/dev/null 2>&1; then
      echo "no dev-init in this image - not a dev-system image, nothing to start"
      exit 0
    fi
    cd /workspaces || exit 0
    # Same limit as the image's own dev-entrypoint: the repo clone alone may
    # take 120s, and the login page and dev-doctor still have to run after it
    # (cbundy/dev-system#104).
    timeout -k 10 300 dev-init || echo "WARNING: dev-init failed or timed out - continuing"
    dev-remote-control --post-start
  EOT

  env = merge(
    {
      DEV_REMOTE_CONTROL      = "1"
      DEV_REMOTE_CONTROL_MODE = data.coder_parameter.remote_control_mode.value
      # The parameter's value is the string "true" or "false".
      DEV_REMOTE_CONTROL_SKIP_PERMISSIONS = tobool(data.coder_parameter.remote_control_skip_permissions.value) ? "1" : "0"
      # dev-init serves the login page on this port; it stays up as a status
      # page so the app button always works.
      DEV_LOGIN_PORT      = tostring(local.login_port)
      DEV_LOGIN_PAGE_EXIT = "0"
      DEV_LOGIN_PAGE_URL  = local.login_page_url
      # The workspace's label in agentsview (when the push is on): coder-<name>,
      # as the image's desktop default is desktop-<checkout folder>.
      DEV_MACHINE_NAME = "coder-${lower(data.coder_workspace.me.name)}"
      # Where this workspace sits in the rollout and which template it runs
      # (cbundy/dev-system#338). Desktop containers get none of these.
      DEV_ROLE                   = var.role
      DEV_RING                   = data.coder_parameter.ring.value
      DEV_CODER_WORKSPACE        = data.coder_workspace.me.name
      DEV_CODER_TEMPLATE_VERSION = data.coder_workspace.me.template_version
    },
    # Commits work straight away; these take precedence over ~/.gitconfig.
    # Left out in token mode (local.git_identity_env).
    local.git_identity_env,
    # Only when set, so a per-repo image's own DEV_REPO_URL applies otherwise.
    data.coder_parameter.repo_url.value != "" ? { DEV_REPO_URL = data.coder_parameter.repo_url.value } : {},
    # The conversation settings only when on or non-empty, so the image's
    # defaults apply otherwise.
    tobool(data.coder_parameter.remote_control_resume.value) ? { DEV_REMOTE_CONTROL_RESUME = "1" } : {},
    var.remote_control_prompt != "" ? { DEV_REMOTE_CONTROL_PROMPT = var.remote_control_prompt } : {},
    var.remote_control_resume_prompt != "" ? { DEV_REMOTE_CONTROL_RESUME_PROMPT = var.remote_control_resume_prompt } : {},
    var.remote_control_name_format != "" ? { DEV_REMOTE_CONTROL_NAME_FORMAT = var.remote_control_name_format } : {},
    var.default_plugins != "" ? { DEV_DEFAULT_PLUGINS = var.default_plugins } : {},
    var.default_plugin_refs_win ? { DEV_DEFAULT_PLUGIN_REFS_WIN = "1" } : {},
  )

  # One line, e.g. "claude: in, codex: out (optional), gh: out". The text form
  # of dev-login status also lists every pending sign-in link and code. It reads
  # dev-login's cached gh result (--cached), so the row costs no GitHub API
  # calls in steady state (cbundy/dev-system#375); an older image that rejects
  # --cached falls back to the live check.
  metadata {
    display_name = "Logins"
    key          = "0_logins"
    script       = <<-EOT
      if command -v dev-login >/dev/null 2>&1; then
        { dev-login status --json --cached 2>/dev/null || dev-login status --json; } \
          | jq -r 'to_entries | map("\(.key): \(.value.state)\(if .value.optional then " (optional)" else "" end)") | join(", ")'
      else
        echo "no dev-login in image"
      fi
    EOT
    interval     = 300
    timeout      = 10
  }

  metadata {
    display_name = "CPU Usage"
    key          = "1_cpu_usage"
    script       = "coder stat cpu"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "RAM Usage"
    key          = "2_ram_usage"
    script       = "coder stat mem"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Workspace Disk"
    key          = "3_workspace_disk"
    script       = "coder stat disk --path /workspaces"
    interval     = 60
    timeout      = 1
  }
}

# dev-login's page, behind Coder's own authentication: no port is published
# on the Docker host. The page's links are relative, so the path-based app
# URL works (subdomain apps would need a wildcard domain).
resource "coder_app" "login" {
  agent_id     = coder_agent.main.id
  slug         = "login"
  display_name = "Log in"
  url          = "http://localhost:${local.login_port}"
  icon         = "/icon/key.svg"
  subdomain    = false
  share        = "owner"
  order        = 0
  healthcheck {
    url       = "http://localhost:${local.login_port}/healthz"
    interval  = 10
    threshold = 6
  }
}

# Named after the workspace id, so a rename does not orphan them.
# ignore_changes = all keeps a label or parameter change from replacing (and
# so wiping) them; they go only when the workspace is deleted.
resource "docker_volume" "persist" {
  name = "coder-${data.coder_workspace.me.id}-persist"
  lifecycle {
    ignore_changes = all
  }
  dynamic "labels" {
    for_each = merge(local.labels, {
      # Stale after a rename, but useful for cleaning up.
      "coder.workspace_name_at_creation" = data.coder_workspace.me.name
    })
    content {
      label = labels.key
      value = labels.value
    }
  }
}

resource "docker_volume" "workspace" {
  name = "coder-${data.coder_workspace.me.id}-workspace"
  lifecycle {
    ignore_changes = all
  }
  dynamic "labels" {
    for_each = merge(local.labels, {
      "coder.workspace_name_at_creation" = data.coder_workspace.me.name
    })
    content {
      label = labels.key
      value = labels.value
    }
  }
}

# Resolve the tag to a digest on every build, so a moved tag (a new :2
# release, or the weekly rebuild) is pulled on the next workspace start.
data "docker_registry_image" "workspace" {
  name = data.coder_parameter.image.value
}

locals {
  image_ref = (strcontains(data.coder_parameter.image.value, "@")
    ? data.coder_parameter.image.value
    : "${data.docker_registry_image.workspace.name}@${data.docker_registry_image.workspace.sha256_digest}"
  )
}

resource "docker_image" "workspace" {
  # By digest, not tag: the provider reuses an image already present under the
  # requested name, so a tag that exists locally is never re-pulled when it
  # moves (cbundy/dev-system#99). A digest reference is only present once that
  # exact image has been pulled. A parameter that is already digest-pinned is
  # used as is.
  name          = local.image_ref
  pull_triggers = [data.docker_registry_image.workspace.sha256_digest]
  keep_locally  = true
}

# The stop script of the loop template: asks each factory loop on the workspace to wind down and
# waits for it (wind-down.sh). The cap reaches the script as an environment variable, so the script
# can be tested on its own. The timeout is the cap plus 45 s, inside the container's stop grace.
resource "coder_script" "wind_down" {
  count        = var.wind_down_minutes > 0 ? 1 : 0
  agent_id     = coder_agent.main.id
  display_name = "Wind down"
  run_on_stop  = true
  timeout      = var.wind_down_minutes * 60 + 45
  script       = "WIND_DOWN_CAP_MS=${var.wind_down_minutes * 60000}\n${file("${path.module}/wind-down.sh")}"
}

resource "docker_container" "workspace" {
  count    = data.coder_workspace.me.start_count
  image    = docker_image.workspace.image_id
  name     = local.container_name
  hostname = lower(data.coder_workspace.me.name)
  # The agent replaces the image entrypoint (and with it tini), so Docker's
  # own init is PID 1: it reaps the orphans tmux and Claude leave behind.
  init = true
  # Docker's stop signal waits this long before killing the container: the wind-down cap plus a
  # minute. null (Docker's default) when there is no wind-down.
  destroy_grace_seconds = var.wind_down_minutes > 0 ? var.wind_down_minutes * 60 + 60 : null
  entrypoint            = ["sh", "-c", coder_agent.main.init_script]
  env                   = concat(["CODER_AGENT_TOKEN=${coder_agent.main.token}"], local.otel_env, local.trusted_env, local.claude_auth_env, local.claude_api_key_env, local.gh_token_env, local.coder_login_env)

  memory = data.coder_parameter.memory_gb.value * 1024
  cpus   = tostring(data.coder_parameter.cpus.value)

  # Docker copies the image's /persist (its subdirectories owned 1000:1000)
  # into the new volume on first use, so node can write it.
  volumes {
    container_path = "/persist"
    volume_name    = docker_volume.persist.name
  }
  # The checkout, and server mode's worktrees inside it, survive a stop.
  volumes {
    container_path = "/workspaces"
    volume_name    = docker_volume.workspace.name
  }
  # The shared gh login, for a workspace that keeps it (parameter gh_login;
  # not in token mode), over the persist volume's gh directory. Not managed here: see
  # gh_volume_name.
  dynamic "volumes" {
    for_each = local.gh_login_shared ? [var.gh_volume_name] : []
    content {
      container_path = "/persist/gh"
      volume_name    = volumes.value
    }
  }
  # The shared Claude login, for a workspace that picks it (parameter
  # claude_login). Not managed here: see claude_auth_volume_name.
  dynamic "volumes" {
    for_each = local.claude_login_shared ? [var.claude_auth_volume_name] : []
    content {
      container_path = "/persist/claude-auth"
      volume_name    = volumes.value
    }
  }
  # Runtime secrets from the Docker host (variable secrets_dir).
  dynamic "volumes" {
    for_each = var.secrets_dir == "" ? [] : [var.secrets_dir]
    content {
      container_path = "/run/secrets/dev-system"
      host_path      = volumes.value
      read_only      = true
    }
  }
  # This workspace's own folder only (variable workspace_secrets_dir), for the
  # gh token and factory-db-*-url overrides: no other workspace's files are
  # visible. A missing host folder is created empty by Docker and changes nothing.
  dynamic "volumes" {
    for_each = var.workspace_secrets_dir != "" ? [local.workspace_secrets_host_dir] : []
    content {
      container_path = "/run/secrets/dev-system-workspace"
      host_path      = volumes.value
      read_only      = true
    }
  }
  # The Template Admin token for push-next.sh: only with both the variable set
  # and the workspace opted in (parameter template_testing).
  dynamic "volumes" {
    for_each = (var.template_tester_secrets_dir != "" && tobool(data.coder_parameter.template_testing.value)
      ? [var.template_tester_secrets_dir]
      : []
    )
    content {
      container_path = "/run/secrets/dev-system-template-tester"
      host_path      = volumes.value
      read_only      = true
    }
  }
  # The Coder CLI login token: only with both the variable set and the
  # workspace opted in (parameter coder_login).
  dynamic "volumes" {
    for_each = local.coder_login_on ? [var.coder_login_secrets_dir] : []
    content {
      container_path = "/run/secrets/dev-system-coder-login"
      host_path      = volumes.value
      read_only      = true
    }
  }
  # The factory database migrator URL, for factory-db-migrate: whenever the variable is set.
  dynamic "volumes" {
    for_each = var.migrator_secrets_dir != "" ? [var.migrator_secrets_dir] : []
    content {
      container_path = "/run/secrets/dev-system-migrator"
      host_path      = volumes.value
      read_only      = true
    }
  }

  dynamic "labels" {
    for_each = merge(local.labels, {
      "coder.workspace_name" = data.coder_workspace.me.name
    })
    content {
      label = labels.key
      value = labels.value
    }
  }
}
