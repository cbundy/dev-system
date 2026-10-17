# Plan-only tests for the Docker host choice: the docker_hosts variable, its
# validations, the docker_host parameter and the provider url it resolves to. Run by
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

run "single_host_default" {
  command = plan

  assert {
    condition     = length(data.coder_parameter.docker_host) == 0
    error_message = "no docker_host parameter with a single host"
  }
  assert {
    condition     = local.docker_host_url == "unix:///var/run/docker.sock"
    error_message = "the default host must be the local socket"
  }
}

run "single_host_custom" {
  command = plan

  variables {
    docker_hosts = jsonencode([{ value = "lxc", name = "LXC", url = "ssh://coder@10.0.0.9" }])
  }

  assert {
    condition     = length(data.coder_parameter.docker_host) == 0
    error_message = "no docker_host parameter with a single host"
  }
  assert {
    condition     = local.docker_host_url == "ssh://coder@10.0.0.9"
    error_message = "the only host's url must be used"
  }
}

run "two_hosts_parameter" {
  command = plan

  variables {
    docker_hosts = jsonencode([
      { value = "host-1", name = "Host 1", url = "ssh://coder@10.0.0.1" },
      { value = "host-2", name = "Host 2", url = "ssh://coder@10.0.0.2" },
    ])
  }

  assert {
    condition     = length(data.coder_parameter.docker_host) == 1
    error_message = "two hosts must offer the docker_host parameter"
  }
  assert {
    condition     = data.coder_parameter.docker_host[0].mutable == false
    error_message = "docker_host must be immutable"
  }
  assert {
    condition     = data.coder_parameter.docker_host[0].default == "host-1"
    error_message = "docker_host must default to the first host"
  }
  assert {
    condition     = [for o in data.coder_parameter.docker_host[0].option : o.value] == ["host-1", "host-2"]
    error_message = "docker_host option values must be the host values, not urls"
  }
  assert {
    condition     = [for o in data.coder_parameter.docker_host[0].option : o.name] == ["Host 1", "Host 2"]
    error_message = "docker_host option names must be the host names"
  }
}

run "choose_host_1" {
  command = plan

  variables {
    docker_hosts = jsonencode([
      { value = "host-1", name = "Host 1", url = "ssh://coder@10.0.0.1" },
      { value = "host-2", name = "Host 2", url = "ssh://coder@10.0.0.2" },
    ])
  }

  override_data {
    target = data.coder_parameter.docker_host[0]
    values = { value = "host-1" }
  }

  assert {
    condition     = local.docker_host_url == "ssh://coder@10.0.0.1"
    error_message = "host-1 must resolve to its url"
  }
}

run "choose_host_2" {
  command = plan

  variables {
    docker_hosts = jsonencode([
      { value = "host-1", name = "Host 1", url = "ssh://coder@10.0.0.1" },
      { value = "host-2", name = "Host 2", url = "ssh://coder@10.0.0.2" },
    ])
  }

  override_data {
    target = data.coder_parameter.docker_host[0]
    values = { value = "host-2" }
  }

  assert {
    condition     = local.docker_host_url == "ssh://coder@10.0.0.2"
    error_message = "host-2 must resolve to its url"
  }
}

# The committed homelab list (terraform.tfvars; terraform test does not read it).
run "committed_tfvars" {
  command = plan

  variables {
    docker_hosts = <<-EOT
[
  {"value": "host-1", "name": "Coder host 1", "url": "ssh://coder@192.168.1.245"},
  {"value": "host-2", "name": "Coder host 2", "url": "ssh://coder@192.168.1.246"}
]
EOT
  }

  override_data {
    target = data.coder_parameter.docker_host[0]
    values = { value = "host-1" }
  }

  assert {
    condition     = data.coder_parameter.docker_host[0].default == "host-1"
    error_message = "the committed list must default to host-1"
  }
  assert {
    condition     = local.docker_host_url == "ssh://coder@192.168.1.245"
    error_message = "the committed list's host-1 must resolve to its url"
  }
  assert {
    condition     = [for o in data.coder_parameter.docker_host[0].option : o.name] == ["Coder host 1", "Coder host 2"]
    error_message = "the committed list must name the hosts Coder host 1 and Coder host 2"
  }
}

run "reject_empty_list" {
  command = plan
  variables {
    docker_hosts = "[]"
  }
  expect_failures = [var.docker_hosts]
}

run "reject_duplicate_values" {
  command = plan
  variables {
    docker_hosts = jsonencode([
      { value = "a", name = "A", url = "unix:///a" },
      { value = "a", name = "B", url = "unix:///b" },
    ])
  }
  expect_failures = [var.docker_hosts]
}

run "reject_empty_url" {
  command = plan
  variables {
    docker_hosts = jsonencode([{ value = "a", name = "A", url = "" }])
  }
  expect_failures = [var.docker_hosts]
}

run "reject_bad_json" {
  command = plan
  variables {
    docker_hosts = "not json"
  }
  expect_failures = [var.docker_hosts]
}
