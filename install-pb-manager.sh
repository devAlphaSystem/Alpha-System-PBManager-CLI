#!/bin/bash

set -e

PB_MANAGER_GITHUB_USER="devAlphaSystem"
PB_MANAGER_GITHUB_REPO="Alpha-System-PBManager"
PB_MANAGER_BRANCH="main"

PB_MANAGER_SCRIPT_URL="https://raw.githubusercontent.com/${PB_MANAGER_GITHUB_USER}/${PB_MANAGER_GITHUB_REPO}/${PB_MANAGER_BRANCH}/pb-manager.js"
PB_MANAGER_INSTALL_DIR="/opt/pb-manager"
PB_MANAGER_SYMLINK_PATH="/usr/local/bin/pb-manager"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PACMAN_SYU_DONE=0

info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}
warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}
error() {
  echo -e "${RED}[ERROR]${NC} $1"
  exit 1
}
success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_wsl() {
  grep -qi microsoft /proc/version 2>/dev/null
}

is_wsl2() {
  if is_wsl && [ -d /run/WSL ]; then
    return 0
  fi
  return 1
}

prompt_enable_systemd_wsl2() {
  echo -e "${YELLOW}You are running under WSL2 and systemd does not appear to be enabled.${NC}"
  echo -e "${YELLOW}For services like Nginx and PM2 to start automatically on boot within WSL2, systemd is recommended.${NC}"
  echo -e "${YELLOW}To enable systemd in WSL2, you typically add the following to /etc/wsl.conf:${NC}"
  echo -e "${YELLOW}\n[boot]\nsystemd=true\n${NC}"
  echo -e "${YELLOW}After creating or modifying /etc/wsl.conf, you must fully shut down your WSL instance from PowerShell/CMD (e.g., 'wsl --shutdown') and then restart it.${NC}"
  local enable_systemd
  read -p "Do you want this script to attempt to add 'systemd=true' to /etc/wsl.conf for you? [y/N]: " enable_systemd
  if [[ "$enable_systemd" =~ ^[Yy]$ ]]; then
    local wsl_conf_file="/etc/wsl.conf"
    local wsl_conf_updated=0

    if [ ! -f "$wsl_conf_file" ] || ! grep -q "^\s*\[boot\]" "$wsl_conf_file" 2>/dev/null; then
      if [ -s "$wsl_conf_file" ] && [ "$(tail -c1 "$wsl_conf_file"; echo x)" != $'\nx' ]; then
        echo | tee -a "$wsl_conf_file" > /dev/null
      fi
      echo -e "\n[boot]" | tee -a "$wsl_conf_file" > /dev/null
      wsl_conf_updated=1
    fi

    if ! grep -q "^\s*systemd\s*=\s*true" "$wsl_conf_file" 2>/dev/null; then
      echo "systemd=true" | tee -a "$wsl_conf_file" > /dev/null
      wsl_conf_updated=1
    fi

    if [ "$wsl_conf_updated" -eq 1 ]; then
      success "systemd configuration has been updated in /etc/wsl.conf."
      warn "IMPORTANT: Now exit WSL, run \"wsl --shutdown\" in your Windows terminal, then restart your WSL2 instance and run this script again."
      exit 0
    else
      info "systemd already appears to be configured in /etc/wsl.conf."
    fi
  else
    warn "Skipping automatic systemd configuration for WSL2. Services might not start on boot correctly."
  fi
}

check_distro() {
  if command_exists apt-get; then
    PKG_MANAGER="apt"
    UPDATE_CMD="apt-get update -y"
    INSTALL_CMD="apt-get install -y"
    info "Detected Debian-based system (apt)."
  elif command_exists dnf; then
    PKG_MANAGER="dnf"
    UPDATE_CMD="dnf makecache --timer"
    INSTALL_CMD="dnf install -y"
    info "Detected Fedora/RHEL/Oracle-based system (dnf)."
  elif command_exists pacman; then
    PKG_MANAGER="pacman"
    UPDATE_CMD="pacman -Sy --noconfirm"
    INSTALL_CMD="pacman -S --noconfirm"
    info "Detected Arch-based system (pacman)."
  else
    error "This installation script currently only supports Debian (apt), Fedora/RHEL/Oracle (dnf), or Arch (pacman) based Linux distributions. Please install dependencies manually if you are on a different system."
  fi
}

if [ "$(id -u)" -ne 0 ]; then
  error "This script must be run as root or with sudo."
