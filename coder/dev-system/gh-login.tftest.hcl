# Plan-only tests for the gh_login choice and what hangs off it: the options and
# default, the per-workspace token mount, DEV_GH_TOKEN_FILE, the owner's GIT_*
# keys and the trusted-authors merge (cbundy/dev-system#730). Run by
# scripts/lint.sh (terraform test).

mock_provider "coder" {}
mock_provider "docker" {}

override_data {
  target = data.coder_workspace.me
  values = {
    start_count      = 1
    name             = "My-Work"
    id               = "ws-id"
    access_url       = "https://coder.example.com"
    template_version = "v1"
  }
}

override_data {
  target = data.coder_workspace_owner.me
  values = {
    name      = "Alice"
    id        = "owner-id"
    full_name = "Alice Example"
    email     = "alice@example.com"
  }
}

override_data {
  target = data.coder_provisioner.me
  values = {
    arch = "amd64"
    os   = "linux"
  }
}

# The agent's token and init script are only known after apply; the container
# env and entrypoint embed them.
override_resource {
  target          = coder_agent.main
  override_during = plan
  values = {
    token       = "test-token"
    init_script = "true"
  }
}

override_data {
  target = data.coder_parameter.image
  values = { value = "ghcr.io/cbundy/dev-system/base:2" }
}
override_data {
  target = data.coder_parameter.repo_url
  values = { value = "" }
}
override_data {
  target = data.coder_parameter.remote_control_mode
  values = { value = "auto" }
}
override_data {
  target = data.coder_parameter.remote_control_skip_permissions
  values = { value = "false" }
}
override_data {
  target = data.coder_parameter.remote_control_resume
  values = { value = "false" }
}
override_data {
  target = data.coder_parameter.cpus
  values = { value = "2" }
}
override_data {
  target = data.coder_parameter.memory_gb
  values = { value = "8" }
}
override_data {
  target = data.coder_parameter.template_testing
  values = { value = "false" }
}
override_data {
  target = data.coder_parameter.coder_login
  values = { value = "false" }
}
override_data {
  target = data.coder_parameter.ring
  values = { value = "consumer" }
}

# 1. Existing workspaces: a volume only. Shared is the default and is mounted;
# the owner's identity stays; nothing token related is set.
run "volume_only_defaults" {
  command = plan

  variables {
    gh_volume_name        = "dev-system-gh"
    workspace_secrets_dir = ""
    trusted_authors       = "cbundy:13131067"
  }

  override_data {
    target = data.coder_parameter.gh_login
    values = { value = "shared" }
  }

  assert {
    condition     = data.coder_parameter.gh_login[0].default == "shared"
    error_message = "gh_login must default to shared with a volume"
  }
  assert {
    condition     = [for o in data.coder_parameter.gh_login[0].option : o.value] == ["shared", "private"]
    error_message = "gh_login options must be shared and private"
  }
  assert {
    condition     = length(data.coder_parameter.extra_trusted_authors) == 0 && length(data.coder_parameter.git_email) == 0
    error_message = "the token parameters must be hidden without workspace_secrets_dir"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/persist/gh" && v.volume_name == "dev-system-gh"]) == 1
    error_message = "the shared gh volume must be mounted at /persist/gh"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-workspace"]) == 0
    error_message = "no per-workspace mount outside token mode"
  }
  assert {
    condition     = coder_agent.main.env.GIT_AUTHOR_EMAIL == "alice@example.com" && coder_agent.main.env.GIT_COMMITTER_NAME == "Alice Example"
    error_message = "the owner's GIT_* identity must be kept"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_GH_TOKEN_FILE=") || startswith(e, "DEV_GIT_EMAIL=")]) == 0
    error_message = "DEV_GH_TOKEN_FILE and DEV_GIT_EMAIL must be unset outside token mode"
  }
  assert {
    condition     = contains(docker_container.workspace[0].env, "CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067")
    error_message = "the template's trusted authors must be set unchanged"
  }
}

# 2. workspace_secrets_dir only: private is the default, token is offered.
run "secrets_dir_only" {
  command = plan

  variables {
    gh_volume_name        = ""
    workspace_secrets_dir = "/srv/ws-secrets"
  }

  override_data {
    target = data.coder_parameter.gh_login
    values = { value = "private" }
  }
  override_data {
    target = data.coder_parameter.extra_trusted_authors
    values = { value = "" }
  }
  override_data {
    target = data.coder_parameter.git_email
    values = { value = "" }
  }

  assert {
    condition     = data.coder_parameter.gh_login[0].default == "private"
    error_message = "gh_login must default to private without a volume"
  }
  assert {
    condition     = [for o in data.coder_parameter.gh_login[0].option : o.value] == ["private", "token"]
    error_message = "gh_login options must be private and token"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/persist/gh"]) == 0
    error_message = "private mode does not mount the gh volume"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-workspace" && v.read_only && startswith(v.host_path, "/srv/ws-secrets/") && v.host_path != "/srv/ws-secrets"]) == 1
    error_message = "with workspace_secrets_dir set, the workspace's own folder (never the whole directory) is mounted read-only even outside token mode"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_GH_TOKEN_FILE=")]) == 0
    error_message = "DEV_GH_TOKEN_FILE is set only for gh_login=token"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "CALLUM_FLOW_TRUSTED_AUTHORS=")]) == 0
    error_message = "trusted authors stay unset when both are empty"
  }
}

