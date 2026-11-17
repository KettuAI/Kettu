# The Kettu daemon in a container, built from the package of a published release:
#
#   docker build --build-arg VERSION=0.1.6 -f tools/daemon/Dockerfile tools/daemon
#
# The release's checksums are checked before the package is unpacked. RELEASES_URL names another
# place to download from, laid out as GitHub's releases. The image is built once a release is
# published, by .github/workflows/docker.yml.

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS package
ARG VERSION
ARG TARGETARCH
ARG RELEASES_URL=https://github.com/KettuAI/Kettu/releases
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /download
RUN set -eu; \
  test -n "$VERSION" || { echo 'Set --build-arg VERSION=<release>, such as 0.1.6' >&2; exit 1; }; \
  case "${TARGETARCH:-}" in \
    amd64) arch=x64 ;; \
    arm64) arch=arm64 ;; \
    *) echo "The daemon has no package for '${TARGETARCH:-}'; build with BuildKit" >&2; exit 1 ;; \
  esac; \
  file="kettu-daemon-linux-$arch.tar.gz"; \
  from="$RELEASES_URL/download/v$VERSION"; \
  curl -fsSL --retry 3 -o "$file" "$from/$file"; \
  curl -fsSL --retry 3 -o sums "$from/kettu-daemon-sha256sums.txt"; \
  expected="$(awk -v name="$file" '$2 == name || $2 == "*" name { print $1; exit }' sums)"; \
  test -n "$expected" || { echo "The checksums list no $file" >&2; exit 1; }; \
  echo "$expected  $file" | sha256sum -c -; \
  mkdir /opt/kettu; \
  tar -xzf "$file" -C /opt/kettu --strip-components=1

# The base brings the Node.js and npm that the agents' installs run on, and glibc, which the
# daemon needs; git and ps are what its Git features and process control run.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client procps ripgrep tini \
  && rm -rf /var/lib/apt/lists/*
# Outside a versions folder, so kettu update leaves it alone: a newer image replaces this one.
COPY --from=package /opt/kettu /opt/kettu
RUN ln -s /opt/kettu/bin/kettu /usr/local/bin/kettu \
  && mkdir /workspace \
  && chown node:node /workspace

# Fixed so the container can publish it; the daemon picks a random one otherwise.
ENV KETTU_DIRECT_PORT=4567
USER node
WORKDIR /workspace
# The host's identity, settings, sessions and the agents' sign-ins; losing it unpairs every device.
VOLUME /home/node
EXPOSE 4567
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD kettu status > /dev/null
ENTRYPOINT ["tini", "--", "kettu"]
CMD ["run"]
