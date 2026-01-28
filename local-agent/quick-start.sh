#!/bin/bash

# FUGUE Cockpit Local Agent - Quick Start Script

set -e

echo "🚀 FUGUE Cockpit Local Agent - Quick Start"
echo "=========================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js がインストールされていません"
    echo "   https://nodejs.org/ からインストールしてください"
    exit 1
fi

echo "✅ Node.js $(node --version) が見つかりました"
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm がインストールされていません"
    exit 1
fi

echo "✅ npm $(npm --version) が見つかりました"
echo ""

# Install dependencies
if [ ! -d "node_modules" ]; then
    echo "📦 依存関係をインストール中..."
    npm install
    echo "✅ 依存関係のインストール完了"
    echo ""
else
    echo "✅ 依存関係は既にインストール済みです"
    echo ""
fi

# Check if config.json exists
if [ ! -f "config.json" ]; then
    echo "⚠️  config.json が見つかりません"
    echo "📝 config.example.json から作成します..."
    cp config.example.json config.json
    echo "✅ config.json を作成しました"
    echo ""
    echo "🔧 次のステップ:"
    echo "   1. config.json を編集してください"
    echo "   2. 以下の項目を設定してください:"
    echo "      - repositories: 監視対象のリポジトリパス"
    echo "      - workersHubUrl: Workers Hub の URL"
    echo "      - authentication.apiKey: API キー"
    echo ""
    echo "設定例:"
    echo "  cat config.json"
    echo ""
    cat config.json
    echo ""
    echo "設定完了後、再度このスクリプトを実行してください:"
    echo "  ./quick-start.sh"
    exit 0
fi

echo "✅ config.json が見つかりました"
echo ""

# Type check
echo "🔍 TypeScript 型チェック中..."
npm run type-check
echo "✅ 型チェック完了"
echo ""

# Build
echo "🔨 ビルド中..."
npm run build
echo "✅ ビルド完了"
echo ""

echo "🎉 セットアップ完了！"
echo ""
echo "次のコマンドでエージェントを起動できます:"
echo ""
echo "  # 開発モード（ホットリロード）"
echo "  npm run dev"
echo ""
echo "  # 本番モード"
echo "  npm start"
echo ""
echo "停止するには Ctrl+C を押してください"
echo ""

# Ask to start
read -p "今すぐ開発モードで起動しますか？ (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🚀 Local Agent を起動中..."
    npm run dev
fi
