#!/bin/bash
# Scenario: this Feature beside ghcr.io/devc-tools/features/godot, rendering a real frame.
#
# The claim under test is the one this Feature exists for: with a virtual display and software
# OpenGL, Godot renders — not "runs", renders. The scenario's onCreateCommand writes a
# one-scene project (a red rectangle on the default grey clear colour) into ./render, and
# --write-movie captures frames of it.
#
# A file existing is not enough: the typical failure here is silent, a correctly sized PNG of
# one flat colour. So the last frame has to contain more than one colour, counted with
# ImageMagick (`tools: true`), which also has to see the same thing on the X screen itself.
set -e

source dev-container-features-test-lib

OUT=/tmp/xvfb-godot-render
rm -rf "$OUT"
mkdir -p "$OUT"

check "the fixture project is in place" test -f render/project.godot
check "no display until one is asked for" bash -c '[ -z "${DISPLAY:-}" ]'

eval "$(xvfb-ensure)"
check "xvfb-ensure gave a display" xdpyinfo

# Never --headless: that selects the dummy renderer, and --write-movie refuses to run under it.
check "godot renders three frames" godot --path render --rendering-driver opengl3 \
  --audio-driver Dummy --fixed-fps 60 --write-movie "$OUT/frame.png" --quit-after 3 \
  res://main.tscn

check "PNG frames were written" bash -c "ls $OUT/frame*.png > /dev/null"
LAST="$(ls "$OUT"/frame*.png | sort | tail -1)"
check "the last frame is a PNG of the project's window size" bash -c \
  "[ \"\$(identify -format '%m %wx%h' '$LAST')\" = 'PNG 320x240' ]"
check "and is not one flat colour" bash -c "[ \"\$(identify -format '%k' '$LAST')\" -gt 1 ]"
# The rectangle covers the left half, so these two pixels differ in any frame that drew it.
check "the rectangle is where the scene put it" bash -c \
  "[ \"\$(convert '$LAST' -format '%[pixel:p{40,120}]' info:)\" != \"\$(convert '$LAST' -format '%[pixel:p{280,120}]' info:)\" ]"

check "xvfb-ensure --stop exits 0" xvfb-ensure --stop

reportResults
