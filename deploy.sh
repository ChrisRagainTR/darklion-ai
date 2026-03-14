#!/bin/bash
# DarkLion — Fly.io Deployment Script
# Usage: ./deploy.sh [first-time|deploy|secrets|status|logs|dns-check]

set -e

APP_NAME="darklion-ai"
DOMAIN="darklion.ai"

case "${1:-deploy}" in

  first-time)
    echo "=== First-time Fly.io setup ==="
    echo ""
    echo "1. Install flyctl: curl -L https://fly.io/install.sh | sh"
    echo "2. Sign up / log in: fly auth login"
    echo ""

    # Launch the app (creates it on Fly.io)
    fly launch --name "$APP_NAME" --region iad --no-deploy

    echo ""
    echo "=== Now set your secrets ==="
    echo "Run: ./deploy.sh secrets"
    echo ""
    echo "=== Then deploy ==="
    echo "Run: ./deploy.sh deploy"
    ;;

  secrets)
    echo "=== Setting Fly.io secrets ==="
    echo "You'll be prompted for each value."
    echo ""

    read -p "DATABASE_URL (Postgres connection string): " DB_URL
    read -p "QB_CLIENT_ID: " QB_CID
    read -p "QB_CLIENT_SECRET: " QB_CSEC
    read -p "ANTHROPIC_API_KEY: " ANTH_KEY
    read -p "DASH_USER [admin]: " DASH_U
    DASH_U=${DASH_U:-admin}
    read -sp "DASH_PASS: " DASH_P
    echo ""

    fly secrets set \
      DATABASE_URL="$DB_URL" \
      QB_CLIENT_ID="$QB_CID" \
      QB_CLIENT_SECRET="$QB_CSEC" \
      QB_REDIRECT_URI="https://$DOMAIN/callback.html" \
      ANTHROPIC_API_KEY="$ANTH_KEY" \
      DASH_USER="$DASH_U" \
      DASH_PASS="$DASH_P" \
      APP_URL="https://$DOMAIN" \
      --app "$APP_NAME"

    echo ""
    echo "Secrets set. Optional extras:"
    echo "  fly secrets set RESEND_API_KEY=re_xxx NOTIFY_EMAIL=you@email.com --app $APP_NAME"
    ;;

  deploy)
    echo "=== Deploying to Fly.io ==="
    fly deploy --app "$APP_NAME"
    echo ""
    echo "=== Deploy complete ==="
    fly status --app "$APP_NAME"
    ;;

  status)
    fly status --app "$APP_NAME"
    ;;

  logs)
    fly logs --app "$APP_NAME"
    ;;

  dns-check)
    echo "=== DNS Check for $DOMAIN ==="
    echo ""
    echo "Current A records:"
    dig +short A "$DOMAIN" 2>/dev/null || nslookup "$DOMAIN" 2>/dev/null || echo "(dig/nslookup not available)"
    echo ""
    echo "Current CNAME records:"
    dig +short CNAME "$DOMAIN" 2>/dev/null || echo "(no CNAME)"
    echo ""
    echo "Fly.io app IP:"
    fly ips list --app "$APP_NAME" 2>/dev/null || echo "(run after first deploy)"
    echo ""
    echo "=== To set up custom domain ==="
    echo "1. Run: fly certs add $DOMAIN --app $APP_NAME"
    echo "2. Run: fly certs add www.$DOMAIN --app $APP_NAME"
    echo "3. Run: fly ips list --app $APP_NAME"
    echo "4. In GoDaddy DNS, set:"
    echo "   - A record: @ -> <fly-ipv4-address>"
    echo "   - AAAA record: @ -> <fly-ipv6-address>"
    echo "   - CNAME record: www -> $DOMAIN"
    echo "5. Wait for SSL cert to provision (usually <5 min)"
    echo "6. Run: fly certs check $DOMAIN --app $APP_NAME"
    ;;

  *)
    echo "Usage: ./deploy.sh [first-time|deploy|secrets|status|logs|dns-check]"
    echo ""
    echo "Commands:"
    echo "  first-time  — Initial Fly.io app creation"
    echo "  secrets     — Set environment variables (interactive)"
    echo "  deploy      — Build and deploy to Fly.io"
    echo "  status      — Check app status"
    echo "  logs        — Stream app logs"
    echo "  dns-check   — Show DNS setup instructions for GoDaddy"
    ;;
esac
