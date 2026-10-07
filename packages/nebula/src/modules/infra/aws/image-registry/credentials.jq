# Read from mounted files; never pass credentials as arguments or print errors.
def require($condition): if $condition then . else error("invalid registry input") end;
def expiry:
  if type == "number" and isfinite then floor
  elif type == "string" then
    sub("\\.[0-9]+(?=(Z|\\+00:00)$)"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601
  else error("invalid expiry") end;

require(($base | length) == 1 and ($response | length) == 1)
| $base[0].auths as $auths
| require(($auths | type) == "object" and ($auths | keys) == ["gcr.io"])
| require(($auths["gcr.io"].auth | type) == "string" and ($auths["gcr.io"].auth | length) > 0)
| $response[0].authorizationData as $records
| require(($records | type) == "array" and ($records | length) == 1)
| $records[0] as $record
| require($record.proxyEndpoint == ("https://" + $registry))
| ($record.expiresAt | expiry) as $expires
| require(($expires - $now) >= 7200)
| $record.authorizationToken as $token
| require(($token | type) == "string")
| ($token | @base64d) as $decoded
| require(($decoded | @base64) == $token and ($decoded | startswith("AWS:")) and ($decoded | length) > 4)
| {username: "AWS", password: $decoded[4:], auth: $token} as $ecr
| {expiresAt: $expires, credentials: {auths: ($auths + {
    __GCR_ALIASES__
    ($registry): $ecr, ($registry + __RUNTIME_REPOSITORY__): $ecr,
    ($registry + __WORKLOAD_REPOSITORY__): $ecr
  })}}
