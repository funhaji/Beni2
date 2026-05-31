#!/bin/bash
set -e

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (use sudo)"
  exit 1
fi

PUBLIC_IP=$(curl -s https://api.ipify.org || echo "YOUR_IP_HERE")

function check_dependencies() {
    if ! command -v openssl &> /dev/null; then
        echo "Installing OpenSSL..."
        apt-get update && apt-get install -y openssl
    fi

    if ! command -v docker &> /dev/null; then
        echo "Installing Docker..."
        curl -fsSL https://get.docker.com -o get-docker.sh
        sh get-docker.sh
        rm get-docker.sh
    fi

    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        echo "Installing Docker Compose..."
        apt-get update && apt-get install -y docker-compose-plugin
    fi
}

function prompt_config() {
    echo "-----------------------------------------------"
    echo "Configuration"
    echo "-----------------------------------------------"
    
    local current_token=""
    local current_admins=""
    local current_base=""
    
    if [ -f .env ]; then
        source .env
        current_token=$TELEGRAM_BOT_TOKEN
        current_admins=$ADMIN_IDS
        current_base=$PUBLIC_BASE_URL
    fi

    echo "Press Enter to keep the current value shown in brackets []."
    
    read -p "Enter your Telegram Bot Token [$current_token]: " bot_token
    bot_token=${bot_token:-$current_token}

    read -p "Enter Admin Telegram IDs (comma-separated) [$current_admins]: " admin_ids
    admin_ids=${admin_ids:-$current_admins}
    
    echo ""
    echo "Telegram Webhooks require HTTPS. Do you have a domain, or do you want to use your IP address ($PUBLIC_IP)?"
    echo "1) I have a Domain Name"
    echo "2) I want to use my IP address ($PUBLIC_IP) with an Auto-Generated Self-Signed Certificate"
    read -p "Select option [1/2]: " domain_option

    mkdir -p certs

    if [ "$domain_option" == "2" ]; then
        base_url="https://$PUBLIC_IP"
        echo "Generating Self-Signed SSL Certificate for $PUBLIC_IP..."
        openssl req -newkey rsa:2048 -sha256 -nodes -keyout certs/private.key -x509 -days 3650 -out certs/cert.pem -subj "/C=US/ST=State/L=City/O=Company/CN=$PUBLIC_IP"
        echo "Certificate generated in ./certs/"
    else
        read -p "Enter your Domain Name [$current_base] (e.g. https://bot.yourdomain.com): " base_url
        base_url=${base_url:-$current_base}
        base_url=${base_url%/}
    fi

    cat <<EOF > .env
TELEGRAM_BOT_TOKEN=$bot_token
PUBLIC_BASE_URL=$base_url
ADMIN_IDS=$admin_ids
EOF
    echo "Saved configuration to .env"

    generate_nginx
}

function generate_nginx() {
    echo "Generating Nginx Configuration..."
    if [ -f certs/cert.pem ]; then
        # SSL Nginx Config for Self-Signed IP
        cat <<EOF > nginx.conf
server {
    listen 80;
    listen [::]:80;
    server_name _;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name _;

    ssl_certificate /etc/nginx/certs/cert.pem;
    ssl_certificate_key /etc/nginx/certs/private.key;

    location / {
        proxy_pass http://bot:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
    else
        # Basic HTTP Nginx Config
        cat <<EOF > nginx.conf
server {
    listen 80;
    listen [::]:80;
    server_name _;

    location / {
        proxy_pass http://bot:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
    fi
}

function start_bot() {
    echo ""
    echo "Building and starting the bot..."
    if docker compose version &> /dev/null; then
        docker compose up -d --build
    else
        docker-compose up -d --build
    fi
    echo "==============================================="
    echo "  Success! The bot is now running."
    echo "==============================================="
}

function install_bot() {
    echo "==============================================="
    echo "  Telegram Seller Bot - First Time Setup"
    echo "==============================================="
    check_dependencies
    prompt_config
    start_bot
}

function update_bot() {
    echo "==============================================="
    echo "  Updating Bot from GitHub..."
    echo "==============================================="
    git pull || echo "Warning: git pull failed. Make sure you are in a git repository."
    start_bot
}

function uninstall_bot() {
    echo "==============================================="
    echo "  WARNING: Uninstalling the Bot"
    echo "==============================================="
    echo "This will delete all bot data, including the database and settings!"
    read -p "Are you absolutely sure you want to uninstall? (y/N): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        if docker compose version &> /dev/null; then
            docker compose down -v
        else
            docker-compose down -v
        fi
        rm -rf .env certs nginx.conf
        echo "Bot has been successfully uninstalled."
        exit 0
    else
        echo "Uninstall cancelled."
    fi
}

# ---------------------------------------------------------
# MAIN ENTRY POINT
# ---------------------------------------------------------

# If .env doesn't exist, it's a fresh installation
if [ ! -f .env ]; then
    install_bot
    exit 0
fi

# If .env exists, show the management menu
while true; do
    echo ""
    echo "==============================================="
    echo "  Telegram Seller Bot - Management Menu"
    echo "==============================================="
    echo "1) Update Bot (git pull & rebuild)"
    echo "2) Change Configuration (Admins, Token, Domain)"
    echo "3) Restart Bot"
    echo "4) View Live Logs"
    echo "5) Uninstall Bot"
    echo "0) Exit Menu"
    echo "==============================================="
    read -p "Select an option [0-5]: " choice
    
    case $choice in
        1)
            update_bot
            ;;
        2)
            prompt_config
            start_bot
            ;;
        3)
            echo "Restarting bot..."
            if docker compose version &> /dev/null; then
                docker compose restart
            else
                docker-compose restart
            fi
            echo "Bot restarted!"
            ;;
        4)
            if docker compose version &> /dev/null; then
                docker compose logs -f bot
            else
                docker-compose logs -f bot
            fi
            ;;
        5)
            uninstall_bot
            ;;
        0)
            echo "Exiting..."
            exit 0
            ;;
        *)
            echo "Invalid option. Please try again."
            ;;
    esac
done
