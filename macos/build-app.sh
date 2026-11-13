#!/bin/sh
# Builds "Entre Nous.app" in macos/build/: the web UI bundled inside, signed with the
# "Entre Nous" identity (./signing-identity.sh) or ad hoc.
#   ./build-app.sh            release build for this Mac
#   UNIVERSAL=1 ./build-app.sh   Apple silicon + Intel (for the download), and a .zip in downloads/
#   RELAY=http://127.0.0.1:8080 ./build-app.sh && open "build/Entre Nous.app"   (local relay)
set -eu
cd "$(dirname "$0")"
ROOT=$(pwd)
APP="$ROOT/build/Entre Nous.app"
# Version: 0.1.<number of commits>, the same as the other apps built from this commit
APP_BUILD=$(git rev-list --count HEAD)
export APP_VERSION=${APP_VERSION:-0.1.$APP_BUILD}

(cd ../web && npm run build >/dev/null)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
if [ -n "${UNIVERSAL:-}" ]; then
  # without Xcode, SwiftPM builds one architecture at a time: lipo joins them
  swift build -c release --triple arm64-apple-macosx14.0
  swift build -c release --triple x86_64-apple-macosx14.0
  lipo -create -output "$APP/Contents/MacOS/EntreNous" \
    .build/arm64-apple-macosx/release/EntreNous .build/x86_64-apple-macosx/release/EntreNous
else
  swift build -c release
  cp .build/release/EntreNous "$APP/Contents/MacOS/EntreNous"
fi
cp -R ../web/dist/app "$APP/Contents/Resources/web"

# Icon (.icns) from the PWA icon
ICONSET=$(mktemp -d)/AppIcon.iconset
mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512; do
  sips -z $s $s ../web/public/app/icon-512.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
done
for s in 16 32 128 256; do cp "$ICONSET/icon_$((s * 2))x$((s * 2)).png" "$ICONSET/icon_${s}x${s}@2x.png"; done
cp ../web/public/app/icon-512.png "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Entre Nous</string>
  <key>CFBundleDisplayName</key><string>Entre Nous</string>
  <key>CFBundleIdentifier</key><string>dev.0xdba.entrenous</string>
  <key>CFBundleExecutable</key><string>EntreNous</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
  <key>CFBundleVersion</key><string>$APP_BUILD</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>Entre Nous transfère tes contenus directement entre tes appareils quand ils sont sur le même réseau.</string>
</dict>
</plist>
PLIST

# Stable identity (./signing-identity.sh, once per Mac): the Keychain then recognises every
# new build; otherwise ad hoc, and each build asks again for the session password.
if security find-certificate -c "Entre Nous" >/dev/null 2>&1; then
  codesign --force --deep --sign "Entre Nous" "$APP"
else
  echo "Signature ad hoc : lance ./signing-identity.sh pour ne plus avoir les demandes du Trousseau" >&2
  codesign --force --deep --sign - "$APP"
fi
if [ -n "${RELAY:-}" ]; then defaults write dev.0xdba.entrenous relay "$RELAY"; fi
echo "Built: $APP"
if [ -n "${UNIVERSAL:-}" ]; then
  mkdir -p ../downloads
  rm -f ../downloads/Entre-Nous-mac.zip
  ditto -c -k --sequesterRsrc --keepParent "$APP" ../downloads/Entre-Nous-mac.zip
  echo "Zipped: downloads/Entre-Nous-mac.zip"
fi
