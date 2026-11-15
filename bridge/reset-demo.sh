#!/bin/zsh
# A fresh demo day: wipes the log and fills in a day that ends with a feed almost due.
# Run it a few minutes before presenting:   bridge/reset-demo.sh
cd "$(dirname "$0")/.."
KEY=$(grep '^BABY_KEY=' .env | cut -d= -f2)
API=$(grep '^BABY_API=' .env | cut -d= -f2)
curl -s -X POST "$API/api/reset" -H "x-key: $KEY" -H 'content-type: application/json' -d '{"seed":true}' && echo
