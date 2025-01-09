import { Kms } from '@module/terraform-aws-modules/aws/kms';
import { IAspect, TerraformElement } from "cdktf";
import { IConstruct } from "constructs";

export class AddPathToTags implements IAspect {
  visit(node: TerraformElement) {
    if (
      !node.hasOwnProperty('inputs') ||
      !(node as any).inputs.hasOwnProperty('tags')
    ) return;
    const tagsToAdd = {path: node.node.path}
    const currentTags = (node as any).inputs.tags || {};
    (node as any).inputs.tags = { ...tagsToAdd, ...currentTags };
  }
}

export class StableLogicalIds implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof TerraformElement) {
      console.log(node.node)
      // Get the constructor name (class name) of the node
      const className = node.constructor.name;
      
      // Combine class name with the path for uniqueness
      const stableId = className.replace(/([a-zA-Z])(?=[A-Z])/g,'$1_').toLowerCase()
      
      // Override the node's logical ID
      node.overrideLogicalId(stableId);
    }
  }
}
