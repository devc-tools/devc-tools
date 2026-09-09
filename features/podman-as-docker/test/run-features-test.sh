#!/bin/bash
# Run this Feature's `devcontainer features test` scenarios (test.sh, plus anything in
# scenarios.json).
#
# Why a wrapper: `devcontainer features test` insists on a *collection* layout —
# `<project>/src/<id>/` and `<project>/test/<id>/` — while this repo keeps each Feature
# self-contained under `features/<id>/`, which is also what `devcontainer features publish`
# wants. Rather than split one Feature across two trees to satisfy one command, stage a
# throwaway copy in the layout it expects.
#
# Needs Docker and a network (a Feature may download things, and the scenarios pull images), so
# this is run deliberately, not from `deno task test`. It needs no host-side prerequisite: the
# only mounts any Feature in this collection declares are *volumes*, which Docker creates on
# demand, so there is no bind source that has to exist first.
set -euo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ID="$(basename "$FEATURE_DIR")"

# The devcontainer CLI to drive. `DEVCONTAINER_CLI` may name a *multi-word* command — it is
# split on whitespace — which is what lets devc's own embedded CLI be named as one.
#
# Resolution order, and why each rung sits where it does:
#   1. An explicit DEVCONTAINER_CLI always wins.
#   2. A `devcontainer` on PATH. This is what CI installs and version-pins
#      (.github/workflows/test-podman-as-docker.yml installs it globally before calling this
#      script), so PATH must keep beating the fallback below — otherwise CI would silently
#      start testing against a different CLI than the one it asked for.
#   3. `$DEVC_BIN __devcontainer`. Sourcing scripts/bash_aliases.sh runs devc from source as a
#      shell *function*, which a script like this one can never see — functions are not
#      inherited by child processes and a non-interactive shell loads no aliases. That file
#      exports $DEVC_BIN for exactly this reason ("lets any such consumer run devc from source
#      too, with no separate setup"), and it is multi-word, which is why DEVCONTAINER_CLI is
#      split rather than used whole. It is checked before a PATH `devc` because it is the
#      deliberate signal — it exists only if you sourced this repo's own integration, and it
#      points at this working tree rather than at whatever release was installed.
#   4. `devc` on PATH — a compiled install.
#
# Rungs 3 and 4 both use `__devcontainer`, the hidden subcommand that turns devc into the
# devcontainer CLI it embeds (devc/devcontainer_selfexec.ts). devc exists so that "neither
# `devcontainer` nor `node` has to exist on the host"; without these rungs these tests were the
# one thing in the repo that still demanded a separate global install. The embedded CLI is
# version-pinned in devc/deno.json, and that pin is the version devc's own users get — so this
# tests against the CLI that actually matters.
if [ -n "${DEVCONTAINER_CLI:-}" ]; then
  read -r -a CLI_CMD <<< "$DEVCONTAINER_CLI"
elif command -v devcontainer > /dev/null 2>&1; then
  CLI_CMD=(devcontainer)
elif [ -n "${DEVC_BIN:-}" ]; then
  read -r -a CLI_CMD <<< "$DEVC_BIN"
  CLI_CMD+=(__devcontainer)
elif command -v devc > /dev/null 2>&1; then
  CLI_CMD=(devc __devcontainer)
else
  echo "run-features-test.sh: no devcontainer CLI found. Any one of these fixes it:" >&2
  echo "  - source scripts/bash_aliases.sh — exports \$DEVC_BIN, runs devc from source" >&2
  echo "  - install devc — it embeds the CLI, nothing else to install" >&2
  echo "  - npm install --global @devcontainers/cli" >&2
  echo "  - set DEVCONTAINER_CLI to the command to run (may be multi-word)" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/src/$ID" "$STAGE/test/$ID"
# The whole Feature directory minus its tests, rather than a list of files to keep in step
# with the Feature — a Feature that ships scripts/ alongside install.sh would otherwise stage
# an incomplete copy and fail inside the container, far from the omission. This file is
# identical in every Feature; copy it as-is. (The two nesting Features, podman-as-docker and
# rootless-remap, add one further step of their own below — a seccomp profile the scenarios'
# runArgs name by absolute path. Everything else is shared verbatim.)
cp -R "$FEATURE_DIR"/. "$STAGE/src/$ID/"
rm -rf "$STAGE/src/$ID/test"
# And the whole test directory, for the same reason in the other direction: the command reads
# test.sh, an optional scenarios.json, one script per scenario and an optional per-scenario
# config folder, and staging only test.sh silently drops every scenario a Feature declares.
cp -R "$FEATURE_DIR/test"/. "$STAGE/test/$ID/"
rm -f "$STAGE/test/$ID/run-features-test.sh"

# This Feature grants no capability; rootless podman inside the scenarios works because their
# runArgs carry a seccomp profile — the same one consumers commit to their repos. Scenario
# runArgs are plain strings the Docker CLI resolves on the host, so the file is copied to one
# fixed absolute path that scenarios.json names. (The autogenerated default scenario has no
# runArgs at all, so test.sh checks the build, not a `docker run`.)
if [ -f "$FEATURE_DIR/seccomp-podman.json" ]; then
  cp "$FEATURE_DIR/seccomp-podman.json" /tmp/devc-podman-as-docker-seccomp.json
fi

# `--base-image`/`-i` only reaches the autogenerated default scenario (test.sh) — every named
# scenario in scenarios.json pins its own "image" regardless. Left unset, the CLI's own default
# is ubuntu:focal (20.04), which lacks curl and trips installers that assume it. Default instead
# to the floating tag every named scenario in this collection already uses, unless the caller
# passed their own (e.g. the podman-as-docker/rootless-remap CI, which needs a specific image).
BASE_IMAGE_ARGS=()
_has_base_image=0
for _arg in "$@"; do
  case "$_arg" in
    --base-image | --base-image=* | -i) _has_base_image=1 ;;
  esac
done
if [ "$_has_base_image" -eq 0 ]; then
  BASE_IMAGE_ARGS=(--base-image mcr.microsoft.com/devcontainers/base:ubuntu)
fi

exec "${CLI_CMD[@]}" features test --project-folder "$STAGE" --features "$ID" \
  "${BASE_IMAGE_ARGS[@]}" "$@"
