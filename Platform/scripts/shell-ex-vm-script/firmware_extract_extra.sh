#!/usr/bin/env bash
set -e

DEST="/home/hacker/Desktop"
mkdir -p "$DEST"

# Allow nix-build to evaluate packages marked as broken
export NIXPKGS_ALLOW_BROKEN=1

echo "==> Fetching firmware and compiling Realtek modules via Nix..."

# 1. Panda Wireless PAU0B -> MediaTek MT7610UN
echo "[1/4] Extracting MT7610UN firmware..."
DIR1="$DEST/Panda_Wireless_PAU0B_MT7610UN"
mkdir -p "$DIR1"
FW_PATH=$(nix-build '<nixpkgs>' -A linux-firmware --no-out-link)
cp -f "$FW_PATH/lib/firmware/mediatek/mt7610u.bin" "$DIR1/" 2>/dev/null || \
cp -f "$FW_PATH/lib/firmware/mt7610u.bin" "$DIR1/" 2>/dev/null || true

# 2. Alfa Networks AWUS036ACH -> Realtek RTL8812AU
echo "[2/4] Building and extracting RTL8812AU kernel module..."
DIR2="$DEST/Alfa_Networks_AWUS036ACH_RTL8812AU"
mkdir -p "$DIR2"
RTL8812_PATH=$(nix-build '<nixpkgs>' -A linuxPackages_6_6.rtl8812au --no-out-link 2>/dev/null || \
               nix-build '<nixpkgs>' -A linuxPackages.rtl8812au --no-out-link)
find "$RTL8812_PATH" -name "*.ko" -exec cp {} "$DIR2/" \;

# 3. Alfa Networks AWUS036ACM -> MediaTek MT7612UN
echo "[3/4] Extracting MT7612UN firmware..."
DIR3="$DEST/Alfa_Networks_AWUS036ACM_MT7612UN"
mkdir -p "$DIR3"
cp -f "$FW_PATH/lib/firmware/mediatek/mt7662u.bin" "$DIR3/" 2>/dev/null || true
cp -f "$FW_PATH/lib/firmware/mediatek/mt7662u_rom_patch.bin" "$DIR3/" 2>/dev/null || true
cp -f "$FW_PATH/lib/firmware/mediatek/mt7662.bin" "$DIR3/" 2>/dev/null || true
cp -f "$FW_PATH/lib/firmware/mediatek/mt7662_rom_patch.bin" "$DIR3/" 2>/dev/null || true

# 4. Alfa Networks AWUS036ACS -> Realtek RTL8811AU / RTL8821AU
echo "[4/4] Building and extracting RTL8811AU kernel module..."
DIR4="$DEST/Alfa_Networks_AWUS036ACS_RTL8811AU"
mkdir -p "$DIR4"
RTL8821_PATH=$(nix-build '<nixpkgs>' -A linuxPackages_6_6.rtl8821au --no-out-link 2>/dev/null || \
               nix-build '<nixpkgs>' -A linuxPackages.rtl8821au --no-out-link 2>/dev/null || \
               nix-build '<nixpkgs>' -A linuxPackages_6_6.rtl8812au --no-out-link)
find "$RTL8821_PATH" -name "*.ko" -exec cp {} "$DIR4/" \;

# Fix permissions for user 'hacker'
chown -R hacker:users "$DIR1" "$DIR2" "$DIR3" "$DIR4" 2>/dev/null || true

echo "==> Done! All files extracted to $DEST"
