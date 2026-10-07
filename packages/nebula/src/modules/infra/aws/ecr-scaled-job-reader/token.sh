#!/bin/sh
set -eu
umask 077
work=${REGISTRY_TOKEN_WORK_DIR:-/work}
test -d "$work"
trap 'rm -f "$work/sts.tsv" "$work/aws-error"' EXIT
# Use the explicit WebIdentity exchange to avoid AWS CLI's home-directory
# credential cache in this non-root/read-only init container. The JWT is read
# from its projected file, never passed as a command-line value or printed.
if ! aws sts assume-role-with-web-identity --no-sign-request \
  --role-arn "$READER_ROLE_ARN" --role-session-name __NEBULA_ROLE_SESSION__ \
  --web-identity-token "file://$READER_TOKEN_FILE" --duration-seconds 900 \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text \
  > "$work/sts.tsv" 2> "$work/aws-error"; then
  echo '__NEBULA_ERROR_LABEL__ identity exchange failed' >&2
  exit 1
fi
read -r reader_access reader_secret reader_session reader_extra < "$work/sts.tsv"
if [ -z "$reader_access" ] || [ -z "$reader_secret" ] || [ -z "$reader_session" ] || [ -n "$reader_extra" ]; then
  echo '__NEBULA_ERROR_LABEL__ identity response rejected' >&2
  exit 1
fi
if ! AWS_ACCESS_KEY_ID="$reader_access" AWS_SECRET_ACCESS_KEY="$reader_secret" AWS_SESSION_TOKEN="$reader_session" \
  aws ecr get-authorization-token --output json > "$work/ecr.json" 2> "$work/aws-error"; then
  echo '__NEBULA_ERROR_LABEL__ registry token request failed' >&2
  exit 1
fi
