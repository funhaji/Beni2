#!/bin/bash
set -e

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script as root (use sudo)"
  exit 1
fi

PUBLIC_IP=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || curl -s --max-time 8 https://ifconfig.me 2>/dev/null || echo "YOUR_IP_HERE")

COMPOSE_FILES="-f docker-compose.yml"

function compose_cmd() {
  if docker compose version &> /dev/null; then
    docker compose $COMPOSE_FILES "$@"
  else
    docker-compose $COMPOSE_FILES "$@"
  fi
}

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

function build_xray_config() {
    local input_file="$1"
    mkdir -p proxy
    echo "Building Xray client config..."
    if command -v node &> /dev/null && [ -f package.json ]; then
        V2RAY_INPUT="$(cat "$input_file")" node scripts/build-xray-config.mjs
    else
        docker run --rm -v "$(pwd):/work" -w /work -e "V2RAY_INPUT=$(cat "$input_file")" node:20-alpine \
            node scripts/build-xray-config.mjs
    fi
}

function test_socks_telegram() {
    local socks_url="$1"
    echo "Testing Telegram API via proxy..."
    if docker run --rm --network host curlimages/curl:8.5.0 -sS --max-time 20 \
        -x "$socks_url" "https://api.telegram.org" >/dev/null 2>&1; then
        echo "  ✓ Telegram reachable through proxy"
        return 0
    fi
    echo "  ✗ Proxy test failed (will still start — bot retries proxy then direct)"
    return 1
}

function test_direct_telegram() {
    echo "Testing Telegram API direct (national / domestic fallback)..."
    if curl -sS --max-time 12 "https://api.telegram.org" >/dev/null 2>&1; then
        echo "  ✓ Telegram reachable directly (usable as fallback)"
        return 0
    fi
    echo "  ✗ Direct Telegram not reachable from this server"
    return 1
}

function prompt_proxy_config() {
    echo ""
    echo "-----------------------------------------------"
    echo "Proxy (Telegram + external APIs only)"
    echo "-----------------------------------------------"
    echo "Panel URLs (Marzban, etc.) always use a direct connection."
    echo ""

    local current_enabled=""
    local current_mode=""
    if [ -f .env ]; then
        # shellcheck disable=SC1091
        source .env 2>/dev/null || true
        current_enabled="${PROXY_ENABLED:-}"
        current_mode="${PROXY_MODE:-}"
    fi

    read -p "Use a proxy for Telegram and blocked APIs? [y/N] (current: ${current_enabled:-no}): " use_proxy
    use_proxy=${use_proxy:-n}

    PROXY_ENABLED=false
    PROXY_MODE=none
    PROXY_SOCKS_URL=
    PROXY_HTTP_URL=
    TELEGRAM_API_FALLBACKS=
    unset V2RAY_INPUT_FILE

    if [[ ! "$use_proxy" =~ ^[Yy]$ ]]; then
        echo "Proxy disabled."
        return
    fi

    echo ""
    echo "Choose proxy type:"
    echo "  1) SOCKS5 (host:port, optional username/password)"
    echo "  2) V2Ray / Xray (paste share link, subscription URL, or JSON config)"
    read -p "Select [1/2] (current: ${current_mode:-}): " proxy_type

    if [ "$proxy_type" == "2" ]; then
        PROXY_MODE=v2ray
        PROXY_ENABLED=true
        echo ""
        echo "Paste ONE of the following, then press Enter twice:"
        echo "  - vless:// / vmess:// / trojan:// / ss:// link"
        echo "  - Subscription URL (https://...)"
        echo "  - Full Xray client JSON (single line or paste multi-line, end with empty line)"
        mkdir -p proxy
        local input_file="proxy/user-input.txt"
        : > "$input_file"
        echo "Paste now (empty line to finish):"
        while IFS= read -r line; do
            [ -z "$line" ] && break
            echo "$line" >> "$input_file"
        done

        if [ ! -s "$input_file" ]; then
            echo "No input provided — proxy disabled."
            PROXY_ENABLED=false
            PROXY_MODE=none
            return
        fi

        build_xray_config "$input_file"
        PROXY_SOCKS_URL="socks5://xray:10808"
        COMPOSE_FILES="-f docker-compose.yml -f docker-compose.proxy.yml"
        echo "Xray sidecar will provide SOCKS5 at socks5://xray:10808 inside Docker."
    else
        PROXY_MODE=socks5
        PROXY_ENABLED=true
        read -p "SOCKS5 host (IP or domain): " socks_host
        read -p "SOCKS5 port [1080]: " socks_port
        socks_port=${socks_port:-1080}
        read -p "SOCKS5 username (optional): " socks_user
        read -sp "SOCKS5 password (optional): " socks_pass
        echo ""

        if [ -z "$socks_host" ]; then
            echo "Host required — proxy disabled."
            PROXY_ENABLED=false
            PROXY_MODE=none
            return
        fi

        if [ -n "$socks_user" ]; then
            local enc_user enc_pass
            enc_user=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$socks_user'''))" 2>/dev/null || echo "$socks_user")
            enc_pass=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$socks_pass'''))" 2>/dev/null || echo "$socks_pass")
            PROXY_SOCKS_URL="socks5://${enc_user}:${enc_pass}@${socks_host}:${socks_port}"
        else
            PROXY_SOCKS_URL="socks5://${socks_host}:${socks_port}"
        fi
        echo "SOCKS5 URL saved (panels still connect directly)."
    fi

    echo ""
    echo "Optional: custom Telegram Bot API base (for local Bot API or domestic mirror)."
    echo "Leave empty to use https://api.telegram.org with automatic fallbacks."
    read -p "TELEGRAM_API_BASE (optional): " tg_api_base
    if [ -n "$tg_api_base" ]; then
        TELEGRAM_API_BASE="${tg_api_base%/}"
    fi

    read -p "Extra Telegram API fallbacks (comma-separated URLs, optional): " tg_fallbacks
    TELEGRAM_API_FALLBACKS="$tg_fallbacks"

    if [ "$PROXY_MODE" = "socks5" ] && [ -n "$PROXY_SOCKS_URL" ]; then
        test_socks_telegram "$PROXY_SOCKS_URL" || true
    fi
    test_direct_telegram || true
}

