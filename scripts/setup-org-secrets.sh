#!/bin/bash
# Setup GitHub Organization Secrets (one-time setup for all repos)
set -e

ORG="cursorvers"

echo "🔐 Setting up GitHub Organization Secrets..."
echo "These will be available to ALL repositories in the organization."
echo ""

# Workers API
echo "Setting Workers API secrets..."
echo "https://orchestrator-hub.masa-stage1.workers.dev" | gh secret set WORKERS_API_URL --org "$ORG" --visibility all
echo "✓ WORKERS_API_URL set"

echo "4d5VeeIym9a77QMhtstg8ssQlaox40Dn" | gh secret set WORKERS_API_KEY --org "$ORG" --visibility all
echo "✓ WORKERS_API_KEY set"

# Stripe credentials
echo ""
echo "📋 Please enter your Stripe credentials:"
read -p "Stripe Email: " STRIPE_EMAIL
read -sp "Stripe Password: " STRIPE_PASSWORD
echo ""

echo "$STRIPE_EMAIL" | gh secret set STRIPE_EMAIL --org "$ORG" --visibility all
echo "✓ STRIPE_EMAIL set"

echo "$STRIPE_PASSWORD" | gh secret set STRIPE_PASSWORD --org "$ORG" --visibility all
echo "✓ STRIPE_PASSWORD set"

# Cloudflare credentials
echo ""
echo "📋 Please enter your Cloudflare credentials:"
read -p "Cloudflare Email: " CLOUDFLARE_EMAIL
read -sp "Cloudflare Password: " CLOUDFLARE_PASSWORD
echo ""

echo "$CLOUDFLARE_EMAIL" | gh secret set CLOUDFLARE_EMAIL --org "$ORG" --visibility all
echo "✓ CLOUDFLARE_EMAIL set"

echo "$CLOUDFLARE_PASSWORD" | gh secret set CLOUDFLARE_PASSWORD --org "$ORG" --visibility all
echo "✓ CLOUDFLARE_PASSWORD set"

# AWS credentials
echo ""
echo "📋 Please enter your AWS credentials:"
read -p "AWS Email: " AWS_EMAIL
read -sp "AWS Password: " AWS_PASSWORD
echo ""

echo "$AWS_EMAIL" | gh secret set AWS_EMAIL --org "$ORG" --visibility all
echo "✓ AWS_EMAIL set"

echo "$AWS_PASSWORD" | gh secret set AWS_PASSWORD --org "$ORG" --visibility all
echo "✓ AWS_PASSWORD set"

echo ""
echo "✅ All Organization Secrets configured successfully!"
echo "These secrets are now available to ALL repositories in the '$ORG' organization."
echo ""
echo "Verify with: gh secret list --org $ORG"
