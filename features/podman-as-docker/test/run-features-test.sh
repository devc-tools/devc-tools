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
# this is run deliberately, not from `deno task test`. It needs no host-side prerequisite: no
# Feature in this collection declares a mount, so there are no bind sources to exist.
set -euo pipefail

FEATURE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ID="$(basename "$FEATURE_DIR")"
CLI="${DEVCONTAINER_CLI:-devcontainer}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/src/$ID" "$STAGE/test/$ID"
# The whole Feature directory minus its tests, rather than a list of files to keep in step
# with the Feature — a Feature that ships scripts/ alongside install.sh would otherwise stage
# an incomplete copy and fail inside the container, far from the omission. This file is
# identical in every Feature; copy it as-is.
cp -R "$FEATURE_DIR"/. "$STAGE/src/$ID/"
rm -rf "$STAGE/src/$ID/test"
# And the whole test directory, for the same reason in the other direction: the command reads
# test.sh, an optional scenarios.json, one script per scenario and an optional per-scenario
# config folder, and staging only test.sh silently drops every scenario a Feature declares.
cp -R "$FEATURE_DIR/test"/. "$STAGE/test/$ID/"
rm -f "$STAGE/test/$ID/run-features-test.sh"

exec "$CLI" features test --project-folder "$STAGE" --features "$ID" "$@"
