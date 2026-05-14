#!/usr/bin/env bash
# Optional: symlink public/models and public/splats from the original
# fpsAnywhere-GaussianUpgrade project so pre-existing assets are available.
#
# Usage:
#   GAUSSIAN_PROJECT=/path/to/fpsAnywhere-GaussianUpgrade bash setup.sh
#
# If GAUSSIAN_PROJECT is unset, no symlinks are created and the template
# runs fine with empty public/models and public/splats directories
# (users upload their own assets via the browser UI).

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$GAUSSIAN_PROJECT" ]; then
  echo "GAUSSIAN_PROJECT not set — skipping asset symlinks."
  echo "Run: GAUSSIAN_PROJECT=/path/to/fpsAnywhere-GaussianUpgrade bash setup.sh"
  exit 0
fi

for dir in models splats; do
  src="$GAUSSIAN_PROJECT/public/$dir"
  dest="$SCRIPT_DIR/public/$dir"
  if [ -d "$src" ]; then
    rm -rf "$dest"
    ln -sf "$src" "$dest"
    echo "Linked public/$dir → $src"
  else
    echo "Skipping $dir (not found at $src)"
  fi
done

echo "Setup complete."
