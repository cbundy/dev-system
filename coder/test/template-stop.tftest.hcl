# Run by template-stop.test.sh in a scratch copy of coder/dev-system: the template's stop path
# (cbundy/dev-system#467) applied against mock providers. The overrides give the data sources
# values the template can use (a started workspace, typed parameters, a known arch).
mock_provider "coder" {}
mock_provider "docker" {}

override_data {
  target = data.coder_workspace.me
  values = { start_count = 1 }
}
override_data {
  target = data.coder_provisioner.me
  values = { arch = "amd64", os = "linux" }
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
  target = data.coder_parameter.template_testing
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

run "stop" {
  command = apply

  assert {
    condition     = docker_container.workspace[0].destroy_grace_seconds == 30
    error_message = "docker_container.workspace does not have a 30s stop grace (destroy_grace_seconds)"
  }
  assert {
    condition     = coder_script.heartbeat_stop.run_on_stop
    error_message = "coder_script.heartbeat_stop does not run on stop"
  }
  assert {
    condition     = coder_script.heartbeat_stop.agent_id == coder_agent.main.id
    error_message = "coder_script.heartbeat_stop is not on coder_agent.main"
  }
  assert {
    condition     = coder_script.heartbeat_stop.script == file("${path.module}/heartbeat-stop.sh")
    error_message = "coder_script.heartbeat_stop does not run heartbeat-stop.sh"
  }
}