function write_env_file() {
    local bot_token="$1"
    local base_url="$2"
    local admin_ids="$3"

    cat <<EOF > .env
TELEGRAM_BOT_TOKEN=$bot_token
PUBLIC_BASE_URL=$base_url
ADMIN_IDS=$admin_ids
PROXY_ENABLED=${PROXY_ENABLED:-false}
PROXY_MODE=${PROXY_MODE:-none}
PROXY_SOCKS_URL=${PROXY_SOCKS_URL:-}
PROXY_HTTP_URL=${PROXY_HTTP_URL:-}
TELEGRAM_API_BASE=${TELEGRAM_API_BASE:-}
TELEGRAM_API_FALLBACKS=${TELEGRAM_API_FALLBACKS:-}
EOF
    echo "Saved configuration to .env"
}

function prompt_config() {
    echo "-----------------------------------------------"
    echo "Configuration"
    echo "-----------------------------------------------"
    
    local current_token=""
    local current_admins=""
    local current_base=""
    
    if [ -f .env ]; then
        # shellcheck disable=SC1091
        source .env
        current_token=$TELEGRAM_BOT_TOKEN
        current_admins=$ADMIN_IDS
        current_base=$PUBLIC_BASE_URL
        PROXY_ENABLED=${PROXY_ENABLED:-false}
        PROXY_MODE=${PROXY_MODE:-none}
        PROXY_SOCKS_URL=${PROXY_SOCKS_URL:-}
        TELEGRAM_API_BASE=${TELEGRAM_API_BASE:-}
        TELEGRAM_API_FALLBACKS=${TELEGRAM_API_FALLBACKS:-}
        if [ "${PROXY_MODE}" = "v2ray" ] && [ -f proxy/xray-config.json ]; then
            COMPOSE_FILES="-f docker-compose.yml -f docker-compose.proxy.yml"
        fi
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

    prompt_proxy_config
    write_env_file "$bot_token" "$base_url" "$admin_ids"
    generate_nginx
}

function generate_nginx() {
    echo "Generating Nginx Configuration..."
    if [ -f certs/cert.pem ]; then
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
    if [ -f .env ]; then
        # shellcheck disable=SC1091
        source .env
        if [ "${PROXY_MODE}" = "v2ray" ] && [ -f proxy/xray-config.json ]; then
            COMPOSE_FILES="-f docker-compose.yml -f docker-compose.proxy.yml"
        fi
    fi
    echo "Building and starting the bot..."
    compose_cmd up -d --build
    echo "==============================================="
    echo "  Success! The bot is now running."
    if [ "${PROXY_ENABLED}" = "true" ]; then
        echo "  Proxy: ON (${PROXY_MODE}) — Telegram & external APIs only"
        echo "  Panels: direct connection (no proxy)"
    fi
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
        compose_cmd down -v 2>/dev/null || true
        if docker compose version &> /dev/null; then
            docker compose -f docker-compose.yml -f docker-compose.proxy.yml down -v 2>/dev/null || true
        fi
        rm -rf .env certs nginx.conf proxy
        echo "Bot has been successfully uninstalled."
        exit 0
    else
        echo "Uninstall cancelled."
    fi
}

# ---------------------------------------------------------
# MAIN ENTRY POINT
# ---------------------------------------------------------

if [ ! -f .env ]; then
    install_bot
    exit 0
fi

while true; do
    echo ""
    echo "==============================================="
    echo "  Telegram Seller Bot - Management Menu"
    echo "==============================================="
    echo "1) Update Bot (git pull & rebuild)"
    echo "2) Change Configuration (Admins, Token, Domain, Proxy)"
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
            compose_cmd restart
            echo "Bot restarted!"
            ;;
        4)
            compose_cmd logs -f bot
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
