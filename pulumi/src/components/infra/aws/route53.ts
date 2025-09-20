import * as aws from '@pulumi/aws';

export interface Route53Config {
  domain?: string;
}

export class Route53 {
  public readonly zone?: aws.route53.Zone;
  constructor(name: string, config: Route53Config) {
    if (config.domain) {
      this.zone = new aws.route53.Zone(`${name}-zone`, {
        name: config.domain,
        comment: 'Managed by Pulumi',
        forceDestroy: true,
      });
    }
  }
}