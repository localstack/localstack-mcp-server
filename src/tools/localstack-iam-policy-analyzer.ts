import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { ensureLocalStackCli } from "../lib/localstack-utils";
import { LocalStackLogRetriever, type LogEntry } from "../lib/log-retriever";

export const schema = {
  action: z.enum(['set-mode', 'analyze-policies', 'get-status'])
    .describe("The action to perform: 'set-mode' to configure enforcement, 'analyze-policies' to generate a policy from logs, or 'get-status' to check the current mode."),
  mode: z.enum(['ENFORCED', 'SOFT_MODE', 'DISABLED']).optional()
    .describe("The enforcement mode to set. This is required only when the action is 'set-mode'."),
};

export const metadata: ToolMetadata = {
  name: "localstack-iam-policy-analyzer",
  description: "Configures LocalStack's IAM enforcement and analyzes logs to automatically generate missing IAM policies.",
  annotations: {
    title: "LocalStack IAM Policy Analyzer",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

const IAM_CONFIG_URL = 'http://localhost:4566/_aws/iam/config';

interface IamConfigResponse {
  state: string;
  [key: string]: any;
}

interface UniquePermission {
  principal: string;
  action: string;
  resource: string;
}

export default async function localstackIamPolicyAnalyzer({ action, mode }: InferSchema<typeof schema>) {
  const cliError = await ensureLocalStackCli();
  if (cliError) return cliError;

  switch (action) {
    case 'get-status':
      return await handleGetStatus();
    case 'set-mode':
      if (!mode) {
        return {
          content: [{ 
            type: "text", 
            text: `❌ **Missing Required Parameter**

The 'mode' parameter is required when using 'set-mode' action.

Valid modes:
- **ENFORCED**: Strict IAM enforcement (blocks unauthorized actions)
- **SOFT_MODE**: Log IAM violations without blocking
- **DISABLED**: Turn off IAM enforcement completely` 
          }],
        };
      }
      return await handleSetMode(mode);
    case 'analyze-policies':
      return await handleAnalyzePolicies();
    default:
      return {
        content: [{ 
          type: "text", 
          text: `❌ Unknown action: ${action}. Supported actions: get-status, set-mode, analyze-policies` 
        }],
      };
  }
}

async function handleGetStatus() {
  try {
    const response = await fetch(IAM_CONFIG_URL, { method: 'GET' });
    
    if (!response.ok) {
      if (response.status === 404) {
        return {
          content: [{ 
            type: "text", 
            text: `⚠️ **LocalStack IAM Configuration Not Available**

This could mean:
- LocalStack is not running
- LocalStack version doesn't support IAM configuration
- IAM enforcement is not available in your LocalStack version

Please ensure LocalStack is running and supports IAM enforcement.` 
          }],
        };
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const config: IamConfigResponse = await response.json();
    const currentState = config.state || 'UNKNOWN';
    
    let statusEmoji = '⚠️';
    let statusDescription = '';
    
    switch (currentState) {
      case 'ENFORCED':
        statusEmoji = '🔒';
        statusDescription = 'Strict IAM enforcement is active. Unauthorized actions will be blocked.';
        break;
      case 'SOFT_MODE':
        statusEmoji = '📝';
        statusDescription = 'IAM violations are logged but not blocked. Good for testing and policy development.';
        break;
      case 'DISABLED':
        statusEmoji = '🔓';
        statusDescription = 'IAM enforcement is disabled. All actions are permitted.';
        break;
      default:
        statusDescription = `Unknown state: ${currentState}`;
    }

    return {
      content: [{ 
        type: "text", 
        text: `${statusEmoji} **LocalStack IAM Enforcement Status**

**Current Mode:** \`${currentState}\`

${statusDescription}

**Available Actions:**
- Use \`set-mode\` to change enforcement mode
- Use \`analyze-policies\` to generate policies from recent IAM denials` 
      }],
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ 
        type: "text", 
        text: `❌ **Failed to Get IAM Status**

Error: ${errorMessage}

**Troubleshooting:**
- Ensure LocalStack is running on port 4566
- Check if your LocalStack version supports IAM enforcement
- Verify network connectivity to LocalStack` 
      }],
    };
  }
}

async function handleSetMode(mode: 'ENFORCED' | 'SOFT_MODE' | 'DISABLED') {
  try {
    const payload = { state: mode };
    
    const response = await fetch(IAM_CONFIG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    let nextStepGuidance = '';
    let modeEmoji = '⚙️';
    
    switch (mode) {
      case 'ENFORCED':
        modeEmoji = '🔒';
        nextStepGuidance = `
**🎯 Next Step:** Now, run your application, deployment, or tests that are failing due to permissions.

Once you have triggered the errors, ask me to "**analyze the IAM policies**" to automatically generate the required permissions.

**Example workflow:**
1. Deploy your CDK/Terraform stack
2. Run your application tests
3. Use \`analyze-policies\` action to generate missing IAM policies`;
        break;
      case 'SOFT_MODE':
        modeEmoji = '📝';
        nextStepGuidance = `
**🎯 Next Step:** Run your application to log IAM violations without blocking them.

This mode is perfect for:
- Understanding what permissions your app needs
- Testing policy changes safely
- Gradual migration to stricter IAM enforcement`;
        break;
      case 'DISABLED':
        modeEmoji = '🔓';
        nextStepGuidance = `
**Note:** IAM enforcement is now disabled. All AWS actions will be permitted regardless of policies.`;
        break;
    }

    return {
      content: [{ 
        type: "text", 
        text: `${modeEmoji} **IAM Enforcement Mode Updated**

✅ IAM enforcement mode has been set to \`${mode}\`.

${nextStepGuidance}` 
      }],
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ 
        type: "text", 
        text: `❌ **Failed to Set IAM Mode**

Error: ${errorMessage}

**Troubleshooting:**
- Ensure LocalStack is running on port 4566
- Check if your LocalStack version supports IAM configuration
- Verify you have permission to modify LocalStack settings` 
      }],
    };
  }
}

async function handleAnalyzePolicies() {
  try {
    const logRetriever = new LocalStackLogRetriever();
    const logResult = await logRetriever.retrieveLogs(5000);

    if (!logResult.success) {
      return {
        content: [{ 
          type: "text", 
          text: `❌ **Failed to Retrieve Logs**

${logResult.errorMessage}

Please ensure LocalStack is running and generating logs.` 
        }],
      };
    }

    const iamDenials = logResult.logs.filter(log => log.isIamDenial === true);

    if (iamDenials.length === 0) {
      return {
        content: [{ 
          type: "text", 
          text: `✅ **Analysis Complete - No IAM Denials Found**

No IAM permission errors were found in the recent logs.

**This means either:**
- Your application has all necessary permissions
- IAM enforcement is not active (check with \`get-status\`)
- No recent activity has triggered permission checks
- IAM denials occurred outside the analyzed log window

**Next steps:**
- If you expected to see denials, ensure IAM enforcement is in \`ENFORCED\` or \`SOFT_MODE\`
- Try running your application again to generate fresh logs
- Increase the log analysis window if needed` 
        }],
      };
    }

    const enrichedDenials = await enrichWithResourceData(iamDenials, logResult.logs);
    const uniquePermissions = deduplicatePermissions(enrichedDenials);
    const iamPolicy = generateIamPolicy(uniquePermissions);
    
    return formatPolicyReport(enrichedDenials, uniquePermissions, iamPolicy);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ 
        type: "text", 
        text: `❌ **Policy Analysis Failed**

Error: ${errorMessage}

Please ensure LocalStack is running and check the logs for more details.` 
      }],
    };
  }
}

