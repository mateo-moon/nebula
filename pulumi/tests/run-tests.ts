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
}

const scenarios: TestScenario[] = [
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
    backendDir: path.join(process.cwd(), 'tests', `.pulumi-backend-${scenario.stackName}`),
    passphrase: 'test123',
  };

  try {
    // Update Pulumi.yaml to point to the correct main file for this scenario
    const pulumiYamlPath = path.join(config.testDir, 'Pulumi.yaml');
    const pulumiContent = `name: test_pulumi_secrets
description: Test project for Pulumi secret resolution - ${scenario.name}
runtime:
  name: nodejs
  options:
    typescript: true
main: ${scenario.mainFile}`;
    fs.writeFileSync(pulumiYamlPath, pulumiContent, 'utf8');
    
    // Ensure backend directory and stack exist
    await ensureStack(config);

    // Select the stack first
    await runCommand(`pulumi stack select ${config.stackName} --non-interactive`, config, config.testDir);
    
    // Run pulumi preview
    console.log('\n🔍 Running pulumi preview --diff --debug...\n');
    const previewCmd = `pulumi preview --diff --debug --non-interactive`;
    const { stdout, stderr } = await runCommand(previewCmd, config, config.testDir); // Run from testDir where Pulumi.yaml is
    const output = stdout + stderr;
    
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
    // Clean up
    await cleanup(config);
  }
}

async function runAllTests() {
  console.log('🧪 Starting Pulumi Secret Resolution Tests\n');

  const results: Map<string, TestResult> = new Map();
  
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
    const result = await runScenario(scenario);
    results.set(scenario.name, result);
    
    // Show debug output on failure
    if (!result.success && result.output) {
      console.log('\n--- Debug Output ---');
      console.log(result.output.substring(0, 8000));
      console.log('--- End Debug Output ---\n');
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