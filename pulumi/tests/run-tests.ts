#!/usr/bin/env tsx
/**
 * Unified test runner for Pulumi secret resolution tests
 * This tests the basic transform-based approach for resolving ref+ secrets
 */

import { 
  type TestConfig, 
  type TestResult,
  runCommand,
  ensureStack,
  cleanup,
  verifySecretHandling,
} from './utils/test-helpers.js';
import * as path from 'path';
import * as fs from 'fs';

interface TestScenario {
  name: string;
  description: string;
  stackName: string;
  mainFile: string;
  expectedSecretValues?: string[];
  disableDefaultProviders?: boolean;
  backendGroupId?: string;
  deploy?: boolean;
}

const scenarios: TestScenario[] = [
  {
    name: 'Stack Ref Producer',
    description: 'Producer stack for stack reference tests',
    stackName: 'producer',
    mainFile: 'scenarios/stack-ref-producer.ts',
    backendGroupId: 'stack-refs',
    deploy: true,
  },
  {
    name: 'Stack Ref Non-Compliant Target',
    description: 'Tests resolution of stack:// references (including raw stack names)',
    stackName: 'test-addon-consumer',
    mainFile: 'scenarios/stack-ref-consumer.ts',
    backendGroupId: 'stack-refs',
    expectedSecretValues: ['hello-from-producer', 'MockCC GCP_ZONE: hello-from-producer'], // Check for MockCC output
  },
  {
    name: 'Basic Secret Resolution',
    description: 'Tests ref+ secret resolution with ConfigMaps',
    stackName: 'test-basic-secrets',
    mainFile: 'scenarios/basic-secret-resolution.ts',
    expectedSecretValues: ['test-secret-value-12345', 'another-secret-value-67890'],
  },
  {
    name: 'Component Resource Secrets',
    description: 'Tests ref+ secrets passed through ComponentResources',
    stackName: 'test-component-secrets',
    mainFile: 'scenarios/component-secret-resolution.ts',
    expectedSecretValues: ['component-secret-value-12345'],
  },
  {
    name: 'SOPS Diagnostic Suppression',
    description: 'Tests that SOPS diagnostic messages are suppressed',
    stackName: 'test-sops-diagnostic',
    mainFile: 'scenarios/sops-diagnostic.ts',
  },
  {
    name: 'Provider Propagation',
    description: 'Tests Kubernetes provider propagation when default providers are disabled',
    stackName: 'test-provider-propagation',
    mainFile: 'scenarios/provider-propagation.ts',
    disableDefaultProviders: true,
  },
  {
    name: 'Cert-Manager Provider',
    description: 'Ensures cert-manager component works with explicit provider when defaults are disabled',
    stackName: 'test-cert-manager-provider',
    mainFile: 'scenarios/cert-manager-provider.ts',
    disableDefaultProviders: true,
  },
  {
    name: 'Karpenter Chart Direct',
    description: 'Tests karpenter-provider-gcp Helm chart directly (bypassing Karpenter component)',
    stackName: 'test-karpenter-chart-direct',
    mainFile: 'scenarios/karpenter-chart-direct.ts',
    disableDefaultProviders: true,
  },
  {
    name: 'Provider Inheritance Test',
    description: 'Simple test to verify provider inheritance from ComponentResource to child resources',
    stackName: 'test-provider-inheritance',
    mainFile: 'scenarios/provider-inheritance-test.ts',
    disableDefaultProviders: true,
  },
  {
    name: 'Cert-Manager Full Stack',
    description: 'Tests cert-manager component in realistic setup matching nebula.config.ts structure',
    stackName: 'test-cert-manager-full-stack',
    mainFile: 'scenarios/cert-manager-full-stack.ts',
    disableDefaultProviders: true,
  },
];

async function runScenario(scenario: TestScenario): Promise<TestResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 Running: ${scenario.name}`);
  console.log(`   ${scenario.description}`);
  console.log('='.repeat(60));

  const config: TestConfig = {
    stackName: scenario.stackName,
    projectName: scenario.stackName.replace(/-/g, '_'),
    testDir: path.join(process.cwd(), 'tests'),
    backendDir: scenario.backendGroupId 
      ? path.join(process.cwd(), 'tests', `.pulumi-backend-group-${scenario.backendGroupId}`)
      : path.join(process.cwd(), 'tests', `.pulumi-backend-${scenario.stackName}`),
    passphrase: 'test123',
  };

  try {
    // Update Pulumi.yaml to point to the correct main file for this scenario
    const pulumiYamlPath = path.join(config.testDir, 'Pulumi.yaml');
    // Use tsx instead of ts-node to avoid module resolution issues with ESM imports
    const pulumiContent = `name: test_pulumi_secrets
description: Test project for Pulumi secret resolution - ${scenario.name}
runtime:
  name: nodejs
  options:
    typescript: false
    nodeargs: --import=tsx/esm
