# Plan-only tests for the stop-time wind-down: the wind_down_minutes variable, the coder_script
# that runs wind-down.sh on stop and the container stop grace. Run by scripts/lint.sh (terraform test).

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

run "default_has_no_wind_down" {
  command = plan

  assert {
    condition     = length(coder_script.wind_down) == 0
    error_message = "no stop script while wind_down_minutes is 0"
  }
  assert {
    condition     = docker_container.workspace[0].destroy_grace_seconds == null
    error_message = "no extra stop grace while wind_down_minutes is 0"
  }
}

run "ten_minutes" {
  command = plan

  variables {
    wind_down_minutes = 10
  }

  assert {
    condition     = length(coder_script.wind_down) == 1
    error_message = "one stop script with wind_down_minutes 10"
  }
  assert {
    condition     = coder_script.wind_down[0].run_on_stop == true
    error_message = "the wind-down script must run on stop"
  }
  assert {
    condition     = coder_script.wind_down[0].timeout == 645
    error_message = "the script timeout must be the cap plus 45 s"
  }
  assert {
    condition     = strcontains(coder_script.wind_down[0].script, "WIND_DOWN_CAP_MS=600000")
    error_message = "the script must carry the cap in milliseconds"
  }
  assert {
    condition     = docker_container.workspace[0].destroy_grace_seconds == 660
    error_message = "the container stop grace must be the cap plus 60 s"
  }
}

run "negative_is_refused" {
  command = plan

  variables {
    wind_down_minutes = -1
  }

  expect_failures = [var.wind_down_minutes]
}

run "fraction_is_refused" {
  command = plan

  variables {
    wind_down_minutes = 1.5
  }

  expect_failures = [var.wind_down_minutes]
}
