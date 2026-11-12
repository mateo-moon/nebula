/** Parse existing bcrypt hashes without verifying or rehashing passwords. */
export function bcryptUsers(text: string): Record<string, string> {
  const users: Record<string, string> = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([^:\s\x00-\x1f]+):(\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53})(?::[^\r\n]*)?$/.exec(line);
    if (!match || Object.hasOwn(users, match[1])) throw new Error("Invalid or duplicate bcrypt account in authentication configuration");
    users[match[1]] = match[2];
  }
  if (!Object.keys(users).length) throw new Error("Authentication requires a nonempty bcrypt user map");
  return users;
}
