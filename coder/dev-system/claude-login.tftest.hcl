# Plan-only tests for the claude_login choice: which options appear per
# variable, the default, and the API-key env (cbundy/dev-system#1113). Run by
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

run "neither_variable" {
  command = plan

  variables {
    claude_auth_volume_name = ""
    workspace_secrets_dir   = ""
  }

  assert {
    condition     = length(data.coder_parameter.claude_login) == 0
    error_message = "claude_login must be absent with neither variable set"
  }

  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_CLAUDE_AUTH=") || startswith(e, "DEV_CLAUDE_API_KEY_FILE=")]) == 0
    error_message = "the API-key variables must be unset outside api-key mode"
  }
}

run "secrets_dir_only" {
  command = plan

  variables {
    claude_auth_volume_name = ""
    workspace_secrets_dir   = "/srv/ws-secrets"
  }

  override_data {
    target = data.coder_parameter.claude_login
    values = { value = "private" }
  }


  assert {
    condition     = [for o in data.coder_parameter.claude_login[0].option : o.value] == ["private", "api-key"]
    error_message = "claude_login options are wrong"
  }
  assert {
    condition     = data.coder_parameter.claude_login[0].default == "private"
    error_message = "claude_login must default to private"
  }

  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_CLAUDE_AUTH=") || startswith(e, "DEV_CLAUDE_API_KEY_FILE=")]) == 0
    error_message = "the API-key variables must be unset outside api-key mode"
  }
}

run "volume_only" {
  command = plan

  variables {
    claude_auth_volume_name = "dev-system-claude-auth"
    workspace_secrets_dir   = ""
  }

  override_data {
    target = data.coder_parameter.claude_login
    values = { value = "shared" }
  }


  assert {
    condition     = [for o in data.coder_parameter.claude_login[0].option : o.value] == ["shared", "private"]
    error_message = "claude_login options are wrong"
  }
  assert {
    condition     = data.coder_parameter.claude_login[0].default == "private"
    error_message = "claude_login must default to private"
  }

  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_CLAUDE_AUTH=") || startswith(e, "DEV_CLAUDE_API_KEY_FILE=")]) == 0
    error_message = "the API-key variables must be unset outside api-key mode"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/persist/claude-auth"]) == 1
    error_message = "shared mounts the claude-auth volume"
  }
}

run "both_variables_private" {
  command = plan

  variables {
    claude_auth_volume_name = "dev-system-claude-auth"
    workspace_secrets_dir   = "/srv/ws-secrets"
  }

  override_data {
    target = data.coder_parameter.claude_login
    values = { value = "private" }
  }


  assert {
    condition     = [for o in data.coder_parameter.claude_login[0].option : o.value] == ["shared", "private", "api-key"]
    error_message = "claude_login options are wrong"
  }
  assert {
    condition     = data.coder_parameter.claude_login[0].default == "private"
    error_message = "claude_login must default to private"
  }

  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_CLAUDE_AUTH=") || startswith(e, "DEV_CLAUDE_API_KEY_FILE=")]) == 0
    error_message = "the API-key variables must be unset outside api-key mode"
  }
}

run "api_key_mode" {
  command = plan

  variables {
    claude_auth_volume_name = "dev-system-claude-auth"
    workspace_secrets_dir   = "/srv/ws-secrets"
  }

  override_data {
    target = data.coder_parameter.claude_login
    values = { value = "api-key" }
  }


  assert {
    condition     = contains(docker_container.workspace[0].env, "DEV_CLAUDE_AUTH=api-key")
    error_message = "api-key mode must set DEV_CLAUDE_AUTH"
  }
  assert {
    condition     = contains(docker_container.workspace[0].env, "DEV_CLAUDE_API_KEY_FILE=/run/secrets/dev-system-workspace/anthropic-api-key")
    error_message = "api-key mode must point at the key file"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "CLAUDE_SECURESTORAGE_CONFIG_DIR=") || strcontains(e, "sk-ant")]) == 0
    error_message = "api-key mode sets no shared-auth dir and no key"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/persist/claude-auth"]) == 0
    error_message = "api-key mode mounts no claude-auth volume"
  }
  assert {
    condition     = length([for v in docker_container.workspace[0].volumes : v if v.container_path == "/run/secrets/dev-system-workspace"]) == 1
    error_message = "api-key mode reads the key from the workspace's folder"
  }
}
