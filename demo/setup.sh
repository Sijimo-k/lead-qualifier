#!/bin/sh
# Imports the demo credentials and both workflows, then publishes them.
# Run with: docker compose exec n8n sh /demo/setup.sh
set -e
n8n import:credentials --input=/demo/credentials.json
n8n import:workflow --input=/workflows/lead-qualifier.json
n8n import:workflow --input=/workflows/followup-drafts.json
n8n publish:workflow --id=leadqualify00001
n8n publish:workflow --id=leadfollowup0001
echo "Done. Restart n8n so the published webhooks are registered: docker compose restart n8n"
