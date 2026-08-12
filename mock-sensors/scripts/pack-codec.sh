#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Intelligent Farming Foundation
#
# TEMPORARY SCAFFOLDING — delete this script and mock-sensors/vendor/ once
# @intelligent-farming/lorawan-codec-normalization 0.2.0 is published to npm and
# mock-sensors/package.json depends on "^0.2.0" instead of the file: tarball.
# The final PR must not land with this file in it; it exists so a *draft* PR can
# demonstrate this repo and the (still unpublished) codec branch working together.
#
# What it does: builds the codec package from a sibling checkout and drops the
# resulting npm tarball into mock-sensors/vendor/, which is what package.json's
# `file:vendor/...tgz` dependency resolves against. Nothing inside the image build
# can produce that file — the compose service builds with context ./mock-sensors,
# so the Dockerfile cannot reach a sibling repo. The pack therefore has to happen
# on the host, before `docker compose build` and before `npm install`.
#
# Layout it assumes (a shared workspace directory, one repo per subdirectory):
#
#   intelligent-farming/
#   ├── intelligent-farming-stack/mock-sensors/   <- here
#   └── lorawan-codec-normalization/              <- CODEC_REPO_DIR
#
# Override the sibling path with CODEC_REPO_DIR=/path/to/lorawan-codec-normalization.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$MOCK_DIR/vendor"
CODEC_REPO="${CODEC_REPO_DIR:-$MOCK_DIR/../../lorawan-codec-normalization}"

die() {
  echo "[pack-codec] ERROR: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || die "node is not on PATH (Node 20+ required)"
command -v npm >/dev/null 2>&1 || die "npm is not on PATH (npm 7+ required for --pack-destination)"

# What mock-sensors/package.json actually asks for. Once someone flips this to a
# published range this script has no work left to do, so it says so and succeeds —
# that keeps `npm run mock:up` / scripts/e2e.sh working through the cleanup commit
# instead of failing on a script that is only half-removed.
dep_spec="$(node -e 'process.stdout.write((require(process.argv[1]).dependencies || {})["@intelligent-farming/lorawan-codec-normalization"] || "")' "$MOCK_DIR/package.json")"
[ -n "$dep_spec" ] ||
  die "mock-sensors/package.json has no @intelligent-farming/lorawan-codec-normalization dependency"

case "$dep_spec" in
  file:*) ;;
  *)
    echo "[pack-codec] dependency is \"$dep_spec\" (published range) — nothing to pack."
    echo "[pack-codec] mock-sensors/vendor/ and this script can be deleted."
    exit 0
    ;;
esac

expected_tarball="$MOCK_DIR/${dep_spec#file:}"
expected_name="$(basename "$expected_tarball")"

[ -d "$CODEC_REPO" ] || die "no codec checkout at $CODEC_REPO
  The codec version carrying channels[] is not on npm yet, so this repo builds it
  from a sibling checkout. Clone it next to the stack repo, on the branch carrying
  the version mock-sensors/package.json expects (vendor/$expected_name):
    git clone https://github.com/intelligent-farming/lorawan-codec-normalization.git
  or point at an existing clone:
    CODEC_REPO_DIR=/path/to/lorawan-codec-normalization npm run pack-codec"

CODEC_REPO="$(cd "$CODEC_REPO" && pwd)"
[ -f "$CODEC_REPO/package.json" ] || die "$CODEC_REPO is not an npm package (no package.json)"

pkg_name="$(node -e 'process.stdout.write(require(process.argv[1]).name || "")' "$CODEC_REPO/package.json")"
pkg_version="$(node -e 'process.stdout.write(require(process.argv[1]).version || "")' "$CODEC_REPO/package.json")"
[ "$pkg_name" = "@intelligent-farming/lorawan-codec-normalization" ] ||
  die "$CODEC_REPO is \"$pkg_name\", not @intelligent-farming/lorawan-codec-normalization"

