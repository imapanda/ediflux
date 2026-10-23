#!/bin/sh
# Creates .env from .env.example with a random PostgreSQL password.
# An existing .env is never overwritten.
set -eu

cd "$(dirname "$0")/.."

if [ -e .env ]; then
  echo ".env already exists, left unchanged."
  exit 0
fi

password=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
umask 077
sed "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$password/" .env.example >.env
echo "Created .env with a random PostgreSQL password."