async function enrichWithResourceData(denials: LogEntry[], allLogs: LogEntry[]): Promise<LogEntry[]> {
  const enriched: LogEntry[] = [];

  for (const denial of denials) {
    const enrichedDenial = { ...denial };

    if (denial.timestamp && denial.iamAction) {
      const denialTime = new Date(denial.timestamp);
      
      const nearbyResourceLogs = allLogs.filter(log => {
        if (!log.timestamp || !log.iamResource) return false;
        
        const logTime = new Date(log.timestamp);
        const timeDiff = Math.abs(logTime.getTime() - denialTime.getTime());
        
        return log.iamAction === denial.iamAction && timeDiff <= 5000;
      });

      if (nearbyResourceLogs.length > 0) {
        enrichedDenial.iamResource = nearbyResourceLogs[0].iamResource;
      }
    }

    enriched.push(enrichedDenial);
  }

  return enriched;
}

function deduplicatePermissions(denials: LogEntry[]): Map<string, UniquePermission> {
  const permissionMap = new Map<string, UniquePermission>();

  for (const denial of denials) {
    if (!denial.iamPrincipal || !denial.iamAction) continue;

    const resource = denial.iamResource || '*';
    const key = `${denial.iamPrincipal}|${denial.iamAction}|${resource}`;

    if (!permissionMap.has(key)) {
      permissionMap.set(key, {
        principal: denial.iamPrincipal,
        action: denial.iamAction,
        resource: resource,
      });
    }
  }

  return permissionMap;
}

