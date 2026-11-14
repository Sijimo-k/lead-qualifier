#!/bin/sh
# Re-imports both workflows after `npm run build` without touching credentials.
# Run with: docker compose exec n8n sh /demo/reload-workflows.sh && docker compose restart n8n
set -e
n8n import:workflow --input=/workflows/lead-qualifier.json
n8n import:workflow --input=/workflows/followup-drafts.json
n8n publish:workflow --id=leadqualify00001
n8n publish:workflow --id=leadfollowup0001
