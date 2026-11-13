#!/bin/sh
# Builds the Android app in Docker (JDK + Android SDK in the image, nothing on the Mac):
# a signed release APK, copied to downloads/Entre-Nous-android.apk for the landing page.
#   android/build.sh
# The signing key lives outside the repo, in ~/.config/entrenous (SIGNING=… to change):
# keep a copy, an update must be signed with the same key to install over the app.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SIGNING=${SIGNING:-$HOME/.config/entrenous}
IMAGE=entrenous-android-build
# Version: 0.1.<number of commits>, the same as the other apps built from this commit
APP_BUILD=$(git rev-list --count HEAD)
export APP_VERSION=${APP_VERSION:-0.1.$APP_BUILD}
run() {
  docker run --rm --platform linux/amd64 -e APP_BUILD="$APP_BUILD" -e APP_VERSION="$APP_VERSION" \
    -v "$ROOT:/repo" -v "$SIGNING:/signing" \
    -v entrenous-gradle:/root/.gradle -w /repo/android "$IMAGE" "$@"
}

docker build --platform linux/amd64 -q -t "$IMAGE" android/docker >/dev/null

# Signing key, created once
mkdir -p "$SIGNING" && chmod 700 "$SIGNING"
if [ ! -f "$SIGNING/android-release.jks" ]; then
  PASS=$(openssl rand -hex 24)
  run keytool -genkeypair -keystore /signing/android-release.jks -alias entrenous \
    -keyalg RSA -keysize 4096 -validity 36500 -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=Entre Nous" >/dev/null 2>&1
  printf 'storeFile=/signing/android-release.jks\nstorePassword=%s\nkeyAlias=entrenous\nkeyPassword=%s\n' "$PASS" "$PASS" \
    > "$SIGNING/android-signing.properties"
  chmod 600 "$SIGNING/android-signing.properties" "$SIGNING/android-release.jks"
  echo "New signing key: $SIGNING/android-release.jks (back it up)"
fi

# Digital Asset Links: invitation links open the app (fingerprint of the signing key)
PASS=$(sed -n 's/^storePassword=//p' "$SIGNING/android-signing.properties")
SHA=$(run keytool -list -v -keystore /signing/android-release.jks -alias entrenous -storepass "$PASS" \
  | sed -n 's/^.*SHA256: *//p' | head -1 | tr -d '\r')
mkdir -p web/public/.well-known
cat > web/public/.well-known/assetlinks.json <<JSON
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": { "namespace": "android_app", "package_name": "dev.xdba.entrenous", "sha256_cert_fingerprints": ["$SHA"] }
}]
JSON

(cd web && npm run build >/dev/null && npx cap sync android >/dev/null)
run ./gradlew --no-daemon -q assembleRelease
mkdir -p downloads
cp android/app/build/outputs/apk/release/app-release.apk downloads/Entre-Nous-android.apk
chmod 755 web/public/.well-known && chmod 644 downloads/Entre-Nous-android.apk web/public/.well-known/assetlinks.json
echo "Built: downloads/Entre-Nous-android.apk"
