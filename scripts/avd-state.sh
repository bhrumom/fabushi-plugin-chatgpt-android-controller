#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
avd_root="${CHATGPT_ANDROID_AVD_ROOT:-}"
state_file="${CHATGPT_ANDROID_STATE_FILE:-}"
state_key="${CHATGPT_ANDROID_STATE_KEY:-}"

if [[ -z "$avd_root" || -z "$state_file" || -z "$state_key" ]]; then
  echo "CHATGPT_ANDROID_AVD_ROOT, CHATGPT_ANDROID_STATE_FILE and CHATGPT_ANDROID_STATE_KEY are required" >&2
  exit 2
fi

mkdir -p "$(dirname "$state_file")"
chmod 700 "$(dirname "$state_file")" || true

case "$mode" in
  pack)
    if [[ ! -d "$avd_root" ]]; then
      echo "AVD root does not exist: $avd_root" >&2
      exit 3
    fi
    parent="$(dirname "$avd_root")"
    name="$(basename "$avd_root")"
    tmp="${state_file}.tmp"
    rm -f "$tmp"
    # userdata-qemu.img is usually sparse. Preserve sparse extents before
    # compression so rolling encrypted state stays small enough for Actions.
    tar --sparse -C "$parent" -czf - "$name" \
      | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
          -pass env:CHATGPT_ANDROID_STATE_KEY -out "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$state_file"
    bytes=$(wc -c < "$state_file" | tr -d ' ')
    printf '{"ok":true,"mode":"pack","bytes":%s}\n' "$bytes"
    ;;
  restore)
    if [[ ! -f "$state_file" ]]; then
      echo "Encrypted AVD state does not exist: $state_file" >&2
      exit 4
    fi
    parent="$(dirname "$avd_root")"
    mkdir -p "$parent"
    rm -rf "$avd_root"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
      -pass env:CHATGPT_ANDROID_STATE_KEY -in "$state_file" \
      | tar --sparse -C "$parent" -xzf -
    if [[ ! -d "$avd_root" ]]; then
      echo "Restored archive did not contain expected AVD root" >&2
      exit 5
    fi
    printf '{"ok":true,"mode":"restore"}\n'
    ;;
  *)
    echo "usage: avd-state.sh pack|restore" >&2
    exit 2
    ;;
esac
