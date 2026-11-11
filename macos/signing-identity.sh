#!/bin/sh
# Creates the stable code-signing identity "Entre Nous" in the login keychain (self-signed,
# local, run once per Mac). With an ad-hoc signature the Keychain knows the app by the hash
# of its binary: every build looks like a new app and asks again for the session password,
# once per stored key. Signed with the same certificate, new builds keep the
# "Toujours autoriser" given once.
# A copy is kept in ~/.config/entrenous/ (never committed) to sign on another Mac.
# Removal: security delete-identity -c "Entre Nous"
set -eu
NAME="Entre Nous"
DIR="$HOME/.config/entrenous"
P12="$DIR/mac-signing.p12"
PASS_FILE="$DIR/mac-signing.pass"

if security find-certificate -c "$NAME" >/dev/null 2>&1; then
  echo "Identité « $NAME » déjà présente"
  exit 0
fi

umask 077
mkdir -p "$DIR"
if [ ! -f "$P12" ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  openssl req -x509 -newkey rsa:3072 -nodes -days 7300 -subj "/CN=$NAME" \
    -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" \
    -addext "basicConstraints=critical,CA:false" 2>/dev/null
  openssl rand -hex 24 > "$PASS_FILE"
  # the macOS importer only reads the legacy PKCS#12 algorithms
  openssl pkcs12 -export -legacy -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
    -passout file:"$PASS_FILE" -out "$P12"
fi
# -T: codesign may use the key without asking
security import "$P12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P "$(cat "$PASS_FILE")" -T /usr/bin/codesign >/dev/null
echo "Identité « $NAME » ajoutée au trousseau de session"
