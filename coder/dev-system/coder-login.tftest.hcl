# Plan-only tests for the opt-in Coder CLI login (cbundy/dev-system#540): the
# coder_login_secrets_dir variable and the coder_login parameter gate a read-only
# token mount and DEV_CODER_TOKEN_FILE. Run by scripts/lint.sh (terraform test).

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

run "default_parameter_off" {
  command = plan

  variables {
    coder_login_secrets_dir = "/etc/dev-system/coder-login"
  }

  override_data {
    target = data.coder_parameter.coder_login
    values = { value = "false" }
  }

  assert {
    condition     = data.coder_parameter.coder_login.default == "false" && data.coder_parameter.coder_login.type == "bool"
    error_message = "the parameter must be a bool defaulting to false"
  }
  assert {
    condition     = data.coder_parameter.coder_login.mutable == true && data.coder_parameter.coder_login.order == 14
    error_message = "the parameter must be mutable, order 14"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-coder-login"]) == 0
    error_message = "no coder login mount while the parameter is off"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_CODER_TOKEN_FILE=")]) == 0
    error_message = "no DEV_CODER_TOKEN_FILE while the parameter is off"
  }
}

run "opted_in" {
  command = plan

  variables {
    coder_login_secrets_dir = "/etc/dev-system/coder-login"
  }

  override_data {
    target = data.coder_parameter.coder_login
    values = { value = "true" }
  }

  assert {
    condition = (length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-coder-login"]) == 1
      && [for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-coder-login"][0].host_path == "/etc/dev-system/coder-login"
    && [for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-coder-login"][0].read_only == true)
    error_message = "exactly one read-only mount of the variable's directory"
  }
  assert {
    condition     = contains(docker_container.workspace[0].env, "DEV_CODER_TOKEN_FILE=/run/secrets/dev-system-coder-login/coder-session-token")
    error_message = "the env must carry the token file path"
  }
}

run "variable_empty_parameter_on" {
  command = plan

  variables {
    coder_login_secrets_dir = ""
  }

  override_data {
    target = data.coder_parameter.coder_login
    values = { value = "true" }
  }

  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-coder-login"]) == 0
    error_message = "no mount while the variable is empty"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_CODER_TOKEN_FILE=")]) == 0
    error_message = "no env while the variable is empty"
  }
}

run "equals_secrets_dir_is_refused" {
  command = plan

  variables {
    secrets_dir             = "/etc/dev-system/secrets"
    coder_login_secrets_dir = "/etc/dev-system/secrets"
  }

  expect_failures = [var.coder_login_secrets_dir]
}

run "under_secrets_dir_is_refused" {
  command = plan

  variables {
    secrets_dir             = "/etc/dev-system/secrets"
    coder_login_secrets_dir = "/etc/dev-system/secrets/coder-login"
  }

  expect_failures = [var.coder_login_secrets_dir]
}

run "equals_workspace_secrets_dir_is_refused" {
  command = plan

  variables {
    workspace_secrets_dir   = "/etc/dev-system/workspaces"
    coder_login_secrets_dir = "/etc/dev-system/workspaces"
  }

  expect_failures = [var.coder_login_secrets_dir]
}

run "under_workspace_secrets_dir_is_refused" {
  command = plan

  variables {
    workspace_secrets_dir   = "/etc/dev-system/workspaces"
    coder_login_secrets_dir = "/etc/dev-system/workspaces/coder-login"
  }

  expect_failures = [var.coder_login_secrets_dir]
}
