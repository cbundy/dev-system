# Coder workspace template "dev-system": one container per workspace from the
# dev-system base image (images/base), on a Docker host reached locally or
# over ssh:// (variable docker_host). See README.md next to this file. The
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

variable "docker_host" {
  default     = "unix:///var/run/docker.sock"
  description = "Docker host for workspaces: the local socket, or ssh://user@host for a remote one (the Coder server's ssh config supplies the key)."
  type        = string
}

# The image turns Claude Code and codex telemetry export on when
# OTEL_EXPORTER_OTLP_ENDPOINT is set (cbundy/dev-system#68).
variable "otlp_endpoint" {
  default     = ""
  description = "OTLP http/protobuf endpoint for workspace telemetry, e.g. http://otel-gateway:4318. Empty disables export."
  type        = string
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

variable "remote_control_name_format" {
  default     = ""
  description = "Session mode: the Remote Control session name, with {name} replaced by the default name (DEV_REMOTE_CONTROL_NAME_FORMAT), e.g. '🔄 {name} orchestrator'. Empty keeps the default name."
  type        = string
}

# The image reads runtime secrets (agentsview-pg-url: the agentsview session
# push) from DEV_SECRETS_DIR, /run/secrets/dev-system. This host directory is
# mounted there read-only, so a file put on the Docker host once reaches every
# workspace and never passes through Terraform state or Coder. Docker creates
# a missing directory (empty, so the push stays off).
variable "secrets_dir" {
  default     = "/etc/dev-system/secrets"
  description = "Directory on the Docker host mounted read-only at /run/secrets/dev-system in every workspace, e.g. holding agentsview-pg-url (owned 1000:1000, mode 0600). Empty mounts nothing."
  type        = string
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
  host = var.docker_host

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
    max = 8
  }
}

data "coder_parameter" "memory_gb" {
  name         = "memory_gb"
  display_name = "Memory (GB)"
  description  = "Hard memory limit for the workspace container."
  type         = "number"
  default      = 4
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
      # Commits work straight away; these take precedence over ~/.gitconfig.
      GIT_AUTHOR_NAME         = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_AUTHOR_EMAIL        = data.coder_workspace_owner.me.email
      GIT_COMMITTER_NAME      = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_COMMITTER_EMAIL     = data.coder_workspace_owner.me.email
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
    },
    # Only when set, so a per-repo image's own DEV_REPO_URL applies otherwise.
    data.coder_parameter.repo_url.value != "" ? { DEV_REPO_URL = data.coder_parameter.repo_url.value } : {},
    # The conversation settings only when on or non-empty, so the image's
    # defaults apply otherwise.
    tobool(data.coder_parameter.remote_control_resume.value) ? { DEV_REMOTE_CONTROL_RESUME = "1" } : {},
    var.remote_control_prompt != "" ? { DEV_REMOTE_CONTROL_PROMPT = var.remote_control_prompt } : {},
    var.remote_control_resume_prompt != "" ? { DEV_REMOTE_CONTROL_RESUME_PROMPT = var.remote_control_resume_prompt } : {},
    var.remote_control_name_format != "" ? { DEV_REMOTE_CONTROL_NAME_FORMAT = var.remote_control_name_format } : {},
  )

  # One line, e.g. "claude: in, codex: out, gh: out". The text form of
  # dev-login status also lists every pending sign-in link and code.
  metadata {
    display_name = "Logins"
    key          = "0_logins"
    script       = <<-EOT
      if command -v dev-login >/dev/null 2>&1; then
        dev-login status --json | jq -r 'to_entries | map("\(.key): \(.value.state)") | join(", ")'
      else
        echo "no dev-login in image"
      fi
    EOT
    interval     = 30
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

resource "docker_container" "workspace" {
  count    = data.coder_workspace.me.start_count
  image    = docker_image.workspace.image_id
  name     = local.container_name
  hostname = lower(data.coder_workspace.me.name)
  # The agent replaces the image entrypoint (and with it tini), so Docker's
  # own init is PID 1: it reaps the orphans tmux and Claude leave behind.
  init       = true
  entrypoint = ["sh", "-c", coder_agent.main.init_script]
  env        = concat(["CODER_AGENT_TOKEN=${coder_agent.main.token}"], local.otel_env)

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
  # Runtime secrets from the Docker host (variable secrets_dir).
  dynamic "volumes" {
    for_each = var.secrets_dir == "" ? [] : [var.secrets_dir]
    content {
      container_path = "/run/secrets/dev-system"
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
