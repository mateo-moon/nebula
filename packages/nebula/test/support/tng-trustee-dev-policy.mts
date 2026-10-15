/** Development SNP qualification only. Pinned generator 4fa1cabd...; exact
 * reviewed generator rules/settings and an owner-supplied network profile.
 * Feed generated.yaml from the exact tngTrusteePlan workload. This hardener
 * checks generated image/argv/env/mount shape and closes host mutation RPCs;
 * it is not a general policy generator or a production security audit.
 */
import {readFileSync as read, writeFileSync as write} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {TngTrustee,tngTrusteeInitData,TRUSTEE_STARTUP_METADATA_POLICY,tngTrusteePlan} from '../../src/modules/k8s/trustee';
import {decodeGuestPolicy} from '../../src/modules/k8s/confidential-guests/guest-policy';
import {checkGeneratedGuestSettings} from '../../src/modules/k8s/confidential-guests/harden-policy';
const require=createRequire(import.meta.url);
const yaml=require('yaml'), {App,Chart}=require('cdk8s');
const [directory]=process.argv.slice(2);
if (!directory) throw Error('Usage: node --import tsx test/support/tng-trustee-dev-policy.mts PREPARED_DIRECTORY');
const dir=resolve(directory);
const config=JSON.parse(read(`${dir}/config.json`,'utf8'));
const ns=config.namespace;
const network=JSON.parse(read(`${dir}/network.json`,'utf8'));
for(const key of ['ipv4AddressPattern','ipv6AddressPattern']) {
 assert.equal(typeof network[key],'string');
 assert.ok(network[key].startsWith('^') && network[key].endsWith('$') && network[key].length<256);
 new RegExp(network[key]);
}
function harden(name:string, pod:any) {
 const generated=yaml.parse(read(`${dir}/generated.yaml`,'utf8'));
 const encoded=(generated.kind==='Deployment'?generated.spec.template.metadata:generated.metadata).annotations['io.katacontainers.config.hypervisor.cc_init_data'];
 const g=decodeGuestPolicy(encoded), data:any=structuredClone(g.data);
 const rulesSource=read(`${dir}/rules.rego`,'utf8'), settingsSource=read(`${dir}/settings.json`,'utf8');
 const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
 assert.equal(digest(rulesSource),'97e5f7344f3c44eb3a845a4b7dbb51b138c3a4117ae78bed112d0fe4a0272f80');
 assert.equal(digest(settingsSource),'850e168c58e681e1531670fb999ced1582cdfe5037209db3655f676278f8b9bd');
 assert.equal(g.rules.trimEnd(),rulesSource.trimEnd());
 checkGeneratedGuestSettings(data,JSON.parse(settingsSource));
 assert.equal(data.containers.length,3);
 for(const c of data.containers) {
  const o=c.OCI, n=o.Annotations['io.kubernetes.cri.container-name'];
  assert.equal(o.Annotations['io.kubernetes.cri.sandbox-namespace'],ns);
  assert.deepEqual(c.exec_commands,[]);assert.deepEqual(o.Linux.Devices,[]);assert.deepEqual(c.devices,[]);
  if(!n) continue;
  const expected=pod.spec.containers.find((item:any)=>item.name===n);assert.ok(expected);
  assert.equal(o.Annotations['io.kubernetes.cri.image-name'],expected.image);
  assert.deepEqual(o.Process.Args,[...expected.command,...expected.args]);
  assert.equal(o.Root.Readonly,true);assert.equal(o.Process.NoNewPrivileges,true);
  assert.equal(o.Process.User.UID,10001);assert.equal(o.Process.User.GID,10001);
  assert.deepEqual(o.Process.Capabilities.Bounding,[]);
  o.Mounts=o.Mounts.filter((m:any)=>!m.destination.startsWith('/var/run/secrets/'));
  assert.deepEqual(c.storages.map((s:any)=>[s.driver,s.source,s.fstype]),expected.volumeMounts.map(()=>['ephemeral','tmpfs','tmpfs']));
 }
 let rules=g.rules;
 const anchor='    p_oci := p_container.OCI\n\n    # check namespace';assert.equal(rules.split(anchor).length,2);
 rules=rules.replace(anchor,'    p_oci := p_container.OCI\n    allow_pinned_image(p_oci, i_oci, i_storages)\n    required_env_present(p_oci, i_oci)\n    not data.pstate[concat("", ["started.", object.get(p_oci.Annotations, "io.kubernetes.cri.container-name", "sandbox")])]\n\n    # check namespace');
 const state='    ops := concat_op_if_not_null(ret.ops, add_p_container_to_state)';assert.equal(rules.split(state).length,2);
 rules=rules.replace(state,'    base_ops := concat_op_if_not_null(ret.ops, add_p_container_to_state)\n    ops := seal_workload(base_ops, p_oci)');
 rules=rules.replace(/^RemoveContainerRequest:=/m,'reviewed_RemoveContainerRequest:=');
 for(const request of ['ExecProcessRequest','ReadStreamRequest','WriteStreamRequest','CopyFileRequest','SetPolicyRequest','GetDiagnosticDataRequest','AddSwapRequest','UpdateEphemeralMountsRequest','AddSwapPathRequest','StartTracingRequest','AllowRequestsFailingPolicy']) {
  rules=rules.replace(new RegExp(`^${request}[^\\n]* if \\{\\n[\\s\\S]*?^\\}\\n?`,'gm'),'');delete data.request_defaults[request];
 }
 rules=rules.replace(/^allow_copy_file(?:_path)?[^\n]* if \{\n[\s\S]*?^\}\n?/gm,'');
 for(const request of ['UpdateInterfaceRequest','UpdateRoutesRequest','AddARPNeighborsRequest']) {
  assert.equal((rules.match(new RegExp(`^${request} if`,'gm'))??[]).length,1);
  rules=rules.replace(new RegExp(`^${request} if`,'m'),`reviewed_${request} if`);
 }
 // The persistent latch survives container removal; no subsequent host copy or network edits.
 const guards=`
seal_workload(ops, oci) := result if {
    oci.Annotations["io.kubernetes.cri.container-type"] == "container"
    name := oci.Annotations["io.kubernetes.cri.container-name"]
    started := concat_op_if_not_null(ops, state_allows(concat("", ["started.", name]), true))
    result := finish_seal(started, name)
}
seal_workload(ops, oci) := ops if {
    oci.Annotations["io.kubernetes.cri.container-type"] == "sandbox"
}
finish_seal(ops, name) := result if {
    some other in ["trustee", "tng"]
    other != name
    data.pstate[concat("", ["started.", other])]
    result := concat_op_if_not_null(ops, state_allows("trustee", true))
}
finish_seal(ops, name) := ops if {
    not data.pstate[concat("", ["started.", other_name(name)])]
}
other_name("trustee") := "tng"
other_name("tng") := "trustee"
RemoveContainerRequest := result if {
    not startswith(input.container_id, "started.")
    input.container_id != "trustee"
    result := reviewed_RemoveContainerRequest
}
UpdateInterfaceRequest if {
    not data.pstate["started.trustee"]
    not data.pstate["started.tng"]
    reviewed_UpdateInterfaceRequest
    every ip in input.interface.IPAddresses { allowed_ip(ip) }
}
allowed_ip(ip) if { ip.family == 0; ip.mask == "32"; regex.match(${JSON.stringify(network.ipv4AddressPattern)}, ip.address) }
allowed_ip(ip) if { ip.family == 1; ip.mask == "128"; regex.match(${JSON.stringify(network.ipv6AddressPattern)}, ip.address) }
allowed_ip(ip) if { ip.family == 1; ip.mask == "64"; regex.match("^fe80::[0-9a-f:]+$", ip.address) }
UpdateRoutesRequest if {
    not data.pstate["started.trustee"]
    not data.pstate["started.tng"]
    reviewed_UpdateRoutesRequest
    every route in input.routes.Routes {
        not regex.match("^(127[.]|::1(/|$))", route.dest)
        not regex.match("^(127[.]|::1(/|$))", route.gateway)
    }
}
AddARPNeighborsRequest if { not data.pstate["started.trustee"]; not data.pstate["started.tng"]; reviewed_AddARPNeighborsRequest }
required_env_present(p, i) if {
    every env in [value | value := p.Process.Env[_]; not contains(value, "$(")] { env in i.Process.Env }
}
`;
 rules+='\n'+read(fileURLToPath(new URL('../../src/modules/k8s/confidential-guests/assets/guest-pull.rego',import.meta.url)),'utf8')+'\n'+TRUSTEE_STARTUP_METADATA_POLICY+'\n'+guards;
 const result=rules+'\npolicy_data := '+JSON.stringify(data,null,2)+'\n';
 write(`${dir}/${name}.rego`,result);return result;
}

const plan=tngTrusteePlan(config);
const rego=harden('trustee',plan.pod);
const artifact=tngTrusteeInitData(config,{canonicalPodSha256:plan.canonicalPodSha256,policyRego:rego});
write(`${dir}/artifact.json`,JSON.stringify(artifact,null,2));
const app=new App(),chart=new Chart(app,'qualification');new TngTrustee(chart,'trustee',{...config,policy:artifact});
write(`${dir}/manifest.json`,JSON.stringify({apiVersion:'v1',kind:'List',items:chart.toJson()},null,2));
console.log(JSON.stringify({initDataSha256:artifact.initDataSha256,canonicalPodSha256:artifact.canonicalPodSha256}));
