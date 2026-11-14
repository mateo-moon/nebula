import { hash, type AttestedChannel } from "./transport";
import { jwt, type OwnerState } from "./owner";

/** A transport measurement alone does not prove this invitation/owner belongs
 * to that instance. Check the commitment or an existing owner signature before
 * any new preparation pin is made durable. */
export async function validatePreparationClaim(channel: Pick<AttestedChannel, "request">, owner: OwnerState,
  bootstrap: { claimed?: boolean; claimSha256?: string }) {
  if (bootstrap.claimed === true) {
    const response = await channel.request("/nebula/v1/job", { headers: { Authorization: `Bearer ${await jwt(owner, "nebula-browser")}` } });
    await response.body?.cancel();
    if (response.status !== 200) throw new Error("This preparation instance belongs to another owner; existing enrollment was preserved");
    return;
  }
  if (bootstrap.claimed !== false || !/^[a-f0-9]{64}$/.test(owner.token ?? "") || !/^[a-f0-9]{64}$/.test(bootstrap.claimSha256 ?? "")) throw new Error("A valid unused invitation is required before enrolling this preparation instance");
  const token = Uint8Array.from(owner.token!.match(/../g)!, h => parseInt(h, 16));
  try { if (await hash(token) !== bootstrap.claimSha256) throw new Error("The invitation does not match the attested VM; no new instance pin was saved"); }
  finally { token.fill(0); }
}