# 2b. A shared gh login with workspace_secrets_dir set: the shared volume is
# mounted and so is the workspace's own folder (it may hold factory-db-*-url).
run "shared_login_with_secrets_dir" {
  command = plan

  variables {
    gh_volume_name        = "dev-system-gh"
    workspace_secrets_dir = "/srv/ws-secrets"
  }

  override_data {
    target = data.coder_parameter.gh_login
    values = { value = "shared" }
  }
  override_data {
    target = data.coder_parameter.extra_trusted_authors
    values = { value = "" }
  }
  override_data {
    target = data.coder_parameter.git_email
    values = { value = "" }
  }

  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/persist/gh" && v.volume_name == "dev-system-gh"]) == 1
    error_message = "the shared gh volume must still be mounted"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-workspace" && v.read_only && startswith(v.host_path, "/srv/ws-secrets/")]) == 1
    error_message = "the workspace's own folder must be mounted with a shared login too"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_GH_TOKEN_FILE=")]) == 0
    error_message = "DEV_GH_TOKEN_FILE is set only for gh_login=token"
  }
}

# 3. Token mode: only this workspace's lower-cased folder, read-only; the token
# file path in the env; no shared volume; no owner identity.
run "token_mode" {
  command = plan

  variables {
    gh_volume_name        = "dev-system-gh"
    workspace_secrets_dir = "/srv/ws-secrets"
  }

  override_data {
    target = data.coder_parameter.gh_login
    values = { value = "token" }
  }
  override_data {
    target = data.coder_parameter.extra_trusted_authors
    values = { value = "" }
  }
  override_data {
    target = data.coder_parameter.git_email
    values = { value = "bot@example.com" }
  }

  assert {
    condition     = [for o in data.coder_parameter.gh_login[0].option : o.value] == ["shared", "private", "token"]
    error_message = "gh_login options must be shared, private and token"
  }
  assert {
    condition     = [for v in docker_container.workspace[0].volumes : v.host_path if v.container_path == "/run/secrets/dev-system-workspace"] == ["/srv/ws-secrets/alice/my-work"]
    error_message = "only the lower-cased per-workspace folder must be mounted"
  }
  assert {
    condition     = [for v in docker_container.workspace[0].volumes : v.read_only if v.container_path == "/run/secrets/dev-system-workspace"] == [true]
    error_message = "the per-workspace folder must be read-only"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.host_path == "/srv/ws-secrets"]) == 0
    error_message = "the whole workspace_secrets_dir must never be mounted"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/persist/gh"]) == 0
    error_message = "the shared gh volume must not be mounted in token mode"
  }
  assert {
    condition     = contains(docker_container.workspace[0].env, "DEV_GH_TOKEN_FILE=/run/secrets/dev-system-workspace/gh-token")
    error_message = "DEV_GH_TOKEN_FILE must point at the mounted token file"
  }
  assert {
    condition     = contains(docker_container.workspace[0].env, "DEV_GIT_EMAIL=bot@example.com")
    error_message = "DEV_GIT_EMAIL must be passed when git_email is set"
  }
  assert {
    condition     = length([for k in keys(coder_agent.main.env) : k if startswith(k, "GIT_")]) == 0
    error_message = "the owner's GIT_* keys must be left out in token mode"
  }
  assert {
    condition     = coder_agent.main.env.DEV_ROLE == var.role && coder_agent.main.env.DEV_RING == "consumer"
    error_message = "the other agent env keys must be unchanged"
  }
}

# 4. Extra trusted authors with an empty template list still set the variable;
# with a template list they are appended.
run "extra_trusted_authors_only" {
  command = plan

  variables {
    gh_volume_name        = ""
    workspace_secrets_dir = "/srv/ws-secrets"
    trusted_authors       = ""
  }

  override_data {
    target = data.coder_parameter.gh_login
    values = { value = "token" }
  }
  override_data {
    target = data.coder_parameter.extra_trusted_authors
    values = { value = "someone:12345" }
  }
  override_data {
    target = data.coder_parameter.git_email
    values = { value = "" }
  }

  assert {
    condition     = contains(docker_container.workspace[0].env, "CALLUM_FLOW_TRUSTED_AUTHORS=someone:12345")
    error_message = "extras alone must still set CALLUM_FLOW_TRUSTED_AUTHORS"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_GIT_EMAIL=")]) == 0
    error_message = "an empty git_email must not set DEV_GIT_EMAIL"
  }
}

run "extra_trusted_authors_appended" {
  command = plan

  variables {
    gh_volume_name        = ""
    workspace_secrets_dir = "/srv/ws-secrets"
    trusted_authors       = "cbundy:13131067"
  }

  override_data {
    target = data.coder_parameter.gh_login
    values = { value = "token" }
  }
  override_data {
    target = data.coder_parameter.extra_trusted_authors
    values = { value = "someone:12345" }
  }
  override_data {
    target = data.coder_parameter.git_email
    values = { value = "" }
  }

  assert {
    condition     = contains(docker_container.workspace[0].env, "CALLUM_FLOW_TRUSTED_AUTHORS=cbundy:13131067,someone:12345")
    error_message = "extras must be appended to the template's list"
  }
}

# 5. A workspace_secrets_dir that secrets_dir covers would reach every workspace.
run "secrets_dir_overlap_equal" {
  command = plan

  variables {
    secrets_dir           = "/etc/dev-system/secrets"
    workspace_secrets_dir = "/etc/dev-system/secrets"
  }

  expect_failures = [var.workspace_secrets_dir]
}

run "secrets_dir_overlap_under" {
  command = plan

  variables {
    secrets_dir           = "/etc/dev-system/secrets"
    workspace_secrets_dir = "/etc/dev-system/secrets/workspaces"
  }

  expect_failures = [var.workspace_secrets_dir]
}
