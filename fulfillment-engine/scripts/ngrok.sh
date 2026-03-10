#!/bin/bash

# Start ngrok to expose local server
# This creates a public HTTPS URL that Shopify can send webhooks to

PORT=3000

echo "🚀 Starting ngrok on port $PORT..."
echo ""
echo "Once started, copy the HTTPS URL (e.g. https://abc123.ngrok.io)"
echo "Then register webhook in Shopify Dev Dashboard:"
echo "  Webhook URL: https://YOUR-NGROK-URL/webhook/orders/paid"
echo "  Topic: orders/paid"
echo ""

ngrok http $PORT
