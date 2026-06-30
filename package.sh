#!/bin/bash

# Exit on error
set -e

ARCHIVE_NAME="yasmin-ai-deploy.zip"

echo "📦 Creating deployment archive..."

# Remove old archive if it exists
if [ -f "$ARCHIVE_NAME" ]; then
  rm "$ARCHIVE_NAME"
fi

# Check if zip is installed
if ! command -v zip &> /dev/null; then
  echo "❌ Error: 'zip' utility is not installed. Please install it or modify this script to use tar."
  exit 1
fi

# Create zip archive with required deployment files
zip -r "$ARCHIVE_NAME" \
  app.ts \
  package.json \
  package-lock.json \
  tsconfig.json \
  src \
  scripts \
  database \
  -x "**/node_modules/*" \
  -x "**/node_modules" \
  -x "dist/*" \
  -x "dist" \
  -x ".git/*" \
  -x ".git" \
  -x ".github/*" \
  -x ".github" \
  -x "src/__tests__/*" \
  -x "src/__tests__" \
  -x "$ARCHIVE_NAME"

echo "==============================================================="
echo "✅ Success! Deployment archive created: $ARCHIVE_NAME"
echo "👉 Upload this zip file to your NAS inside '/volume1/web_other/yasmin-ai/' and unzip it."
echo "==============================================================="
