# Fixed ECR endpoint and enough life for the existing three-hour job deadline.
# No credential data is printed on failure by the invoking container.
def require($condition): if $condition then . else error("invalid ECR response") end;
def expiry:
  if type == "number" and isfinite then floor
  elif type == "string" then
    sub("\\.[0-9]+(?=(Z|\\+00:00)$)"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601
  else error("invalid expiry") end;
.authorizationData as $records
| require(($records | type) == "array" and ($records | length) == 1)
| $records[0] as $record
| require($record.proxyEndpoint == ("https://" + $registry))
| ($record.expiresAt | expiry) as $expires
| require(($expires - $now) >= 14400)
| $record.authorizationToken as $token
| require(($token | type) == "string")
| ($token | @base64d) as $decoded
| require(($decoded | @base64) == $token and ($decoded | startswith("AWS:")) and ($decoded | length) > 4)
| {auths: {($registry): {auth: $token}}}
