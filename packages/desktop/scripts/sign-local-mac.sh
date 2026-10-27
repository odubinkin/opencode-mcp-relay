#!/bin/sh
set -eu

# Local ad-hoc Electron builds cannot use Hardened Runtime without a compatible
# signing team. macOS 27's loader otherwise rejects Electron Framework before
# the application starts, even if 'codesign --verify' reports a valid signature.
# Production distribution signing / notarization uses electron-builder instead.

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Local macOS signing requires macOS" >&2
  exit 1
fi

app="${1:?Usage: sign-local-mac.sh '/path/to/OpenCode Relay.app'}"
if [ ! -d "$app/Contents/Frameworks/Electron Framework.framework" ]; then
  echo "Not an Electron app: $app" >&2
  exit 1
fi

executable=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$app/Contents/Info.plist")
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

for binary in "$app/Contents/MacOS/$executable" "$app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"; do
  if codesign -dv --verbose=4 "$binary" 2>&1 | grep -E 'flags=.*runtime' >/dev/null; then
    echo "Hardened Runtime is still enabled in $binary" >&2
    exit 1
  fi
done

# This loads the native Electron Framework through dyld without opening the GUI,
# touching the user's running OpenCode service, or taking over the app profile.
ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/$executable" --version
echo "Local Electron code signing and loader smoke test passed: $app"
