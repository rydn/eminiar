#!/bin/sh
# Sourced by bin/em-server, bin/em-hook and bin/eminiar (never executed directly).
# Sets NODE (the Node binary to run) and RUN (the package root whose dist/ to run).
#
# Claude Code may launch a plugin from the copy it keeps under
# ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>. That copy carries dist/
# but no node_modules/, so dist/*.js cannot import better-sqlite3 and friends. The
# installer pins the stable copy (~/.eminiar/plugin/node_modules/eminiar, with its
# dependencies beside it) in $EMINIAR_HOME/root-path; when the directory this shim
# lives in cannot run (see em_runnable), we run the pinned copy's dist/ instead.
EM_HOME="${EMINIAR_HOME:-$HOME/.eminiar}"
# EM_SELF: the shim's real path when it was reached through a symlink (bin/eminiar).
DIR="$(cd "$(dirname "${EM_SELF:-$0}")/.." && pwd)"

# V8 compile cache (Node >= 22.1): bytecode for dist/*.js is reused across launches,
# trimming server and hook start-up. Older Node ignores the variable.
if [ -z "$NODE_COMPILE_CACHE" ]; then
  NODE_COMPILE_CACHE="$EM_HOME/compile-cache"
  export NODE_COMPILE_CACHE
fi

# Node: the binary pinned at install time (so nvm/volta PATHs never matter), else PATH.
NODE=""
if [ -f "$EM_HOME/node-path" ]; then
  NODE="$(cat "$EM_HOME/node-path" 2>/dev/null)"
fi
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null)"
fi

# A package root is runnable when the dist/ entry this shim runs (EM_ENTRY) is built and its
# dependencies resolve: node_modules/ inside it (dev checkout, npm -g) or beside it (stable copy
# inside ~/.eminiar/plugin/node_modules). A copy Claude Code makes from a git marketplace has
# node_modules/ (Claude Code installs the dependencies) but no dist/, which is gitignored.
em_runnable() {
  [ -f "$1/dist/${EM_ENTRY:-server}.js" ] || return 1
  [ -e "$1/node_modules/better-sqlite3/package.json" ] || [ -e "$1/../better-sqlite3/package.json" ]
}

RUN="$DIR"
if ! em_runnable "$DIR"; then
  RUN=""
  if [ -f "$EM_HOME/root-path" ]; then
    ALT="$(cat "$EM_HOME/root-path" 2>/dev/null)"
    if [ -n "$ALT" ] && em_runnable "$ALT"; then
      RUN="$ALT"
      # Point version/grammar lookups at the code that actually runs; keep the
      # launch directory for diagnostics (em_doctor shows "launched from").
      EMINIAR_PLUGIN_ROOT="$ALT"
      EMINIAR_LAUNCH_ROOT="$DIR"
      export EMINIAR_PLUGIN_ROOT EMINIAR_LAUNCH_ROOT
    fi
  fi
fi
