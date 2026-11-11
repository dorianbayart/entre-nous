# Build environment for the Android app: JDK 21 + Android SDK, nothing installed on the Mac.
# Google ships the build tools (aapt2…) for x86_64 Linux only: run as linux/amd64.
FROM eclipse-temurin:21-jdk

ENV ANDROID_HOME=/opt/android-sdk
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl \
 && rm -rf /var/lib/apt/lists/*

# The download URL carries a build number; sdkmanager then installs the latest tools.
ARG CMDLINE_TOOLS=15859902
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" -o /tmp/tools.zip \
 && unzip -q /tmp/tools.zip -d /tmp/tools \
 && mv /tmp/tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
 && rm -rf /tmp/tools /tmp/tools.zip
ENV PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"

RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" > /dev/null

WORKDIR /project
