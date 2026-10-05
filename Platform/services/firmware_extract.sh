#!/usr/bin/env bash
set -e

DEST="/home/hacker/Desktop"
mkdir -p "$DEST"

echo "==> Starting extraction of chipset firmware and kernel modules to $DEST..."

# Helper to find and copy matching files from standard system paths and Nix store
extract_files() {
    local search_pattern="$1"
    local target_dir="$2"
    mkdir -p "$target_dir"
    
    echo "Searching for $search_pattern..."
    find /run/current-system/firmware \
         /run/booted-system/kernel-modules \
         /lib/firmware \
         /nix/store \
         -maxdepth 6 -name "$search_pattern" 2>/dev/null | while read -r filepath; do
        if [ -f "$filepath" ]; then
            echo "  -> Copying: $filepath"
            cp -L "$filepath" "$target_dir/" 2>/dev/null || true
        fi
    done
}

# 1. Panda Wireless PAU0B -> MediaTek MT7610UN
DIR1="$DEST/Panda_Wireless_PAU0B_MT7610UN"
extract_files "mt7610u*.bin" "$DIR1"

# 2. Alfa Networks AWUS036ACH -> Realtek RTL8812AU
DIR2="$DEST/Alfa_Networks_AWUS036ACH_RTL8812AU"
extract_files "*8812au*.ko" "$DIR2"
extract_files "*8812au*.bin" "$DIR2"

# 3. Alfa Networks AWUS036ACM -> MediaTek MT7612UN
DIR3="$DEST/Alfa_Networks_AWUS036ACM_MT7612UN"
extract_files "mt7662*.bin" "$DIR3"
extract_files "mt7612*.bin" "$DIR3"

# 4. Alfa Networks AWUS036ACS -> Realtek RTL8811AU
DIR4="$DEST/Alfa_Networks_AWUS036ACS_RTL8811AU"
extract_files "*8821au*.ko" "$DIR4"
extract_files "*8811au*.ko" "$DIR4"

# Set ownership to user 'hacker'
chown -R hacker:users "$DIR1" "$DIR2" "$DIR3" "$DIR4" 2>/dev/null || true

echo "==> Extraction complete! All files saved to $DEST."
