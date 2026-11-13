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
# Version: 0.1.<number of commits>, the same as the other apps built from this commit
export APP_VERSION=${APP_VERSION:-0.1.$(git rev-list --count HEAD)}

run() {
  docker run --rm --platform linux/amd64 \
    ${ENTRENOUS_RELAY:+-e ENTRENOUS_RELAY="$ENTRENOUS_RELAY"} -e APPIMAGE_EXTRACT_AND_RUN=1 \
    -e TAURI_CONFIG="{\"version\":\"$APP_VERSION\"}" \
    -v "$ROOT:/repo" -v entrenous-cargo:/root/.cargo/registry -v entrenous-xwin:/root/.cache/cargo-xwin \
    -v entrenous-tauri:/root/.cache/tauri \
    -v entrenous-desktop-target:/repo/desktop/src-tauri/target -w /repo/desktop/src-tauri "$IMAGE" sh -c "$1"
}

docker build --platform linux/amd64 -q -t "$IMAGE" desktop/docker >/dev/null
(cd web && npm run build >/dev/null)
mkdir -p downloads

for t in $TARGETS; do
  case $t in
    linux)
      # The AppImage tools (linuxdeploy) are AppImages themselves: under emulation (Docker on a
      # Mac with Apple chip) they fail with "Exec format error" because of their magic bytes
      # (offset 8, "AI\2"); blanking them is harmless. Tauri downloads them at the first try.
      run 'fix() { for f in /root/.cache/tauri/*.AppImage; do [ -f "$f" ] && printf "\0\0\0" | dd of="$f" bs=1 seek=8 count=3 conv=notrunc 2>/dev/null; done; true; }
        fix; { cargo tauri build --bundles deb,appimage || { fix && cargo tauri build --bundles appimage; }; } \
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
