import * as pulumi from '@pulumi/pulumi';

export const producerOutput = 'hello-from-producer';
export const complexOutput = {
  nested: {
    value: 'nested-value'
  }
};
