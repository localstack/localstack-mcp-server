import { type XmcpConfig } from "xmcp";

const ICON_URL = "https://raw.githubusercontent.com/localstack/localstack-mcp-server/main/icon.png";

const config: XmcpConfig = {
  stdio: true,
  paths: {
    resources: false,
  },
  typescript: {
    skipTypeCheck: true,
  },
  template: {
    name: "LocalStack",
    description: "Manage and interact with LocalStack for local cloud development and testing",
    homePage: "https://www.localstack.cloud",
    // Clients that load tools on demand (e.g. Claude Code) pick them by name; these instructions stay in the
    // agent's context and point it to the IAM tools. Without them, agents in the agentic evaluation never found
    // the IAM actions for a permission error; without the trigger "before concluding that another team or
    // account has to change its policy", agents with the AWS CLI stopped at "the other account must grant us" for a
    // policy they couldn't read (evals/agentic/README.md).
    instructions:
      "IAM in LocalStack: LocalStack records every request it denies, with the policies that decided it. For AccessDenied, permission errors or a request into another account, call localstack-iam with action list-denials before changing an IAM policy, role, bucket, key or queue policy to fix a failure, and before concluding that another team or account has to change its policy: explain-denial shows the statements of policies you can't read yourself (another account's bucket, key or event bus) and the conditions that almost allowed the request, which often tell you what to change in your own request or role. It also shows denials that never surface as an error (an event source, a subscription, a workflow step). After fixing and re-running, call list-denials with newer_than (from the first call's footer) to see only new denials. To write a least-privilege policy for a workload: localstack-iam-management reset-derived-policies, run the workload, then localstack-iam get-derived-policies. Prefer these tools over localstack-iam-policy-analyzer, which parses LocalStack's log.",
    icons: [
      {
        src: ICON_URL,
        mimeType: "image/png",
        sizes: ["256x256"],
      },
    ],
  },
};

export default config;
