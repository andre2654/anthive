#!/bin/sh
# Anthive installer — macOS only (Apple Silicon and Intel).
#   curl -fsSL https://raw.githubusercontent.com/andre2654/anthive/main/install.sh | sh
#   … | sh -s -- --alias        also links `ai` to it
set -e
REPO="andre2654/anthive"
BIN_DIR="${ANTHIVE_BIN_DIR:-$HOME/.local/bin}"
case "$(uname -s)" in Darwin) ;; *) echo "anthive 0.1 runs on macOS only"; exit 1;; esac
case "$(uname -m)" in arm64) ARCH=arm64;; x86_64) ARCH=x64;; *) echo "unsupported arch: $(uname -m)"; exit 1;; esac
ALIAS=no; for a in "$@"; do [ "$a" = "--alias" ] && ALIAS=yes; done
URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o "https://[^\"]*anthive-darwin-$ARCH" | head -1)
[ -n "$URL" ] || { echo "no release asset for darwin-$ARCH found — build from source: bun run build"; exit 1; }
mkdir -p "$BIN_DIR"
echo "downloading $URL"
curl -fsSL "$URL" -o "$BIN_DIR/anthive.tmp" && mv "$BIN_DIR/anthive.tmp" "$BIN_DIR/anthive" && chmod +x "$BIN_DIR/anthive"
[ "$ALIAS" = yes ] && ln -sf "$BIN_DIR/anthive" "$BIN_DIR/ai" && echo "alias: ai -> anthive"
echo "installed: $BIN_DIR/anthive"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "add to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"";; esac
"$BIN_DIR/anthive" doctor || true
