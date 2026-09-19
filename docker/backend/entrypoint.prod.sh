#!/bin/bash
# Production entrypoint for Render (free tier).
# Mirrors docker/backend/entrypoint.sh but serves traffic with Gunicorn
# instead of Django's dev server.
set -e

echo "Waiting for PostgreSQL..."
retries=0
max_retries=30
while ! python -c "
import socket, os
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.connect((os.environ['DBHOST'], int(os.environ['DBPORT'])))
s.close()
" 2>/dev/null; do
    retries=$((retries + 1))
    if [ "$retries" -ge "$max_retries" ]; then
        echo "ERROR: Could not connect to PostgreSQL after $max_retries attempts."
        exit 1
    fi
    echo "  PostgreSQL not ready yet (attempt $retries/$max_retries)..."
    sleep 2
done
echo "PostgreSQL is ready."

echo "Running migrations..."
python manage.py migrate --noinput

echo "Ensuring default admin user..."
python manage.py create_default_admin || true

echo "Collecting static files..."
python manage.py collectstatic --noinput

echo "Starting Gunicorn..."
exec gunicorn crm.wsgi:application \
    --bind "0.0.0.0:${PORT:-8000}" \
    --workers 2 \
    --threads 2 \
    --timeout 120 \
    --access-logfile - \
    --error-logfile -