main: ${scenario.mainFile}`;
    fs.writeFileSync(pulumiYamlPath, pulumiContent, 'utf8');
    
    // Ensure backend directory and stack exist
    await ensureStack(config);

    // Select the stack first
    await runCommand(`pulumi stack select ${config.stackName} --non-interactive`, config, config.testDir);
    
    // Set disable-default-providers config if required for this scenario
    if (scenario.disableDefaultProviders) {
      console.log('\n🔧 Setting pulumi:disable-default-providers config...');
      await runCommand(
        `pulumi config set pulumi:disable-default-providers '["kubernetes"]' --non-interactive`,
        config,
        config.testDir
      );
      // Set GCP config for karpenter component (if test uses karpenter)
      await runCommand(
        `pulumi config set gcp:project test-project-12345 --non-interactive`,
        config,
        config.testDir
      );
      await runCommand(
        `pulumi config set gcp:region us-central1 --non-interactive`,
        config,
        config.testDir
      );
      console.log('✅ Config set\n');
    }
    
    // Run pulumi up if deploy is requested
    if (scenario.deploy) {
      console.log('\n🚀 Running pulumi up...\n');
      const upCmd = `pulumi up --yes --non-interactive`;
      const { stdout, stderr } = await runCommand(upCmd, config, config.testDir);
      const output = stdout + stderr;
      
      if (output.includes('error:')) {
        console.log('❌ Deployment failed');
        console.log(output.substring(0, 2000));
        return {
          success: false,
          message: '❌ Deployment failed',
          output
        };
      }
      console.log('✅ Deployment successful');
    }
    
    // Run pulumi preview
    console.log('\n🔍 Running pulumi preview --diff...\n');
    const previewCmd = `pulumi preview --diff --non-interactive`;
    const { stdout, stderr } = await runCommand(previewCmd, config, config.testDir); // Run from testDir where Pulumi.yaml is
    const output = stdout + stderr;
    
    // Always show full output
    console.log('\n=== FULL PULUMI OUTPUT ===');
    console.log(output);
    console.log('=== END PULUMI OUTPUT ===\n');
    
    // Show output if empty or on error
    if (!output || output.trim().length === 0) {
      console.log('⚠️  Preview output is empty!');
      console.log('stdout:', stdout);
      console.log('stderr:', stderr);
    } else if (output.includes('error:') && !output.includes('Kubernetes connection errors are expected')) {
      console.log('⚠️  Errors in preview output:');
      console.log(output.substring(0, 2000));
    }

    // Verify results
    let result: TestResult;
    
    // Check for SOPS diagnostic suppression
    if (scenario.name.includes('SOPS')) {
      const sopsDiagnosticPattern = /sops:\s+successfully\s+retrieved\s+key=/i;
      if (sopsDiagnosticPattern.test(output)) {
        result = {
          success: false,
          message: '❌ SOPS diagnostic message found - it should be suppressed!',
          output,
        };
      } else {
        result = {
          success: true,
          message: '✅ SOPS diagnostic messages are suppressed correctly',
          output,
        };
      }
    } else if (scenario.disableDefaultProviders) {
      // Verify provider propagation - check for Kubernetes provider-related errors specifically
      // Ignore GCP provider errors as those are expected with mock config
      // This matches the actual error: "Default provider for 'kubernetes' disabled. ... must use an explicit provider."
      const kubernetesProviderErrorPatterns = [
        /error:.*kubernetes.*no provider found/i,
        /error:.*default provider.*kubernetes.*disabled/i,
        /error:.*kubernetes.*provider not specified/i,
        /error:.*kubernetes.*missing required.*provider/i,
        /error:.*no kubernetes provider found/i,
        /error:.*default provider for 'kubernetes' disabled/i,
        /error:.*must use an explicit provider/i,
      ];
      
      // Check for general preview failures (these should fail the test even if provider propagation worked)
      const previewFailedPatterns = [
        /error:\s*preview failed/i,
        /error:\s*Preview failed/i,
      ];
      
      const hasKubernetesProviderError = kubernetesProviderErrorPatterns.some(pattern => pattern.test(output));
      const hasPreviewFailed = previewFailedPatterns.some(pattern => pattern.test(output));
      
      // Check if Kubernetes resources show provider in the output (this is the key indicator)
      // Look for [provider=urn:...] pattern which shows provider is attached
      const providerPattern = /\[provider=urn:[^\]]+\]/g;
      const providerMatches = output.match(providerPattern) || [];
      
      // Count Kubernetes resources specifically (not GCP resources)
      const kubernetesProviderMatches = providerMatches.filter((m: string) => m.includes('pulumi:providers:kubernetes'));
      
      // Count Kubernetes resources (excluding the provider resource itself and stack)
      const helmChartResources = (output.match(/kubernetes:helm\.sh\/v4:Chart/g) || []).length;
      // Helm charts create child resources, so we expect at least the chart + namespace + some child resources
      const minExpectedResources = helmChartResources > 0 ? helmChartResources + 2 : 2;
      
      if (hasPreviewFailed) {
        // Preview failures indicate a real problem - preview should not fail
        // Even if provider propagation worked, preview failures mean something is wrong
        const allPreviewErrors = output.match(/error:.*Preview failed[^\n]*/gi) || [];
        const errorMsg = allPreviewErrors[0]?.substring(0, 300) || 'preview failed';
        
        // Check if provider propagation worked despite preview failure
        const providerStatus = kubernetesProviderMatches.length >= minExpectedResources
          ? ` (Provider propagation worked: ${kubernetesProviderMatches.length} resources have providers)`
          : ` (Provider propagation also failed: only ${kubernetesProviderMatches.length} resources have providers)`;
        
        result = {
          success: false,
          message: `❌ Preview failed - ${errorMsg}${providerStatus}`,
          output,
        };
      } else if (hasKubernetesProviderError) {
        // Extract the actual error message for better debugging
        const errorMatch = output.match(/error:.*default provider.*kubernetes.*disabled[^\n]*/i) || 
                          output.match(/error:.*must use an explicit provider[^\n]*/i) ||
                          output.match(/error:.*kubernetes.*provider[^\n]*/i);
        const errorMsg = errorMatch ? errorMatch[0].substring(0, 200) : 'provider error detected';
        result = {
          success: false,
          message: `❌ Kubernetes provider propagation failed - ${errorMsg}`,
          output,
        };
      } else if (kubernetesProviderMatches.length >= minExpectedResources) {
        // If we see Kubernetes providers attached to multiple resources, propagation is working
        result = {
          success: true,
          message: `✅ Kubernetes provider propagation successful - ${kubernetesProviderMatches.length} Kubernetes resources have providers attached`,
          output,
        };
      } else if (kubernetesProviderMatches.length > 0) {
        // At least some Kubernetes resources have providers
        result = {
          success: true,
          message: `✅ Kubernetes provider propagation successful - ${kubernetesProviderMatches.length} Kubernetes resources have providers attached`,
          output,
        };
      } else {
        result = {
          success: false,
          message: '❌ Kubernetes provider propagation failed - no Kubernetes providers found attached to resources',
          output,
        };
      }
    } else if (scenario.expectedSecretValues) {
      // Verify each expected secret
      for (const secretValue of scenario.expectedSecretValues) {
        result = verifySecretHandling(output, secretValue);
        if (!result.success) {
          break;
        }
      }
      result = result! || { success: true, message: '✅ All secrets handled correctly', output };
    } else {
      // Basic success check
      result = {
        success: !output.includes('error:') || output.includes('Kubernetes connection errors are expected'),
        message: output.includes('error:') ? '❌ Errors encountered' : '✅ Test completed successfully',
        output,
      };
    }

    return result;
  } catch (error: any) {
    return {
      success: false,
      message: `❌ Test failed with error: ${error.message}`,
    };
  } finally {
    // Clean up only if not sharing backend group
    if (!scenario.backendGroupId) {
      await cleanup(config);
    }
  }
}

async function runAllTests() {
  console.log('🧪 Starting Pulumi Secret Resolution Tests\n');

  const results: Map<string, TestResult> = new Map();
  const usedBackendGroups = new Set<string>();
  
  // Check for specific test to run
  const testArg = process.argv[2];
  const selectedScenarios = testArg 
    ? scenarios.filter(s => 
        s.name.toLowerCase().includes(testArg.toLowerCase()) ||
        s.stackName.includes(testArg)
      )
    : scenarios;

  if (selectedScenarios.length === 0) {
    console.log(`❌ No test found matching: ${testArg}`);
    process.exit(1);
  }

  // Run selected scenarios
  for (const scenario of selectedScenarios) {
    if (scenario.backendGroupId) {
      usedBackendGroups.add(scenario.backendGroupId);
    }

    const result = await runScenario(scenario);
    results.set(scenario.name, result);
    
    // Show debug output on failure
    if (!result.success && result.output) {
      console.log('\n--- Debug Output ---');
      console.log(result.output.substring(0, 8000));
      console.log('--- End Debug Output ---\n');
    }
  }

  // Clean up shared backend groups
  if (usedBackendGroups.size > 0) {
    console.log('\n🧹 Cleaning up shared backend groups...');
    for (const groupId of usedBackendGroups) {
      const backendDir = path.join(process.cwd(), 'tests', `.pulumi-backend-group-${groupId}`);
      if (fs.existsSync(backendDir)) {
        fs.rmSync(backendDir, { recursive: true, force: true });
        console.log(`  ✅ Removed shared backend group: ${groupId}`);
      }
    }
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('TEST SUMMARY');
  console.log('='.repeat(60) + '\n');

  let allPassed = true;
  for (const [name, result] of results) {
    const status = result.success ? '✅ PASSED' : '❌ FAILED';
    console.log(`${status}: ${name}`);
    if (result.message) {
      console.log(`   ${result.message}`);
    }
    if (!result.success) {
      allPassed = false;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  if (allPassed) {
    console.log('OVERALL: ✅ ALL TESTS PASSED');
  } else {
    console.log('OVERALL: ❌ SOME TESTS FAILED');
  }
  console.log('='.repeat(60));

  process.exit(allPassed ? 0 : 1);
}

// Run tests
runAllTests().catch(console.error);