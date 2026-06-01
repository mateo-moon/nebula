import { Project } from '../src';
import { InfraConfig, K8sConfig, Addon, AddonConfig } from '../src/components';
import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

/**
 * Example: Using custom addons to create resources beyond the predefined components
 * 
 * This demonstrates how to:
 * 1. Create a custom addon that extends pulumi.ComponentResource
 * 2. Use the addon within a Nebula project
 * 3. Provision custom cloud resources within the addon's scope
 */

// Example 1: Simple custom addon with GCP resources
const myCustomAddon: AddonConfig = {
  name: 'my-custom-addon',
  provision: (scope: Addon) => {
    // Create custom GCP resources within this addon's scope
    const bucket = new gcp.storage.Bucket('my-custom-bucket', {
      name: 'my-custom-bucket-name',
      location: 'US',
    }, { parent: scope });

    // Return outputs for the addon
    return {
      bucketName: bucket.name,
      bucketUrl: bucket.url,
    } as any;
  },
};

// Example 2: Complex addon with multiple resources
const databaseAddon: AddonConfig = {
  name: 'database-addon',
  provision: (scope: Addon) => {
    // Create a Cloud SQL instance
    const database = new gcp.sql.DatabaseInstance('my-database', {
      name: 'my-database-instance',
      databaseVersion: 'POSTGRES_15',
      region: 'us-central1',
      settings: {
        tier: 'db-f1-micro',
      },
    }, { parent: scope });

    // Create a database
    const db = new gcp.sql.Database('my-db', {
      name: 'mydb',
      instance: database.name,
    }, { parent: scope });

    return {
      databaseName: database.name,
      databaseConnectionName: database.connectionName,
      dbName: db.name,
    } as any;
  },
};

// Example 3: Addon that depends on other components
const monitoringAddon: AddonConfig = {
  name: 'monitoring-addon',
  provision: (scope: Addon) => {
    // This addon could depend on outputs from other components
    // Access them through pulumi.output or other means
    
    const notificationChannel = new gcp.monitoring.NotificationChannel('alerts', {
      displayName: 'Alert Channel',
      type: 'email',
      labels: {
        email_address: 'admin@example.com',
      },
    }, { parent: scope });

    return {
      notificationChannel: notificationChannel.name,
    } as any;
  },
};

// Define the project with components and addons
export const project = new Project('nebula-addon-example', undefined, {
  dev: {
    settings: {
      backendUrl: 'gs://my-pulumi-state-bucket',
      secretsProvider: 'gcpkms://projects/my-project/locations/global/keyRings/my-ring/cryptoKeys/pulumi',
      config: {
        'gcp:project': 'my-gcp-project',
        'gcp:region': 'us-central1',
      },
    },
    components: {
      Infra: (): InfraConfig => ({
        gcpConfig: {
          network: {
            cidr: '10.10.0.0/16',
            podsSecondaryCidr: '10.20.0.0/16',
            servicesSecondaryCidr: '10.30.0.0/16',
          },
          gke: {
            name: 'example-gke',
            releaseChannel: 'REGULAR',
            deletionProtection: false,
            nodeGroups: {
              system: {
                minNodes: 1,
                maxNodes: 1,
                machineType: 'e2-standard-4',
                volumeSizeGb: 20,
              },
            },
          },
        },
      }),
      K8s: (): K8sConfig => ({
        kubeconfig: './.config/kube_config',
      }),
    },
    // Add custom addons here
    addons: {
      'my-custom-addon': () => myCustomAddon,
      'database-addon': () => databaseAddon,
      'monitoring-addon': () => monitoringAddon,
    },
  },
});

