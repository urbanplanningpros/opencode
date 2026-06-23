set -euo pipefail

PATCH_NAME="upp-crm-gis-source-resolver-hotpatch.zip"
PATCH_URL="${PATCH_URL:-https://github.com/urbanplanningpros/opencode/releases/download/upp-crm-gis-source-resolver-latest/upp-crm-gis-source-resolver-hotpatch.zip}"
FALLBACK_PATCH_URL="${FALLBACK_PATCH_URL:-https://files.catbox.moe/rqdank.zip}"
PATCH="/home/rocky/$PATCH_NAME"
STAGE="/var/www/upp-crm-gis-source-resolver-hotpatch"
LIVE="/var/www/urbanplanningpros"
EXPECTED_SHA256="D5C1210D4A6173F5947D5AD73A92BF5C23FCC5A86F3CF903DF65D14378A1A6A9"

echo "Downloading UPP CRM GIS resolver hotpatch..."
if ! curl -L --fail --retry 8 --retry-delay 2 --retry-all-errors -o "$PATCH" "$PATCH_URL"; then
  echo "Primary GitHub release download failed. Trying verified fallback URL..."
  curl -L --fail --retry 8 --retry-delay 2 --retry-all-errors -o "$PATCH" "$FALLBACK_PATCH_URL"
fi

echo "Checking downloaded patch..."
ls -lah "$PATCH"
ACTUAL_SHA256="$(sha256sum "$PATCH" | awk '{print toupper($1)}')"
echo "Expected: $EXPECTED_SHA256"
echo "Actual:   $ACTUAL_SHA256"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "HASH_MISMATCH_DO_NOT_DEPLOY"
  exit 1
fi

echo "Extracting patch..."
rm -rf "$STAGE"
mkdir -p "$STAGE"
python3 -m zipfile -e "$PATCH" "$STAGE"

test -f "$STAGE/crm/preview-server.mjs"
test -f "$STAGE/crm/gis-source-coverage.json"
test -f "$STAGE/crm/dist/public/index.html"

echo "Backing up current CRM files..."
TS="$(date +%Y%m%d-%H%M%S)"
cp "$LIVE/crm/preview-server.mjs" "$LIVE/crm/preview-server.mjs.bak-$TS"
cp -a "$LIVE/crm/dist/public" "$LIVE/crm/dist/public.bak-$TS"
if [ -f "$LIVE/crm/gis-source-coverage.json" ]; then
  cp "$LIVE/crm/gis-source-coverage.json" "$LIVE/crm/gis-source-coverage.json.bak-$TS"
fi

echo "Applying patch..."
cp "$STAGE/crm/preview-server.mjs" "$LIVE/crm/preview-server.mjs"
cp "$STAGE/crm/gis-source-coverage.json" "$LIVE/crm/gis-source-coverage.json"
rm -rf "$LIVE/crm/dist/public"
cp -a "$STAGE/crm/dist/public" "$LIVE/crm/dist/public"

echo "Restarting CRM..."
systemctl restart urbanplanningpros-crm
sleep 3
systemctl status urbanplanningpros-crm --no-pager -l || true

echo "Verifying live project page..."
curl -I https://urbanplanningpros.com/projects/891271

echo "Regenerating Wall Triana Stage 1 report..."
curl -s -X POST "http://127.0.0.1:3010/api/trpc/project.generateFeasibilityReport?input=%7B%22json%22%3A%7B%22projectId%22%3A891271%7D%7D" \
  -H "Content-Type: application/json"
echo

echo "Checking report for GIS resolver..."
curl -s http://127.0.0.1:3010/generated-reports/project-891271-stage-1-report.html \
  | grep -E "Address-Driven GIS Source Resolver|Madison County|Parcels_North_Alabama" \
  | head || true

echo "UPP_GIS_RESOLVER_DEPLOY_COMPLETE"
