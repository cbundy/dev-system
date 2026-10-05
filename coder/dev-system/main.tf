# Coder workspace template "dev-system": one container per workspace from the
# dev-system base image (images/base), on a Docker host reached locally or
# over ssh:// (variable docker_host). See README.md next to this file.
#
# Based on Coder's docker starter (coder/coder examples/templates/docker) and
# the preview template that lived in cbundy/network. Differences from the
# starter:
# - no volume over the home directory: the image's tools live under
#   /home/node/.local, and a home volume would freeze them at the first
#   start. State lives where the image README's Kubernetes / Coder contract
#   puts it, one volume per workspace at /persist, plus a /workspace volume
#   for the checkout (cbundy/dev-system#77 clones DEV_REPO_URL there);
# - the agent replaces the image entrypoint, so its startup_script runs
#   dev-init and starts Remote Control, as the image's devcontainer
#   postStartCommand does;
# - logins without a shell: a "Log in" app proxies dev-login's page and a
#   "Logins" metadata row shows each tool's state;
# - image, CPU, memory, repo and Remote Control mode parameters, OTLP
#   telemetry env (variable otlp_endpoint) and pinned provider versions.

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

provider "docker" {
  host = var.docker_host
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
  description  = "HTTPS clone URL, cloned into /workspace on the first start. Empty uses the image's own DEV_REPO_URL (per-repo images), or no repo for the base image."
  type         = "string"
  default      = ""
  mutable      = false
  order        = 2
}

data "coder_parameter" "remote_control_mode" {
  name         = "remote_control_mode"
  display_name = "Remote Control mode"
  description  = "session: one interactive Claude session. server: one session per conversation started in claude.ai, each in its own git worktree - needs a git repo in /workspace, else they share the directory."
  type         = "string"
  default      = "session"
  mutable      = true
  order        = 3
  option {
    name  = "session"
    value = "session"
  }
  option {
    name  = "server"
    value = "server"
  }
}

data "coder_parameter" "cpus" {
  name         = "cpus"
  display_name = "CPUs"
  description  = "CPU limit for the workspace container."
  type         = "number"
  default      = 2
  mutable      = true
  order        = 4
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
  order        = 5
  validation {
    min = 1
    max = 16
  }
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
    # /workspace is a fresh volume whose root Docker creates root-owned.
    [ -w /workspace ] || sudo -n chown "$(id -u):$(id -g)" /workspace \
      || echo "WARNING: /workspace is not writable by $(id -un)"

    # Remote Control name: the repo name when there is a repo (the repo_url
    # parameter or the image's own DEV_REPO_URL), else coder-<workspace>.
    repo="$${DEV_REPO_URL:-}"
    repo="$${repo%/}"
    repo="$${repo%.git}"
    repo="$${repo##*/}"
    export DEV_REMOTE_CONTROL_NAME="$${repo:-coder-${lower(data.coder_workspace.me.name)}}"

    if ! command -v dev-init >/dev/null 2>&1; then
      echo "no dev-init in this image - not a dev-system image, nothing to start"
      exit 0
    fi
    cd /workspace || exit 0
    timeout -k 10 120 dev-init || echo "WARNING: dev-init failed or timed out - continuing"
    dev-remote-control --post-start
  EOT

  env = merge(
    {
      # Commits work straight away; these take precedence over ~/.gitconfig.
      GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_AUTHOR_EMAIL    = data.coder_workspace_owner.me.email
      GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
      GIT_COMMITTER_EMAIL = data.coder_workspace_owner.me.email
      # Where dev-init, Claude and the #77 clone work. The /workspace volume
      # keeps the checkout (and server mode's worktrees) across restarts.
      DEV_WORKSPACE           = "/workspace"
      DEV_REMOTE_CONTROL      = "1"
      DEV_REMOTE_CONTROL_MODE = data.coder_parameter.remote_control_mode.value
      # dev-init serves the login page on this port; it stays up as a status
      # page so the app button always works.
      DEV_LOGIN_PORT      = tostring(local.login_port)
      DEV_LOGIN_PAGE_EXIT = "0"
      DEV_LOGIN_PAGE_URL  = local.login_page_url
      # The workspace's label in agentsview, when AGENTSVIEW_PG_URL is set.
      DEV_MACHINE_NAME = "coder-${lower(data.coder_workspace.me.name)}"
    },
    # Only when set, so a per-repo image's own DEV_REPO_URL applies otherwise.
    data.coder_parameter.repo_url.value != "" ? { DEV_REPO_URL = data.coder_parameter.repo_url.value } : {},
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
    script       = "coder stat disk --path /workspace"
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

resource "docker_image" "workspace" {
  name          = data.docker_registry_image.workspace.name
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
  volumes {
    container_path = "/workspace"
    volume_name    = docker_volume.workspace.name
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