fi

check_distro

if is_wsl2; then
  if ! pgrep -x systemd >/dev/null 2>&1 && ! systemctl is-system-running --quiet --wait 2>/dev/null; then
    prompt_enable_systemd_wsl2
  else
    info "WSL2 detected and systemd appears to be running."
  fi
fi

info "Updating package lists and system (this may take a moment for Arch)..."
if [ "$PKG_MANAGER" = "pacman" ]; then
  pacman -Syu --noconfirm > /dev/null 2>&1 || error "Failed to update system."
  PACMAN_SYU_DONE=1
else
  ${UPDATE_CMD} > /dev/null 2>&1 || error "Failed to update package lists."
fi

ESSENTIAL_TOOLS="curl git openssl"
info "Ensuring essential tools (${ESSENTIAL_TOOLS}) are installed..."
${INSTALL_CMD} ${ESSENTIAL_TOOLS} > /dev/null 2>&1 || error "Failed to install essential tools."

if command_exists node && command_exists npm; then
  NODE_VERSION_RAW=$(node -v)
  NPM_VERSION_RAW=$(npm -v)
  info "Node.js and npm are already installed."
  if [[ "$(echo "$NODE_VERSION_RAW" | cut -d. -f1 | sed 's/v//')" -lt 20 ]]; then
    warn "Installed Node.js version is $NODE_VERSION_RAW, which is older than v20.x. pb-manager recommends v20.x or newer. Consider upgrading Node.js."
  else
    info "Node version: $NODE_VERSION_RAW, npm version: $NPM_VERSION_RAW"
  fi
