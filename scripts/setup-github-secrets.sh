#!/bin/bash
# Setup GitHub Repository Secrets for web-receipt-scraper workflow
set -e

REPO="cursorvers/cloudflare-workers-hub"

echo "🔐 Setting up GitHub Repository Secrets..."
echo ""

# Workers API
echo "WORKERS_API_URL" | gh secret set WORKERS_API_URL --repo "$REPO" --body "https://orchestrator-hub.masa-stage1.workers.dev"
echo "✓ WORKERS_API_URL set"

echo "WORKERS_API_KEY" | gh secret set WORKERS_API_KEY --repo "$REPO" --body "4d5VeeIym9a77QMhtstg8ssQlaox40Dn"
echo "✓ WORKERS_API_KEY set"

# Stripe credentials
echo ""
echo "📋 Please enter your Stripe credentials:"
read -p "Stripe Email: " STRIPE_EMAIL
read -sp "Stripe Password: " STRIPE_PASSWORD
echo ""

echo "$STRIPE_EMAIL" | gh secret set STRIPE_EMAIL --repo "$REPO"
echo "✓ STRIPE_EMAIL set"

echo "$STRIPE_PASSWORD" | gh secret set STRIPE_PASSWORD --repo "$REPO"
echo "✓ STRIPE_PASSWORD set"

# Cloudflare credentials
echo ""
echo "📋 Please enter your Cloudflare credentials:"
read -p "Cloudflare Email: " CLOUDFLARE_EMAIL
read -sp "Cloudflare Password: " CLOUDFLARE_PASSWORD
echo ""

echo "$CLOUDFLARE_EMAIL" | gh secret set CLOUDFLARE_EMAIL --repo "$REPO"
echo "✓ CLOUDFLARE_EMAIL set"

echo "$CLOUDFLARE_PASSWORD" | gh secret set CLOUDFLARE_PASSWORD --repo "$REPO"
echo "✓ CLOUDFLARE_PASSWORD set"

# AWS credentials
echo ""
echo "📋 Please enter your AWS credentials:"
read -p "AWS Email: " AWS_EMAIL
read -sp "AWS Password: " AWS_PASSWORD
echo ""

echo "$AWS_EMAIL" | gh secret set AWS_EMAIL --repo "$REPO"
echo "✓ AWS_EMAIL set"

echo "$AWS_PASSWORD" | gh secret set AWS_PASSWORD --repo "$REPO"
echo "✓ AWS_PASSWORD set"

echo ""
echo "✅ All secrets configured successfully!"
echo ""
echo "Verify with: gh secret list --repo $REPO"
