#!/bin/bash
# Scenario: dockerShim: false — podman is installed and usable, but /usr/bin/docker is
# not, since nobody asked podman-docker to provide it.
set -e

source dev-container-features-test-lib

check "podman is present" bash -c "command -v podman"
check "docker is absent" bash -c "! command -v docker"
check "podman-docker was not installed" bash -c "! dpkg -s podman-docker >/dev/null 2>&1"
check "podman itself still works" podman run --rm docker.io/library/alpine true

reportResults
