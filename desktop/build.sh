#!/bin/sh
# Builds the Linux and Windows apps (Tauri) in Docker: nothing to install on the Mac.
#   desktop/build.sh                       Linux (.deb, .AppImage) and Windows (installer)
#   TARGETS=linux desktop/build.sh         one of them (linux, windows)
#   ENTRENOUS_RELAY=https://… desktop/build.sh   another relay built in
# → downloads/Entre-Nous-linux.deb, Entre-Nous-linux.AppImage, Entre-Nous-windows.exe
# The image is linux/amd64 (emulated on a Mac with Apple chip: the first build is slow);
# Windows is cross-compiled with cargo-xwin, which downloads Microsoft's CRT and SDK once
# (their licence applies: https://go.microsoft.com/fwlink/?LinkId=2086102).
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
IMAGE=entrenous-desktop-build
TARGETS=${TARGETS:-linux windows}

run() {
  docker run --rm --platform linux/amd64 \
    ${ENTRENOUS_RELAY:+-e ENTRENOUS_RELAY="$ENTRENOUS_RELAY"} -e APPIMAGE_EXTRACT_AND_RUN=1 \
    -v "$ROOT:/repo" -v entrenous-cargo:/root/.cargo/registry -v entrenous-xwin:/root/.cache/cargo-xwin \
    -v entrenous-desktop-target:/repo/desktop/src-tauri/target -w /repo/desktop/src-tauri "$IMAGE" sh -c "$1"
}

docker build --platform linux/amd64 -q -t "$IMAGE" desktop/docker >/dev/null
(cd web && npm run build >/dev/null)
mkdir -p downloads

for t in $TARGETS; do
  case $t in
    linux)
      run 'cargo tauri build --bundles deb,appimage \
        && cp target/release/bundle/deb/*.deb /repo/downloads/Entre-Nous-linux.deb \
        && cp target/release/bundle/appimage/*.AppImage /repo/downloads/Entre-Nous-linux.AppImage'
      echo "Built: downloads/Entre-Nous-linux.deb, downloads/Entre-Nous-linux.AppImage" ;;
    windows)
      run 'cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis \
        && cp target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe /repo/downloads/Entre-Nous-windows.exe'
      echo "Built: downloads/Entre-Nous-windows.exe" ;;
    *) echo "unknown target: $t" >&2; exit 1 ;;
  esac
done