else
  info "Node.js (v20.x) and npm are not found."
  read -p "Do you want to install Node.js v20.x and npm now? [Y/n]: " install_node
  if [[ "$install_node" =~ ^[Nn]$ ]]; then
    error "Node.js and npm are required. Installation aborted."
  fi
  info "Installing Node.js (v20.x) and npm..."
  if [ "$PKG_MANAGER" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    apt-get install -y nodejs > /dev/null 2>&1 || error "Failed to install Node.js."
  elif [ "$PKG_MANAGER" = "dnf" ]; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    dnf install -y nodejs > /dev/null 2>&1 || error "Failed to install Node.js."
  elif [ "$PKG_MANAGER" = "pacman" ]; then
    pacman -S --noconfirm nodejs npm > /dev/null 2>&1 || error "Failed to install Node.js and npm."
    NODE_VERSION_RAW_PACMAN=$(node -v 2>/dev/null || echo "v0.0.0")
    if [[ "$(echo "$NODE_VERSION_RAW_PACMAN" | cut -d. -f1 | sed 's/v//')" -lt 20 ]]; then
      warn "Installed Node.js version on Arch is $NODE_VERSION_RAW_PACMAN, which is older than recommended v20.x. pb-manager might have issues. Consider using a Node version manager (like nvm) to install Node v20+."
    fi
  fi
  success "Node.js and npm installed successfully."
  info "Node version: $(node -v), npm version: $(npm -v)"
fi

if command_exists pm2; then
  info "PM2 is already installed."
else
  info "PM2 is not found."
  read -p "Do you want to install PM2 globally via npm now? [Y/n]: " install_pm2
  if [[ "$install_pm2" =~ ^[Nn]$ ]]; then
    error "PM2 is required. Installation aborted."
  fi
  info "Installing PM2 globally..."
  npm install -g pm2 > /dev/null 2>&1 || error "Failed to install PM2."
  success "PM2 installed successfully."
fi

info "Configuring PM2 to start on system boot..."
if command_exists pm2; then
  PM2_HP="/root"
  PM2_STARTUP_CMD_OUTPUT=""
  info "Attempting to configure PM2 startup for user root with home path ${PM2_HP}..."
  if PM2_STARTUP_CMD_OUTPUT=$(pm2 startup systemd -u root --hp "${PM2_HP}" 2>&1); then
    info "PM2 startup command executed."
  else
    EXIT_CODE=$?
    warn "PM2 startup command failed or produced warnings (exit code ${EXIT_CODE}). Output was:"
    echo -e "${YELLOW}${PM2_STARTUP_CMD_OUTPUT}${NC}"
  fi

  if echo "$PM2_STARTUP_CMD_OUTPUT" | grep -q "command"; then
    warn "PM2 startup configuration might require you to run a command manually."
    echo -e "${YELLOW}PM2 output (if any relevant command is shown, please execute it):${NC}\n$PM2_STARTUP_CMD_OUTPUT"
    read -p "Press [Enter] to continue after reviewing/running the command, or [S] to skip PM2 save..." continue_key
    if [[ "$continue_key" =~ ^[Ss]$ ]]; then
      warn "Skipping pm2 save."
    else
      pm2 save --force > /dev/null 2>&1 || warn "Failed to save PM2 process list. This might be okay if no processes are running yet."
    fi
  else
    info "PM2 startup command processed. Saving current PM2 process list (if any)..."
    pm2 save --force > /dev/null 2>&1 || warn "Failed to save PM2 process list."
  fi
  success "PM2 startup configured (or attempted)."
else
  warn "PM2 not found, skipping PM2 startup configuration."
fi

if command_exists nginx; then
  info "Nginx is already installed."
else
  info "Nginx is not found."
  read -p "Do you want to install Nginx now? [Y/n]: " install_nginx
  if [[ "$install_nginx" =~ ^[Nn]$ ]]; then
    error "Nginx is required. Installation aborted."
  fi
  info "Installing Nginx..."
  ${INSTALL_CMD} nginx > /dev/null 2>&1 || error "Failed to install Nginx."
  success "Nginx installed successfully."
fi

info "Ensuring Nginx is started and enabled on boot..."
if command_exists systemctl; then
  systemctl start nginx > /dev/null 2>&1 || warn "Failed to start Nginx. It might already be running or there might be a configuration issue."
  systemctl enable nginx > /dev/null 2>&1 || warn "Failed to enable Nginx on boot."
else
  warn "systemctl not found. Attempting to manage Nginx directly. This might not ensure it starts on boot."
  if nginx -t > /dev/null 2>&1; then
    nginx -s reload > /dev/null 2>&1 || nginx > /dev/null 2>&1 || warn "Tried to reload/start Nginx directly, but it might have failed."
  else
    warn "Nginx configuration test failed. Nginx not started/reloaded."
  fi
fi
success "Nginx service configured."

if command_exists certbot; then
  info "Certbot is already installed."
else
  info "Certbot is not found."
  read -p "Do you want to install Certbot and its Nginx plugin now? [Y/n]: " install_certbot
  if [[ "$install_certbot" =~ ^[Nn]$ ]]; then
    warn "Certbot not installed. HTTPS setup via pb-manager will not be available."
  else
    info "Installing Certbot and its Nginx plugin..."
    if [ "$PKG_MANAGER" = "apt" ]; then
      ${INSTALL_CMD} certbot python3-certbot-nginx > /dev/null 2>&1 || ${INSTALL_CMD} certbot certbot-nginx > /dev/null 2>&1 || error "Failed to install Certbot or its Nginx plugin."
    elif [ "$PKG_MANAGER" = "dnf" ]; then
      ${INSTALL_CMD} epel-release > /dev/null 2>&1 || true
      ${INSTALL_CMD} certbot python3-certbot-nginx > /dev/null 2>&1 || ${INSTALL_CMD} certbot certbot-nginx > /dev/null 2>&1 || error "Failed to install Certbot or its Nginx plugin."
    elif [ "$PKG_MANAGER" = "pacman" ]; then
      if [ "$PACMAN_SYU_DONE" -eq 0 ]; then
        pacman -Syu --noconfirm > /dev/null 2>&1 || warn "Full system update before certbot failed or was skipped."
      fi
      pacman -Sy --noconfirm > /dev/null 2>&1 || warn "Failed to refresh package lists before certbot install."
      pacman -S --noconfirm certbot certbot-nginx > /dev/null 2>&1 || error "Failed to install Certbot or its Nginx plugin."
    fi
    success "Certbot and Nginx plugin installed successfully."
  fi
fi

info "Setting up pb-manager CLI script (pb-manager.js)..."
if [ -f "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" ]; then
  warn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js already exists."
  read -p "Do you want to overwrite it with the latest version from the repository? [Y/n]: " overwrite_script
  if [[ "$overwrite_script" =~ ^[Nn]$ ]]; then
    info "Skipping download of pb-manager.js. Using existing version."
  else
    info "Downloading pb-manager.js from ${PB_MANAGER_SCRIPT_URL}..."
    curl -fsSL "${PB_MANAGER_SCRIPT_URL}" -o "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to download pb-manager.js."
    chmod +x "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to make pb-manager.js executable."
    success "pb-manager.js downloaded/updated and made executable."
  fi
else
  mkdir -p "${PB_MANAGER_INSTALL_DIR}" || error "Failed to create directory ${PB_MANAGER_INSTALL_DIR}."
  info "Downloading pb-manager.js from ${PB_MANAGER_SCRIPT_URL}..."
  curl -fsSL "${PB_MANAGER_SCRIPT_URL}" -o "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to download pb-manager.js."
  chmod +x "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to make pb-manager.js executable."
  success "pb-manager.js downloaded and made executable."
fi

info "Installing Node.js dependencies for pb-manager CLI in ${PB_MANAGER_INSTALL_DIR}..."
ORIGINAL_DIR=$(pwd)
cd "${PB_MANAGER_INSTALL_DIR}" || error "Failed to change directory to ${PB_MANAGER_INSTALL_DIR}."

PB_MANAGER_DEPS="commander inquirer@8.2.4 fs-extra axios chalk@4.1.2 unzipper shelljs blessed blessed-contrib cli-table3 pretty-bytes@5.6.0"
info "Required CLI dependencies: ${PB_MANAGER_DEPS}"
read -p "Do you want to install/update these CLI dependencies now? [Y/n]: " install_deps
if [[ "$install_deps" =~ ^[Nn]$ ]]; then
  warn "Skipping CLI dependency installation. pb-manager CLI might not work correctly."
else
  if [ ! -f "package.json" ]; then
    info "No package.json found for CLI, creating one..."
    npm init -y > /dev/null 2>&1 || warn "npm init -y failed, proceeding with CLI dependency installation."
  fi
  npm install --save ${PB_MANAGER_DEPS} > /dev/null 2>&1 || error "Failed to install pb-manager CLI dependencies."
  success "pb-manager CLI dependencies installed/updated."
fi
cd "${ORIGINAL_DIR}"

info "Creating symlink for pb-manager CLI at ${PB_MANAGER_SYMLINK_PATH}..."
ln -sfn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" "${PB_MANAGER_SYMLINK_PATH}" || error "Failed to create symlink for pb-manager."
success "Symlink created. You can now use 'pb-manager' command (you might need to open a new terminal session)."

if command_exists ufw; then
  info "Configuring firewall (UFW) to allow Nginx traffic (HTTP/HTTPS)..."
  ufw allow 'Nginx Full' > /dev/null 2>&1 || warn "Failed to set UFW rule for 'Nginx Full'. You may need to configure your firewall manually."
  success "Firewall rules for Nginx (HTTP/HTTPS) applied/checked."
  info "Current UFW status:"
  ufw status verbose
elif command_exists firewall-cmd; then
  info "Configuring firewall (firewalld) to allow Nginx traffic (HTTP/HTTPS)..."
  firewall-cmd --permanent --add-service=http > /dev/null 2>&1 || warn "Failed to add HTTP service to firewalld."
  firewall-cmd --permanent --add-service=https > /dev/null 2>&1 || warn "Failed to add HTTPS service to firewalld."
  firewall-cmd --reload > /dev/null 2>&1 || warn "Failed to reload firewalld."
  success "Firewall rules for Nginx (HTTP/HTTPS) applied/checked."
  info "Current firewalld active services:"
  firewall-cmd --list-services
else
  warn "No UFW or firewalld found. Please configure your firewall manually to allow HTTP (80) and HTTPS (443) traffic if needed."
fi

read -p "Do you want to run pb-manager CLI setup now to download PocketBase binaries? [Y/n]: " run_cli_setup
if [[ "$run_cli_setup" =~ ^[Nn]$ ]]; then
  info "You can run CLI setup later with: pb-manager setup"
else
  info "Running pb-manager CLI setup to download PocketBase binaries..."
  "${PB_MANAGER_SYMLINK_PATH}" setup
  if [ $? -eq 0 ]; then
    success "CLI Setup completed successfully."
  else
    error "CLI Setup encountered errors. Please try running it manually later with: pb-manager setup"
  fi
fi

success "-------------------------------------------------------"
if [[ "$run_cli_setup" =~ ^[Yy]$ ]]; then
  success "pb-manager CLI installation and setup complete!"
else
  success "pb-manager CLI installation complete!"
fi
success "-------------------------------------------------------"

info "For all commands and options, run: sudo pb-manager help"

exit 0
