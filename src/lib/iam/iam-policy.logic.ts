import { type LogEntry } from "../logs/log-retriever";

interface UniquePermission {
  principal: string;
  action: string;
  resource: string;
}

export async function enrichWithResourceData(
  denials: LogEntry[],
  allLogs: LogEntry[]
): Promise<LogEntry[]> {
  const enriched: LogEntry[] = [];

  for (const denial of denials) {
    const enrichedDenial = { ...denial };

    if (denial.timestamp && denial.iamAction) {
      const denialTime = new Date(denial.timestamp);

      const nearbyResourceLogs = allLogs.filter((log) => {
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

export function deduplicatePermissions(denials: LogEntry[]): Map<string, UniquePermission> {
  const permissionMap = new Map<string, UniquePermission>();

  for (const denial of denials) {
    if (!denial.iamPrincipal || !denial.iamAction) continue;

    const resource = denial.iamResource || "*";
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

export function generateIamPolicy(permissions: Map<string, UniquePermission>) {
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
          Service: principal,
        },
        Action: Array.from(actions).sort(),
        Resource: resource === "*" ? "*" : resource,
      });
      statementId++;
    }
  }

  return {
    Version: "2012-10-17",
    Statement: statements,
  };
}

export function formatPolicyReport(
  denials: LogEntry[],
  permissions: Map<string, UniquePermission>,
  policy: any
) {
  const uniquePrincipals = new Set(Array.from(permissions.values()).map((p) => p.principal));

  let result = `# 🔍 IAM Policy Analysis Report\n\n`;
  result += `**Analysis Summary:**\n`;
  result += `- Found **${denials.length}** IAM permission errors\n`;
  result += `- Identified **${permissions.size}** unique missing permissions\n`;
  result += `- Affects **${uniquePrincipals.size}** principal(s)\n\n`;

  result += `## 📋 Missing Permissions\n\n`;

  for (const permission of permissions.values()) {
    const resourceDisplay =
      permission.resource === "*" ? "any resource" : `resource \`${permission.resource}\``;
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
