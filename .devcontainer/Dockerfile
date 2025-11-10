FROM mcr.microsoft.com/devcontainers/typescript-node:20

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    sudo \
    ca-certificates \
    jq \
    gnupg2 \
    scdaemon \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# Switch to node user for Pulumi installation
USER node

# Install Pulumi CLI for node user
RUN curl -fsSL https://get.pulumi.com | sh && \
    echo 'export PATH=$PATH:$HOME/.pulumi/bin' >> /home/node/.bashrc && \
    echo 'export PATH=$PATH:$HOME/.pulumi/bin' >> /home/node/.profile

# Switch back to root for remaining installations
USER root

# Install vals tool
RUN VALS_TAG=$(curl -s https://api.github.com/repos/variantdev/vals/releases/latest | jq -r '.tag_name // empty') && \
    if [ -z "$VALS_TAG" ]; then \
        echo "Failed to get tag, using hardcoded version v0.28.0" && \
        VALS_TAG="v0.28.0"; \
    fi && \
    VALS_VERSION=$(echo $VALS_TAG | sed 's/^v//') && \
    curl -fsSL -L "https://github.com/variantdev/vals/releases/download/${VALS_TAG}/vals_${VALS_VERSION}_linux_amd64.tar.gz" -o /tmp/vals.tar.gz && \
    tar -xzf /tmp/vals.tar.gz -C /tmp && \
    mv /tmp/vals /usr/local/bin/vals && \
    chmod +x /usr/local/bin/vals && \
    rm -f /tmp/vals.tar.gz && \
    vals version

# Install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && \
    mv kubectl /usr/local/bin/

# Install Helm
RUN curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Set up environment variables
ENV PATH=$PATH:/home/node/.pulumi/bin
ENV PULUMI_CONFIG_PASSPHRASE=password

# Switch to node user
USER node

# Set working directory
WORKDIR /workspaces/nebula

# Default command
CMD ["sleep", "infinity"]