# npm pack flattens the scope: @foo/bar@1.2.3 -> foo-bar-1.2.3.tgz.
flat_name="${pkg_name#@}"
packed_name="${flat_name/\//-}-$pkg_version.tgz"
[ "$packed_name" = "$expected_name" ] ||
  die "version mismatch: the checkout at $CODEC_REPO is $pkg_version, which packs as
  $packed_name, but mock-sensors/package.json depends on $expected_name.
  Check out the codec branch carrying that version, or update the dependency."

# Never leave a stale tarball behind: a half-built or previous-version tarball that
# still matches the expected filename would install cleanly and decode wrongly,
# which is far more expensive to debug than a hard failure here.
mkdir -p "$VENDOR_DIR"
rm -f "$VENDOR_DIR"/*.tgz

# The codec's build is `tsc` + a generator script, so it needs its own devDeps.
# Only installed when absent — `ci` when a lockfile is there, so this never
# rewrites the sibling repo's package-lock.json under someone's feet.
if [ ! -d "$CODEC_REPO/node_modules" ]; then
  echo "[pack-codec] installing codec build deps in $CODEC_REPO …"
  if [ -f "$CODEC_REPO/package-lock.json" ]; then
    (cd "$CODEC_REPO" && npm ci --no-audit --no-fund) ||
      die "npm ci failed in $CODEC_REPO"
  else
    (cd "$CODEC_REPO" && npm install --no-audit --no-fund) ||
      die "npm install failed in $CODEC_REPO"
  fi
fi

# Heads-up on the cross-repo side effect: the codec's `build` also regenerates the
# `provides` block inside its tracked codecs/*/device.json files, so a stale
# checkout can come back with modifications. That is the codec repo's own generated
# content — review it there, not here; this repo never commits any of it.
echo "[pack-codec] building $pkg_name $pkg_version from $CODEC_REPO …"
(cd "$CODEC_REPO" && npm run build) ||
  die "\`npm run build\` failed in $CODEC_REPO — fix the codec checkout first (the
  harness's payload vectors come from that package, so there is no fallback)"

echo "[pack-codec] packing into $VENDOR_DIR …"
(cd "$CODEC_REPO" && npm pack --pack-destination "$VENDOR_DIR" >/dev/null) ||
  die "\`npm pack\` failed in $CODEC_REPO (--pack-destination needs npm 7+)"

[ -f "$expected_tarball" ] ||
  die "npm pack did not produce $expected_tarball"

# Invalidate the previous *install* of this tarball, not just the tarball itself.
#
# The codec version stays 0.2.0 across every repack while it is unpublished, so a
# rebuilt tarball lands at the same path under the same name with different
# contents. npm does not notice: with a complete node_modules tree it never
# re-verifies a `file:` dependency, so the `npm install` that follows a repack
# no-ops and leaves the OLD codec extracted. That is silent and expensive here —
# the harness takes both its payload bytes and its expected decoded objects from
# this package, so a stale install means the e2e suite asserts yesterday's codec
# against yesterday's vectors and passes while proving nothing about the build
# just packed. (scripts/e2e.sh does exactly pack-then-`npm install`.)
#
# So: drop the extracted copy, and drop the lockfile's `integrity`/`resolved` pin
# for it — that pin is a hash of the tarball we just replaced, and leaving it
# behind turns the forced re-extract into an EINTEGRITY failure instead. npm
# re-pins both on the next install.
rm -rf "$MOCK_DIR/node_modules/@intelligent-farming/lorawan-codec-normalization"
if [ -f "$MOCK_DIR/package-lock.json" ]; then
  node - "$MOCK_DIR/package-lock.json" <<'EOF' || die "could not unpin the codec tarball in package-lock.json"
const fs = require('fs');
const path = process.argv[2];
const lock = JSON.parse(fs.readFileSync(path, 'utf8'));
const key = 'node_modules/@intelligent-farming/lorawan-codec-normalization';
const entry = (lock.packages || {})[key];
if (entry && (entry.integrity || entry.resolved)) {
  delete entry.integrity;
  delete entry.resolved;
  fs.writeFileSync(path, JSON.stringify(lock, null, 2) + '\n');
}
EOF
fi

echo "[pack-codec] ok: vendor/$expected_name (previous install invalidated)"
