# /etc/nixos/configuration.nix

{ config, pkgs, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ./win-vm.nix
    <home-manager/nixos>
  ];

  # Bootloader
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  # ACPI Workaround to bypass corrupt EC math and force clean hardware polling
  boot.kernelParams = [ "acpi_osi=Linux" "acpi_enforce_resources=lax" ];
  # Upgrade kernel to latest mainline for improved battery driver / hardware map communication
  boot.kernelPackages = pkgs.linuxPackages_latest;

  # Networking
  networking.hostName = "nixos";
  networking.networkmanager.enable = true;

  # Time zone
  time.timeZone = "America/New_York";

  # Hardware / Bluetooth Support
  hardware.bluetooth.enable = true;

  # Internationalisation
  i18n.defaultLocale = "en_US.UTF-8";
  i18n.extraLocaleSettings = {
    LC_ADDRESS = "en_US.UTF-8";
    LC_IDENTIFICATION = "en_US.UTF-8";
    LC_MEASUREMENT = "en_US.UTF-8";
    LC_MONETARY = "en_US.UTF-8";
    LC_NAME = "en_US.UTF-8";
    LC_NUMERIC = "en_US.UTF-8";
    LC_PAPER = "en_US.UTF-8";
    LC_TELEPHONE = "en_US.UTF-8";
    LC_TIME = "en_US.UTF-8";
  };

  # X11 + KDE Plasma 6
  services.upower.enable = true;
  services.xserver.enable = true;
  services.displayManager.sddm.enable = true;
  services.desktopManager.plasma6.enable = true;
  services.xserver.xkb = {
    layout = "us";
    variant = "";
  };

  # Sound
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
  };

  # Touchpad
  services.libinput.enable = true;

  # Blank / generic user (no personal credentials)
  users.users.user = {
    isNormalUser = true;
    description = "User";
    extraGroups = [ "networkmanager" "wheel" "docker" "dialout" "uucp" "wireshark" ];
    shell = pkgs.zsh;
  };

  # System-wide default shell
  users.defaultUserShell = pkgs.zsh;

  # Enable the background Docker daemon service
  virtualisation.docker.enable = true;

  # Wireshark System Configuration
  programs.wireshark = {
    enable = true;
    package = pkgs.wireshark;   # GUI version
  };

  # Enable nix-ld globally to dynamically link compiled C++ components
  programs.nix-ld = {
    enable = true;
    libraries = with pkgs; [
      stdenv.cc.cc.lib
      zlib
    ];
  };

  # Allow unfree
  nixpkgs.config.allowUnfree = true;

  # System packages – cyber-focused
  environment.systemPackages = with pkgs; [
    # Core runtime
    python3
    python3Packages.pip
    python3Packages.scapy
    python3Packages.pwntools
    python3Packages.impacket
    python3Packages.pyserial
    python3Packages.psutil

    # Network / recon / scanning
    arp-scan
    nmap
    masscan
    wget
    tcpdump
    tshark
    wireshark
    netcat-openbsd
    socat
    bettercap
    mitmproxy
    aircrack-ng
    gobuster
    thc-hydra

    # Forensics / reverse engineering
    binwalk
    foremost
    ghidra-bin
    radare2
    gdb
    yara
    volatility3
    exiftool
    strace
    ltrace
    checksec

    # Password cracking
    hashcat
    john

    # Containers / compatibility
    docker
    wine

    # Hardware / power / USB debugging
    acpi
    upower
    pciutils
    usbutils

    # Compression / utilities
    p7zip
    zsh

    # Fixed FHS Environment for BLE / serial work
    (pkgs.buildFHSEnv {
      name = "ble-sniffer-env";
      targetPkgs = pkgs: with pkgs; [
        wireshark
        tshark
        python3
        python3Packages.pyserial
        python3Packages.psutil
        pciutils
        usbutils
      ];
      runScript = "bash";
    })
  ];

  environment.shells = with pkgs; [ zsh ];

  # Minimal zsh
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestions.enable = true;
    syntaxHighlighting.enable = true;
    histSize = 10000;
    shellAliases = { };
    setOptions = [ "AUTO_CD" ];
  };

  programs.firefox.enable = true;
  programs.mtr.enable = true;
  programs.gnupg.agent = {
    enable = true;
    enableSSHSupport = true;
  };

  # SSH
  services.openssh.enable = true;

  # Home Manager – minimal
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "backup";

    users.user = { pkgs, ... }: {
      home.stateVersion = "25.11";
    };
  };

  system.stateVersion = "25.11";
}
