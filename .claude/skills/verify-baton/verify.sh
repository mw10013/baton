#!/usr/bin/env bash
# verify-baton helper: drives this checkout's embedded app through the Playwright CLI's `dev`
# session, attached to the agent Chrome, and files evidence under .logs/verify/<run>/. Usage is in
# SKILL.md next to this file.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FRAME='iframe[src*="embedded=1"]:not([src*="chrome=window"])'
CURRENT=.logs/verify/current

cli() { vp exec playwright cli -s=dev "$@"; }

run_dir() {
  [ -L "$CURRENT" ] || { echo "No verification run is open. Run: $0 start <run-id>" >&2; exit 2; }
  echo ".logs/verify/$(readlink "$CURRENT")"
}

record() { printf -- '- %s `%s`\n' "$(date +%H:%M:%S)" "$*" >>"$(run_dir)/log.md"; }

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  doctor)
    ok=0
    vp run dev:status || ok=1
    vp run browser agent || ok=1
    echo "browser: $(cli list 2>&1 | tr '\n' ' ')"
    if [ -L "$CURRENT" ]; then echo "run:     $(readlink "$CURRENT") is open"; else echo "run:     none open"; fi
    exit $ok
    ;;
  start)
    id=${1:?usage: start <run-id>}
    dir=.logs/verify/$id
    [ -L "$CURRENT" ] && { echo "Run $(readlink "$CURRENT") is still open; stop it first." >&2; exit 2; }
    mkdir -p "$dir"
    if vp run dev:status >/dev/null 2>&1; then echo adopted >"$dir/server"; else echo started >"$dir/server"; fi
    vp run dev
    ln -sfn "$id" "$CURRENT"
    printf '# Verification run %s\n\nServer: %s. Store: %s.\n\n' "$id" "$(cat "$dir/server")" \
      "$(node --env-file=.env -p process.env.SHOPIFY_DEV_STORE)" >"$dir/log.md"
    vp run browser open
    record "start"
    echo "Run open: $dir"
    ;;
  in)
    # in <cli-command> <locator inside the app frame> [args...]
    action=${1:?usage: in <command> <locator> [args]}; locator=${2:?locator required}; shift 2
    record "in $action $locator $*"
    cli "$action" "locator('$FRAME').contentFrame().$locator" "$@"
    ;;
  top)
    # top <cli-command> [args...]: the Shopify admin's own document (App nav, hoisted title bar).
    record "top $*"
    cli "$@"
    ;;
  app)
    # app '<async function body>': `page` and `frame` (the app's FrameLocator) are in scope.
    body=${1:?usage: app '<body>'}
    record "app $body"
    cli --raw run-code "async page => { const frame = page.frameLocator('$FRAME'); $body }"
    ;;
  goto)
    # goto <app path>, e.g. app/teams: loads it inside the admin and waits for hydration.
    path=${1:-}
    record "goto $path"
    store=$(node --env-file=.env -p process.env.SHOPIFY_DEV_STORE)
    handle=$(sed -n 's/^handle = "\(.*\)"/\1/p' shopify.app.toml)
    cli goto "https://admin.shopify.com/store/$store/apps/$handle/$path" >/dev/null
    vp run browser ready >/dev/null
    echo "At /$path"
    ;;
  proof)
    name=${1:?usage: proof <name>}
    dir=$(run_dir)
    cli screenshot --filename="$dir/$name.png" >/dev/null
    cli snapshot --filename="$dir/$name.yml" >/dev/null
    cli console >"$dir/$name.console.txt" 2>&1 || true
    record "proof $name"
    echo "Saved $dir/$name.{png,yml,console.txt}"
    ;;
  note)
    record "note: $*"
    ;;
  stop)
    dir=$(run_dir)
    record "stop"
    vp run browser close || true
    if [ "$(cat "$dir/server")" = started ]; then vp run dev:stop; fi
    rm "$CURRENT"
    echo "Evidence kept in $dir"
    ;;
  *)
    echo "usage: $0 doctor | start <run-id> | goto <path> | in <cmd> <locator> [args] | top <cmd> [args] | app '<body>' | proof <name> | note <text> | stop" >&2
    exit 2
    ;;
esac
