#!/bin/bash
set -e

echo "==============================================="
echo "  Telegram Seller Bot - VPS Auto Setup"
echo "==============================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (use sudo)"
  exit 1
fi

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "Installing Docker Compose..."
    if [ -f /etc/debian_version ]; then
        apt-get update && apt-get install -y docker-compose-plugin
    elif [ -f /etc/redhat-release ]; then
        yum install -y docker-compose-plugin
    else
        curl -L "https://github.com/docker/compose/releases/download/v2.24.5/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        chmod +x /usr/local/bin/docker-compose
    fi
fi

echo "-----------------------------------------------"
echo "Configuration"
echo "-----------------------------------------------"

# Read environment variables
if [ ! -f .env ]; then
    read -p "Enter your Telegram Bot Token: " bot_token
    read -p "Enter your Public Base URL (e.g. https://bot.yourdomain.com): " base_url
    read -p "Enter Admin Telegram IDs (comma-separated): " admin_ids

    cat <<EOF > .env
TELEGRAM_BOT_TOKEN=$bot_token
PUBLIC_BASE_URL=$base_url
ADMIN_IDS=$admin_ids
EOF
    echo "Saved configuration to .env"
else
    echo ".env file already exists, skipping configuration."
fi

echo ""
echo "Building and starting the bot..."

# Use modern docker compose if available
if docker compose version &> /dev/null; then
    docker compose up -d --build
else
    docker-compose up -d --build
fi

echo ""
echo "==============================================="
echo "  Setup Complete! The bot is now running."
echo "  Make sure to set up a reverse proxy (like Nginx or Caddy)"
echo "  to route traffic from your domain to localhost:3000"
echo "  To view logs, run: docker compose logs -f bot"
echo "==============================================="
