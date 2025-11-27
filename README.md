# **Nebulæ**

  ![enter image description here](https://www.nasa.gov/wp-content/uploads/2023/03/pillars_of_creation.jpg)

## **Overview**

Nebula is a universal tool designed for deploying and maintaining crypto nodes and auxiliary infrastructure. Inspired by the initial state of space where various planets begin to form, Nebula aims to provide a cohesive and scalable environment for setting up and managing blockchain networks and their supporting services.

### **Goals**

•  **Simplify Deployment**: Streamline the process of deploying crypto nodes on bare-metal or cloud-based instances.

•  **Automate Configuration**: Automate the setup and configuration of instances with necessary dependencies.

•  **Kubernetes Integration**: Install and manage Kubernetes clusters using K0s, GKE, EKS, and Constellation.

•  **Resource Management**: Deploy initial Kubernetes resources seamlessly.

•  **Modular Stacks**: Allow for independent deployment of crypto stacks, monitoring, and automation tools.

## **Architecture**

Nebula's architecture is based on a series of fundamental steps:

1. **Provisioning**: Setting up bare-metal or cloud-based instances using Pulumi IaC.

2. **Configuration**: Preparing instances with the required settings and dependencies.

3. **Kubernetes Setup**: Installing K0s or provisioning managed Kubernetes (GKE, EKS, Constellation).

4. **Initial Resources Deployment**: Deploying essential Kubernetes resources like ArgoCD, cert-manager, ingress controllers.

5. **Application Deployment**: Deploying applications including crypto stacks, monitoring, and automation tools.

## **Repository Structure**

    nebula/
    ├── pulumi/           # Pulumi infrastructure as code
    │   ├── src/
    │   │   ├── components/  # Reusable infrastructure components
    │   │   │   ├── infra/  # Cloud infrastructure (GCP, AWS, Constellation)
    │   │   │   └── k8s/    # Kubernetes components
    │   │   ├── utils/      # Utility functions and helpers
    │   │   └── cli.ts      # Nebula CLI commands
    │   └── tests/          # Infrastructure test scenarios
    ├── ansible/          # Ansible playbooks for configuration
    ├── config/           # Configuration files and iPXE scripts
    ├── qemu/            # QEMU testing environment
    ├── scripts/         # Shell scripts for automation
    ├── LICENSE
    └── README.md

## **Technology Stack**

•  **Infrastructure as Code**: [Pulumi](https://www.pulumi.com/) with TypeScript

•  **Provisioning Tools**: Qemu, iPXE, Ansible

•  **Kubernetes Distributions**: 
   - [K0s](https://k0sproject.io/) - Lightweight Kubernetes
   - GKE (Google Kubernetes Engine)
   - EKS (Amazon Elastic Kubernetes Service)
   - Constellation (Confidential Kubernetes)

•  **Continuous Deployment**: [ArgoCD](https://argo-cd.readthedocs.io/), GitHub Actions

•  **Monitoring Tools**: Prometheus, Grafana

•  **Cloud Providers**: 
   - Google Cloud Platform (GCP) - Full support
   - Amazon Web Services (AWS) - Full support
   - Microsoft Azure - In progress

## **Getting Started**

### **Prerequisites**

•  **Operating System**: Linux, macOS

•  **Required Tools**: 
   - Git for version control
   - Docker (recommend [Orbstack](https://orbstack.dev/) for macOS)
   - [Just](https://github.com/casey/just) - Command runner
   - [Pulumi](https://www.pulumi.com/) - Infrastructure as Code
   - Node.js 18+ and pnpm package manager
   - [Helm](https://helm.sh/) - Kubernetes package manager
   - [helm-git plugin](https://github.com/aslafy-z/helm-git) - Required for Karpenter GCP provider:
     ```bash
     helm plugin install https://github.com/aslafy-z/helm-git --version 1.4.1
     ```

### **Installation**

```bash
# macOS installation
brew install just git node pnpm && brew install --cask orbstack
curl -fsSL https://get.pulumi.com | sh

# Linux installation
curl -fsSL https://get.pulumi.com | sh
npm install -g pnpm
```

----

## **Pulumi Infrastructure Management**

### **Kubeconfig Naming Convention**

Nebula automatically generates standardized kubeconfig files with a clean, predictable naming pattern:

```
.config/kube-config-{project}-{environment}-{provider}
```

**Examples:**
- `.config/kube-config-kurtosis-dev-gke` - Kurtosis project, dev environment, on GKE
- `.config/kube-config-myapp-prod-eks` - MyApp project, production environment, on EKS
- `.config/kube-config-tool-staging-constellation` - Tool project, staging environment, on Constellation

**Features:**
- ✅ Automatically extracts project name from Pulumi project
- ✅ Environment prefix derived from stack name (e.g., "dev" from "dev-infra")
- ✅ Provider-specific configuration (gke, eks, constellation)
- ✅ Intelligent deduplication prevents redundant naming
- ✅ Files stored in `.config/` directory at project root
- ✅ Automatic kubeconfig validation

### **Example: Deploying Infrastructure with Pulumi**

#### **1. Clone the Repository**

```bash
git clone https://github.com/yourusername/nebula.git
cd nebula/pulumi
```

#### **2. Install Dependencies**

```bash
pnpm install
```

#### **3. Configure Your Project**

Create a `nebula.config.ts` file in your project directory:

```typescript
import { Project } from 'nebula';
import type { InfraConfig, K8sConfig } from 'nebula/components';

export const outputs = new Project('myapp', {
  backendUrl: 'gs://my-pulumi-state',
}, {
  dev: {
    settings: {
      config: {
        'gcp:project': 'my-gcp-project',
        'gcp:region': 'us-central1',
      },
    },
    components: {
      Infra: (): InfraConfig => ({
        gcpConfig: {
          network: {
            podsSecondaryCidr: '10.0.0.0/16',
            servicesSecondaryCidr: '10.1.0.0/16',
          },
          gke: {
            name: 'myapp-dev-gke',
            location: 'us-central1-a',
            releaseChannel: 'REGULAR',
            deletionProtection: false,
          },
        },
      }),
      K8s: (): K8sConfig => ({
        kubeconfig: '.config/kube-config-myapp-dev-gke',
        certManager: { enabled: true },
        ingressNginx: { enabled: true },
        // Additional K8s components...
      }),
    },
  },
}).outputs;
```

#### **4. Deploy Infrastructure**

```bash
# Initialize authentication
nebula bootstrap

# Deploy infrastructure stack
nebula up dev-infra

# Deploy Kubernetes components
nebula up dev-k8s

# Deploy applications
nebula up dev-app
```

#### **5. Access Your Cluster**

The kubeconfig is automatically generated and placed in the `.config/` directory:

```bash
# Use the auto-generated kubeconfig
export KUBECONFIG=$(pwd)/.config/kube-config-myapp-dev-gke

# Verify cluster access
kubectl get nodes
kubectl get pods --all-namespaces
```

## **Nebula CLI Commands**

The Nebula CLI provides convenient commands for managing infrastructure:

```bash
# Authentication and setup
nebula bootstrap          # Initialize cloud authentication and setup

# Stack management
nebula up <stack>        # Deploy a stack
nebula destroy <stack>   # Destroy a stack  
nebula preview <stack>   # Preview changes before deploying
nebula refresh <stack>   # Refresh stack state

# Utility commands
nebula kubeconfig        # List available kubeconfig files
nebula test              # Run infrastructure tests
nebula clean             # Clean up temporary files

# Stack naming convention
# Format: {environment}-{component}
# Examples: dev-infra, dev-k8s, dev-app, prod-infra, prod-k8s
```

## **Project Structure Example**

Here's how to organize a project using Nebula:

```
my-project/
├── nebula.config.ts      # Main Nebula configuration
├── .config/              # Auto-generated kubeconfig files
│   ├── kube-config-myapp-dev-gke
│   ├── kube-config-myapp-prod-gke
│   └── kube-config-myapp-staging-eks
├── infrastructure/       # Additional infrastructure code
├── applications/         # Application deployments
└── package.json         # Project dependencies
```

## **Advanced Features**

### **Multi-Environment Support**

Nebula supports multiple environments (dev, staging, prod) with isolated configurations:

```typescript
export const outputs = new Project('myapp', {
  backendUrl: 'gs://my-pulumi-state',
}, {
  dev: { /* dev config */ },
  staging: { /* staging config */ },
  prod: { /* prod config */ },
}).outputs;
```

### **Secret Management**

Nebula integrates with cloud KMS for secret management:

```typescript
settings: {
  secretsProvider: 'gcpkms://projects/my-project/locations/global/keyRings/my-keyring/cryptoKeys/my-key',
  // Secrets are automatically encrypted/decrypted
}
```

### **Component Library**

Nebula provides pre-built components for common infrastructure patterns:

- **Infrastructure Components**: VPCs, subnets, firewalls, load balancers
- **Kubernetes Components**: cert-manager, ingress-nginx, external-dns, prometheus
- **Security Components**: workload identity, RBAC, network policies
- **Autoscaling**: Karpenter, Cluster Autoscaler

## **Contributing**

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### **Development Setup**

```bash
# Clone the repository
git clone https://github.com/yourusername/nebula.git
cd nebula

# Install dependencies
cd pulumi && pnpm install

# Run tests
pnpm test

# Run linting
pnpm lint
```

## **Roadmap**

- ✅ GCP/GKE Support
- ✅ AWS/EKS Support  
- ✅ Pulumi Infrastructure as Code
- ✅ Automated kubeconfig management
- ✅ Component library
- 🚧 Azure/AKS Support
- 🚧 Terraform provider support
- 📋 Web UI for infrastructure management
- 📋 Cost optimization recommendations
- 📋 Compliance and security scanning

## **License**

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## **Support**

- 📖 [Documentation](https://github.com/yourusername/nebula/wiki)
- 💬 [Discussions](https://github.com/yourusername/nebula/discussions)
- 🐛 [Issue Tracker](https://github.com/yourusername/nebula/issues)
- 📧 Contact: support@nebula.dev

---

Built with ❤️ by the Nebula team