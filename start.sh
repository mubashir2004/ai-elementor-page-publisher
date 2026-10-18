#!/bin/sh
set -eu

# Railway mounts persistent volumes at runtime, replacing the image's
# pre-owned /data directory. Fix ownership after the mount is present,
# then drop privileges before starting the application.
mkdir -p /data
chown -R pwuser:pwuser /data
exec su -s /bin/sh pwuser -c 'exec node /app/backend/server.js'
