# syntax=docker/dockerfile:1
#
# dev-system's own dev environment: ghcr.io/cbundy/dev-system/dev
#
# The base image plus the tools only this repo needs (cbundy/dev-system#117):
# terraform, for `npm run lint`'s fmt and validate checks on coder/dev-system.
# It is a per-repo image like any consumer's (docs/onboarding.md, step 3e;
# images/base/README.md, "Extending the image"): no ENTRYPOINT, VOLUME,
# /persist or devcontainer.metadata changes, so the base image's contract and
# metadata apply unchanged. Built by .github/workflows/publish-dev-image.yml,
# and locally by the devcontainer CLI or VS Code from .devcontainer/.

FROM ghcr.io/cbundy/dev-system/base:2

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

USER root

# terraform, pinned by version and checksum like agentsview in the base image:
# the version is the one CI checks coder/ with, so a bump is deliberate. The
# checksums are from terraform_<version>_SHA256SUMS on releases.hashicorp.com
# (signature checked against HashiCorp's release key when pinned).
ARG TERRAFORM_VERSION=1.16.5
ARG TERRAFORM_SHA256_AMD64=2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4
ARG TERRAFORM_SHA256_ARM64=61a50b00485ee4810cf20581ef080fc54d34d666e175c58d9a10501c65c1ccde
RUN arch=$(dpkg --print-architecture) \
  && case "$arch" in \
    amd64) sha256="$TERRAFORM_SHA256_AMD64" ;; \
    arm64) sha256="$TERRAFORM_SHA256_ARM64" ;; \
    *) echo "terraform: unsupported architecture $arch" >&2; exit 1 ;; \
  esac \
  && tmp=$(mktemp -d) \
  && curl -fsSL -o "$tmp/terraform.zip" \
    "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" \
  && echo "$sha256  $tmp/terraform.zip" | sha256sum -c - \
  && unzip -q "$tmp/terraform.zip" terraform -d "$tmp" \
  && install -m 0755 "$tmp/terraform" /usr/local/bin/terraform \
  && rm -rf "$tmp" \
  && terraform version

USER node

# The repo a headless container clones on its first start (images/base/README.md,
# "Workspace and repo"). CI passes this repo's clone URL, so a Coder workspace
# on the published image needs no repo_url parameter. A local build (the
# desktop dev container) leaves it empty: there the checkout is bind-mounted,
# and a URL would make dev-init clone a second copy beside it.
ARG DEV_REPO_URL=
# CHECKPOINT_DISABLE: no terraform update check or telemetry ping, as the
# base image does for agentsview.
ENV DEV_REPO_URL=${DEV_REPO_URL} \
  CHECKPOINT_DISABLE=1

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
# This layer's release stamp (cbundy/dev-system#271), read by dev-version
# (images/base/README.md, "Tags and versioning"). TAG=latest: the published
# tags are latest and sha-<short>, so the default (major of VERSION) would not
# resolve.
USER root
RUN mkdir -p /usr/local/share/dev-system/image-release.d \
  && printf '%s\n' \
    "IMAGE=ghcr.io/cbundy/dev-system/dev" \
    "VERSION=${VERSION}" \
    "REVISION=${REVISION}" \
    "CREATED=${CREATED}" \
    "TAG=latest" \
    > /usr/local/share/dev-system/image-release.d/dev \
  && chmod 0644 /usr/local/share/dev-system/image-release.d/dev
USER node
LABEL org.opencontainers.image.source="https://github.com/cbundy/dev-system" \
  org.opencontainers.image.revision="${REVISION}" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.created="${CREATED}" \
  org.opencontainers.image.base.name="ghcr.io/cbundy/dev-system/base:2" \
  org.opencontainers.image.title="dev-system dev" \
  org.opencontainers.image.description="dev-system's own dev environment: the dev-system base image plus terraform. Rebuilt on every change and weekly; tags are mutable."
