# Plan-only tests for the API-key budget parameters (claude_budget_usd and
# claude_budget_reset_day): present only with workspace_secrets_dir, their
# defaults and bounds, and the env they add in api-key mode only. Run by
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

override_data {
  target = data.coder_parameter.claude_budget_usd
  values = { value = "250" }
}
override_data {
  target = data.coder_parameter.claude_budget_reset_day
  values = { value = "15" }
}

run "no_secrets_dir_no_parameters" {
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
    condition     = length(data.coder_parameter.claude_budget_usd) == 0 && length(data.coder_parameter.claude_budget_reset_day) == 0
    error_message = "the budget parameters need workspace_secrets_dir"
  }
}

run "parameters_with_secrets_dir" {
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
    condition     = data.coder_parameter.claude_budget_usd[0].type == "number" && data.coder_parameter.claude_budget_usd[0].default == "0" && data.coder_parameter.claude_budget_usd[0].validation[0].min == 0
    error_message = "claude_budget_usd is a number, default 0, minimum 0"
  }
  assert {
    condition     = data.coder_parameter.claude_budget_reset_day[0].type == "number" && data.coder_parameter.claude_budget_reset_day[0].default == "1" && data.coder_parameter.claude_budget_reset_day[0].validation[0].min == 1 && data.coder_parameter.claude_budget_reset_day[0].validation[0].max == 31
    error_message = "claude_budget_reset_day is a number, default 1, from 1 to 31"
  }
  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_CLAUDE_BUDGET_")]) == 0
    error_message = "the budget variables must be unset outside api-key mode"
  }
}

run "api_key_mode_carries_the_budget" {
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
    condition     = contains(docker_container.workspace[0].env, "DEV_CLAUDE_BUDGET_USD=250") && contains(docker_container.workspace[0].env, "DEV_CLAUDE_BUDGET_RESET_DAY=15")
    error_message = "api-key mode must pass the budget and its reset day"
  }
}

run "shared_mode_carries_no_budget" {
  command = plan

  variables {
    claude_auth_volume_name = "dev-system-claude-auth"
    workspace_secrets_dir   = "/srv/ws-secrets"
  }

  override_data {
    target = data.coder_parameter.claude_login
    values = { value = "shared" }
  }

  assert {
    condition     = length([for e in docker_container.workspace[0].env : e if startswith(e, "DEV_CLAUDE_BUDGET_")]) == 0
    error_message = "shared mode must not pass the budget"
  }
}
