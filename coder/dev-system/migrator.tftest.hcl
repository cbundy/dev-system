# Plan-only tests for the factory database migrator mount (cbundy/dev-system#888): the
# migrator_secrets_dir variable gives a read-only mount at /run/secrets/dev-system-migrator,
# and refuses a folder that workspaces without the migrator can reach. Run by scripts/lint.sh
# (terraform test).

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

# orchestrator-loop is pushed with terraform.tfvars' value.
run "set_gives_read_only_mount" {
  command = plan

  variables {
    migrator_secrets_dir = "/etc/dev-system/migrator"
  }

  assert {
    condition = (length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-migrator"]) == 1
      && [for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-migrator"][0].host_path == "/etc/dev-system/migrator"
    && [for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-migrator"][0].read_only == true)
    error_message = "exactly one read-only mount of the variable's directory"
  }
}

# dev-system is pushed with the variable empty.
run "empty_gives_no_mount" {
  command = plan

  variables {
    migrator_secrets_dir = ""
  }

  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-migrator"]) == 0
    error_message = "no mount while the variable is empty"
  }
}

run "equals_secrets_dir_is_refused" {
  command = plan

  variables {
    secrets_dir          = "/etc/dev-system/secrets"
    migrator_secrets_dir = "/etc/dev-system/secrets"
  }

  expect_failures = [var.migrator_secrets_dir]
}

run "under_secrets_dir_is_refused" {
  command = plan

  variables {
    secrets_dir          = "/etc/dev-system/secrets"
    migrator_secrets_dir = "/etc/dev-system/secrets/migrator"
  }

  expect_failures = [var.migrator_secrets_dir]
}

run "equals_workspace_secrets_dir_is_refused" {
  command = plan

  variables {
    workspace_secrets_dir = "/etc/dev-system/workspaces"
    migrator_secrets_dir  = "/etc/dev-system/workspaces"
  }

  expect_failures = [var.migrator_secrets_dir]
}

run "under_workspace_secrets_dir_is_refused" {
  command = plan

  variables {
    workspace_secrets_dir = "/etc/dev-system/workspaces"
    migrator_secrets_dir  = "/etc/dev-system/workspaces/migrator"
  }

  expect_failures = [var.migrator_secrets_dir]
}
