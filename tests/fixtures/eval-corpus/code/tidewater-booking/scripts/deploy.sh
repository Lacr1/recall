#!/usr/bin/env bash
# Deploys tidewater-booking with a blue/green switch.
# Usage: scripts/deploy.sh staging|production
set -euo pipefail

ENVIRONMENT="$1"
TAG="$(git rev-parse --short HEAD)"
IMAGE="registry.tidewaterlabs.se/booking:$TAG"

if [[ "$ENVIRONMENT" == "production" && "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "Production deploys only from main" >&2
  exit 1
fi

docker build -t "$IMAGE" .
docker push "$IMAGE"

# Run database migrations before switching traffic. Migrations must be backwards compatible.
ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" "docker run --rm --env-file /etc/booking.env $IMAGE npm run migrate"

# Start the idle colour, wait for the health check, then switch the load balancer.
IDLE="$(ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" cat /etc/booking/idle-colour)"
ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" "booking-start $IDLE $IMAGE"
for i in $(seq 1 30); do
  if curl -fsS "https://$IDLE.$ENVIRONMENT.tidewaterlabs.se/health" > /dev/null; then
    ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" "booking-switch $IDLE"
    echo "Deployed $TAG to $ENVIRONMENT ($IDLE)"
    exit 0
  fi
  sleep 2
done

echo "Health check failed; traffic stays on the old colour. Rolling back." >&2
ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" "booking-stop $IDLE"
exit 1