function generateIamPolicy(permissions: Map<string, UniquePermission>) {
  const principalMap = new Map<string, Map<string, Set<string>>>();

  for (const permission of permissions.values()) {
    if (!principalMap.has(permission.principal)) {
      principalMap.set(permission.principal, new Map());
    }
    
    const principalPerms = principalMap.get(permission.principal)!;
    
    if (!principalPerms.has(permission.resource)) {
      principalPerms.set(permission.resource, new Set());
    }
    
    principalPerms.get(permission.resource)!.add(permission.action);
  }

  const statements: any[] = [];
  let statementId = 1;

  for (const [principal, resourceMap] of principalMap.entries()) {
    for (const [resource, actions] of resourceMap.entries()) {
      statements.push({
        Sid: `AllowPrincipal${statementId}`,
        Effect: "Allow",
        Principal: {
          Service: principal
        },
        Action: Array.from(actions).sort(),
        Resource: resource === '*' ? '*' : resource
      });
      statementId++;
    }
  }

  return {
    Version: "2012-10-17",
    Statement: statements
  };
}

function formatPolicyReport(
  denials: LogEntry[], 
  permissions: Map<string, UniquePermission>, 
  policy: any
) {
  const uniquePrincipals = new Set(Array.from(permissions.values()).map(p => p.principal));
  
  let result = `# 🔍 IAM Policy Analysis Report\n\n`;
  result += `**Analysis Summary:**\n`;
  result += `- Found **${denials.length}** IAM permission errors\n`;
  result += `- Identified **${permissions.size}** unique missing permissions\n`;
  result += `- Affects **${uniquePrincipals.size}** principal(s)\n\n`;

  result += `## 📋 Missing Permissions\n\n`;
  
  for (const permission of permissions.values()) {
    const resourceDisplay = permission.resource === '*' ? 'any resource' : `resource \`${permission.resource}\``;
    result += `- **Principal** \`${permission.principal}\` is missing action \`${permission.action}\` on ${resourceDisplay}\n`;
  }

  result += `\n## 📝 Generated IAM Policy\n\n`;
  result += `Copy and apply this policy to resolve the permission errors:\n\n`;
  result += `\`\`\`json\n${JSON.stringify(policy, null, 2)}\n\`\`\`\n\n`;

  result += `## 🚀 How to Apply This Policy\n\n`;
  result += `**For CDK/CloudFormation:**\n`;
  result += `1. Add this policy to your IAM role or user resource\n`;
  result += `2. Update the Principal section to match your specific use case\n`;
  result += `3. Deploy your stack with the updated permissions\n\n`;

  result += `**For Terraform:**\n`;
  result += `1. Create an \`aws_iam_policy\` resource with this policy document\n`;
  result += `2. Attach it to your IAM role using \`aws_iam_role_policy_attachment\`\n`;
  result += `3. Apply your Terraform configuration\n\n`;

  result += `## ⚠️ Important Notes\n\n`;
  result += `- **Review Carefully:** This policy is generated from observed failures and may be broader than necessary\n`;
  result += `- **Least Privilege:** Consider refining resource ARNs to be more specific than wildcards\n`;
  result += `- **Testing:** Test this policy in a non-production environment first\n`;
  result += `- **Monitoring:** Continue monitoring for any additional permission errors\n`;

  return {
    content: [{ type: "text", text: result }],
  };
}
