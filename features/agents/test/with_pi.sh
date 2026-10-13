#!/bin/bash
# Scenario `with_pi` — installPiCli: true, alongside a node Feature. The default scenario
# (test.sh) already asserts pi stays absent when the option is left at its default; this is the
# other half, and the only scenario that exercises install.sh's node prelude against a real
# container: pi installs itself with npm, and at build time node is on disk but not on a
# non-interactive shell's PATH.
set -e

source dev-container-features-test-lib

check "pi is on PATH" bash -c "command -v pi"
check "pi is executable by the remote user" test -x "$(command -v pi)"

# The prelude pins npm's global prefix to ~/.local precisely so this holds. Unpinned, npm under
# nvm resolves the prefix to the *active node version's* own directory, and pi would drop out of
# PATH the moment node-nvmrc switched the container onto a different version for a project's
# .nvmrc — and install.sh's `[ ! -x "$HOME/.local/bin/pi" ]` guard would re-download it every
# rebuild. This is the assertion that catches losing that pin.
check "pi landed in ~/.local/bin, not in the active nvm node version's directory" \
  test -x "$HOME/.local/bin/pi"
check "and that is the pi the remote user's PATH resolves" \
  test "$(command -v pi)" = "$HOME/.local/bin/pi"

# pi's installer defaults to ~/.pi/agent/install, but ~/.pi is a mount at run time, and a mount
# there (a host bind, or an older volume) hides whatever the image put under it. install.sh
# points the installer at ~/.local/share/pi instead.
check "pi resolves under ~/.local/share/pi" bash -c \
  "case \"\$(readlink -f \"\$HOME/.local/bin/pi\")\" in \"\$HOME/.local/share/pi/\"*) ;; *) exit 1 ;; esac"
check "and nothing of pi's own is under ~/.pi/agent/install" test ! -e "$HOME/.pi/agent/install"
check "pi runs" pi --version

# The Claude CLI still installs alongside it — installPiCli does not turn installClaudeCli off,
# the three options are independent.
check "claude is still on PATH too" bash -c "command -v claude"

reportResults
