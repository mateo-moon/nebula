# OAuth2 external authentication

`OAuth2Proxy` creates a credential Secret, one Deployment, a Service and a callback Ingress in that order. `OAuth2ProxyConfig` requires the resource identities, namespace, image, provider, admitted email domains, public host, port, existing TLS secret, ingress class, credentials and container resource requests/limits. Optional `annotations` apply to all four resources. Credentials resolve through Nebula's secret resolver when the construct is instantiated.

The proxy uses nginx external-auth mode with a static upstream. Set the protected ingress's `nginx.ingress.kubernetes.io/auth-url` to `authUrl` and its `nginx.ingress.kubernetes.io/auth-signin` to `signInUrl`; the latter preserves nginx's literal `$escaped_request_uri`. The callback ingress serves `/oauth2` on the same host and reuses the supplied TLS secret. Keep authentication annotations on the protected ingress to avoid authenticating the callback itself.

Images, identity-provider registration, secrets, certificates, DNS and the protected application remain explicit caller inputs. This construct adds no identity-provider provisioning or certificate request.
