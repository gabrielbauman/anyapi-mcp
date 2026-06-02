#!/bin/sh
# anyapi-mcp installer: build the CLI from source and drop it on your PATH.
#
#   curl -fsSL https://gabrielbauman.github.io/anyapi-mcp/install.sh | sh
#
# Overridable via environment:
#   ANYAPI_MCP_REF      git ref (branch or tag) to install   (default: main)
#   ANYAPI_MCP_BIN_DIR  directory to install the binary into  (default: ~/.local/bin)
set -eu

REPO="gabrielbauman/anyapi-mcp"
REF="${ANYAPI_MCP_REF:-main}"
BIN_DIR="${ANYAPI_MCP_BIN_DIR:-$HOME/.local/bin}"
BIN_NAME="anyapi-mcp"

info() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; }

# 1. Deno is required - both to build here and at runtime, since `execute` runs
#    the model's code in a `deno` subprocess.
if ! command -v deno >/dev/null 2>&1; then
  err "Deno 2.x is required but was not found on your PATH."
  info "Install Deno, then re-run this script:"
  info "  curl -fsSL https://deno.land/install.sh | sh"
  info "  (or see https://deno.com/)"
  exit 1
fi

deno_major="$(deno --version 2>/dev/null | sed -n 's/^deno \([0-9][0-9]*\).*/\1/p')"
if [ -n "$deno_major" ] && [ "$deno_major" -lt 2 ] 2>/dev/null; then
  err "Found $(deno --version | head -n1)."
  err "anyapi-mcp needs Deno 2.x - please upgrade and re-run."
  exit 1
fi

# 2. Fetch the source into a temp dir (--strip-components drops the <repo>-<ref>/ prefix).
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
tarball="https://codeload.github.com/$REPO/tar.gz/$REF"

info "Downloading $REPO@$REF ..."
curl -fsSL "$tarball" -o "$tmp/src.tar.gz"
mkdir -p "$tmp/src"
tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components=1

# 3. Compile the self-contained binary.
info "Building $BIN_NAME (deno task compile) ..."
(cd "$tmp/src" && deno task compile)

# 4. Install it onto PATH.
mkdir -p "$BIN_DIR"
mv "$tmp/src/$BIN_NAME" "$BIN_DIR/$BIN_NAME"
chmod +x "$BIN_DIR/$BIN_NAME"
info "Installed $BIN_NAME to $BIN_DIR/$BIN_NAME"

# 5. PATH hint, then next steps.
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    info ""
    info "note: $BIN_DIR is not on your PATH. Add it to your shell profile:"
    info "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

info ""
info "Done. Next:"
info "  $BIN_NAME install        # register it with Claude Code and/or Claude Desktop"
info "  $BIN_NAME add https://petstore3.swagger.io/api/v3/openapi.json"
