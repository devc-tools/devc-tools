#!/bin/bash
# Scenario: the Docker-API socket, explicit rather than relying on the default. Kept as
# its own focused scenario even though the default test.sh scenario already exercises
# this — belt-and-braces for the one thing DOCKER_HOST consumers actually depend on.
set -e

source dev-container-features-test-lib

SOCK=/run/devc-features/podman-as-docker/podman.sock

check "the socket exists after start" test -S "$SOCK"
check "DOCKER_HOST names it" bash -c "[ \"\$DOCKER_HOST\" = \"unix://$SOCK\" ]"
check "docker -H \$DOCKER_HOST ps succeeds" bash -c "docker -H \"\$DOCKER_HOST\" ps"
check "and so does a plain docker ps (DOCKER_HOST is already in the environment)" docker ps
check "restarting the service is idempotent — a second post-start.sh run changes nothing" \
  bash -c "bash /usr/local/share/devc-features/podman-as-docker/post-start.sh &&
           docker -H \"\$DOCKER_HOST\" ps"

reportResults
