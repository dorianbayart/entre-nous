# Build image of the Linux and Windows apps (Tauri): nothing to install on the Mac.
#  - Ubuntu 22.04: an old enough glibc for the Linux build to run on most distributions;
#  - Windows: cross-compiled with cargo-xwin (MSVC headers and libraries downloaded at the
#    first build, cached in a volume) and packaged with NSIS.
FROM ubuntu:jammy
ENV DEBIAN_FRONTEND=noninteractive PATH=/root/.cargo/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl wget file pkg-config git \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
      libdbus-1-dev imagemagick \
      nsis lld llvm clang \
 && rm -rf /var/lib/apt/lists/*
# NSIS 3.08 (Ubuntu 22.04) lacks a header that Tauri's installer script includes (NSIS ≥ 3.09)
RUN curl -sSfL -o /usr/share/nsis/Include/Win/RestartManager.nsh \
      https://raw.githubusercontent.com/kichik/nsis/master/Include/Win/RestartManager.nsh
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
 && rustup target add x86_64-pc-windows-msvc
RUN curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash \
 && cargo binstall -y --locked tauri-cli cargo-xwin
