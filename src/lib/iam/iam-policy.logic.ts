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
  const resourcesToActionMap = new Map<string, Set<string>>();

  for (const permission of permissions.values()) {
    const resource = permission.resource || "*";
    if (!resourcesToActionMap.has(resource)) {
      resourcesToActionMap.set(resource, new Set());
    }
    resourcesToActionMap.get(resource)!.add(permission.action);
  }

  const statements = Array.from(resourcesToActionMap.entries()).map(([resource, actions], i) => ({
    Sid: `GeneratedStatement${i + 1}`,
    Effect: "Allow",
    Action: Array.from(actions).sort(),
    Resource: resource,
  }));

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
  result += `- Found **${denials.length}** IAM permission errors.\n`;
  result += `- Identified **${permissions.size}** unique missing permissions.\n`;
  result += `- This affects **${uniquePrincipals.size}** principal(s): \`${Array.from(uniquePrincipals).join("`, `")}\`\n\n`;

  result += `## 📋 Missing Permissions\n\n`;

  for (const permission of permissions.values()) {
    const resourceDisplay =
      permission.resource === "*" ? "any resource" : `resource \`${permission.resource}\``;
    result += `- **Principal** \`${permission.principal}\` is missing action \`${permission.action}\` on ${resourceDisplay}\n`;
  }

  result += `\n## 📝 Generated IAM Identity Policy\n\n`;
  result += `This policy should be attached to the IAM user, role, or group that is making the calls.\n\n`;
  result += `\`\`\`json\n${JSON.stringify(policy, null, 2)}\n\`\`\`\n\n`;

  result += `## 🚀 How to Apply This Policy\n\n`;
  result += `**For CDK/CloudFormation:**\n`;
  result += `1. Add these statements to the IAM Role or User resource's inline policies or a managed policy.\n`;
  result += `2. **Do not add a 'Principal' block** to this policy statement.\n`;
  result += `3. Deploy your stack with the updated permissions.\n\n`;

  result += `**For Terraform:**\n`;
  result += `1. Create an \`aws_iam_policy\` resource using this policy document.\n`;
  result += `2. Attach it to your IAM role, user, or group using an attachment resource (e.g., \`aws_iam_role_policy_attachment\`).\n`;
  result += `3. Apply your Terraform configuration.\n\n`;

  result += `## ⚠️ Important Notes\n\n`;
  result += `- **Review Carefully:** This policy is generated from observed failures. Always follow the principle of least privilege.\n`;
  result += `- **Refine Resources:** Consider refining resource ARNs to be more specific than wildcards (\`*\`) where possible.\n`;

  return {
    content: [{ type: "text", text: result }],
  };
}
