# LocalStack MCP Server

A comprehensive LocalStack MCP (Model Context Protocol) Server built with the XMCP framework. This server provides essential tools for managing LocalStack containers and analyzing LocalStack logs with intelligent insights.

## Features

### 🚀 LocalStack Management
- **Unified Management**: Single tool for all LocalStack operations (start, stop, restart, status)
- **Pro Support**: LocalStack Pro integration with auth token management
- **Environment Variables**: Custom environment variable injection
- **Status Monitoring**: Real-time status checking with utility functions
- **Automatic CLI Validation**: Built-in LocalStack CLI dependency checking

### 📊 Intelligent Log Analysis
- **Smart Log Parsing**: Advanced log parsing with service, operation, and error detection
- **Four Analysis Modes**: Summary dashboard, detailed error analysis, API call inspection, and raw logs
- **Error Grouping**: Intelligent grouping of similar errors to reduce noise
- **API Call Analytics**: Comprehensive API call statistics and drill-down capabilities
- **Service-Specific Filtering**: Focus analysis on specific AWS services and operations

### 🚀 Infrastructure Deployment
- **Unified Deployer**: Single tool for CDK and Terraform deployments to LocalStack
- **Auto-Detection**: Automatically infers project type from directory contents
- **Security Validation**: Built-in command injection prevention
- **Dependency Checking**: Validates cdklocal/tflocal availability
- **Rich Output Parsing**: Clean, formatted deployment results with outputs

### 🔐 IAM Policy Analysis
- **Workflow-Oriented**: Complete 2-step workflow for IAM policy development
- **Enforcement Control**: Configure IAM enforcement modes (ENFORCED/SOFT_MODE/DISABLED)
- **Intelligent Log Parsing**: Advanced parsing of LocalStack's IAM denial patterns
- **Automatic Policy Generation**: Generate precise IAM policies from logged permission errors
- **Resource Correlation**: Links DEBUG resource information with INFO denial logs

## Installation

1. **Prerequisites**:
   - Node.js 20.0.0 or higher
   - LocalStack CLI installed (`pip install localstack` or via Docker)
   - Docker (for LocalStack container management)
   - **For deployments**: `cdklocal` (`npm install -g aws-cdk-local aws-cdk`) and/or `tflocal` (`pip install terraform-local`)

2. **Install the server**:
   ```bash
   npm install
   npm run build
   ```

3. **Run the server**:
   ```bash
   npm start
   ```

## Available Tools

### `localstack-management`
Unified tool for all LocalStack operations.

**Parameters**:
- `action` (enum, required): The action to perform (`"start"`, `"stop"`, `"restart"`, `"status"`)
- `enablePro` (boolean, optional): Enable LocalStack Pro services (only for start action)
- `authToken` (string, optional): LocalStack Pro authentication token (only for start action)
- `envVars` (object, optional): Additional environment variables as key-value pairs (only for start action)

**Actions**:

#### Start LocalStack
```javascript
// Basic start
await localstackManagement({ action: "start" });

// Start with Pro services
await localstackManagement({ 
  action: "start",
  enablePro: true,
  authToken: "your-auth-token"
});

// Start with custom environment variables
await localstackManagement({ 
  action: "start",
  envVars: {
    "ENFORCE_IAM": "1",
    "DEBUG": "1"
  }
});
```

#### Stop LocalStack
```javascript
await localstackManagement({ action: "stop" });
```

#### Restart LocalStack
```javascript
await localstackManagement({ action: "restart" });
```

#### Check Status
```javascript
await localstackManagement({ action: "status" });
```

### `localstack-logs-analysis`
Powerful log analyzer that transforms raw LocalStack logs into actionable insights.

**Parameters**:
- `analysisType` (enum, default: "summary"): Analysis mode (`"summary"`, `"errors"`, `"requests"`, `"logs"`)
- `lines` (number, default: 2000): Number of recent log lines to analyze
- `service` (string, optional): Filter by AWS service (e.g., 's3', 'lambda')
- `operation` (string, optional): Filter by API operation (requires service)
- `filter` (string, optional): Keyword filter for raw logs mode

**Analysis Modes**:

#### Summary Mode (Default)
High-level dashboard perfect for initial debugging:
```javascript
// Default usage - shows health overview, service activity, and failed API calls
await localstackLogsAnalysis({ analysisType: "summary" });

// Analyze more log lines for comprehensive overview
await localstackLogsAnalysis({ 
  analysisType: "summary", 
  lines: 5000 
});
```

**Features**:
- 🏥 Health overview with status indicators
- 🔧 Service activity summary with health status
- ❌ Failed API calls table with recent failures
- 🚨 Top error types with occurrence counts
- 🎯 Next steps guidance for debugging

#### Errors Mode
Detailed error analysis with intelligent grouping:
```javascript
// All errors and warnings with full context
await localstackLogsAnalysis({ analysisType: "errors" });

// Focus on specific service errors
await localstackLogsAnalysis({ 
  analysisType: "errors", 
  service: "s3" 
});
```

**Features**:
- 🔴 Grouped error analysis to reduce noise
- 📋 Collapsible error details with full stack traces
- 🕐 Timestamp and context information
- 💡 Debugging suggestions and next steps

#### Requests Mode
API call analysis with powerful drill-down:
```javascript
// Overview of all API calls
await localstackLogsAnalysis({ analysisType: "requests" });

// Focus on specific service
await localstackLogsAnalysis({ 
  analysisType: "requests", 
  service: "lambda" 
});

// Detailed traces for specific operation
await localstackLogsAnalysis({ 
  analysisType: "requests", 
  service: "s3", 
  operation: "CreateBucket" 
});
```

**Features**:
- 🌐 Overall API statistics and success rates
- 🔧 Service-specific operation summaries
- 📋 Detailed call traces with status codes
- 📈 Status code distribution analysis

#### Logs Mode
Raw log inspection with filtering:
```javascript
// Raw logs with keyword filtering
await localstackLogsAnalysis({ 
  analysisType: "logs", 
  filter: "invoke",
  lines: 100 
});

// Recent logs without filtering
await localstackLogsAnalysis({ 
  analysisType: "logs",
  lines: 500 
});
```

**Features**:
- 📜 Raw log output with syntax highlighting
- 🔍 Keyword filtering capabilities
- 📊 Quick statistics even in raw mode

### `localstack-deployer`
Unified infrastructure deployment tool for CDK and Terraform projects.

**Parameters**:
- `action` (enum, required): The deployment action (`"deploy"`, `"destroy"`)
- `projectType` (enum, default: "auto"): Project type (`"auto"`, `"cdk"`, `"terraform"`)
- `directory` (string, required): Path to the project directory
- `variables` (object, optional): Variables for Terraform (-var) or CDK context (-c)

**Deployment Actions**:

#### Deploy Infrastructure
```javascript
// Auto-detect project type and deploy
await localstackDeployer({ 
  action: "deploy",
  directory: "./my-infrastructure"
});

// Deploy CDK with context variables
await localstackDeployer({
  action: "deploy",
  projectType: "cdk",
  directory: "./cdk-app",
  variables: {
    "environment": "dev",
    "region": "us-east-1"
  }
});

// Deploy Terraform with variables
await localstackDeployer({
  action: "deploy", 
  projectType: "terraform",
  directory: "./terraform",
  variables: {
    "instance_type": "t3.micro",
    "environment": "test"
  }
});
```

#### Destroy Infrastructure
```javascript
// Destroy resources
await localstackDeployer({
  action: "destroy",
  directory: "./my-infrastructure"
});

// Destroy with variables
await localstackDeployer({
  action: "destroy",
  directory: "./terraform",
  variables: {
    "environment": "test"
  }
});
```

**Features**:
- 🔍 **Auto-Detection**: Automatically detects CDK (`cdk.json`) or Terraform (`*.tf`) projects
- 🛡️ **Security**: Built-in validation prevents command injection attacks
- 📋 **Rich Output**: Parses and formats deployment outputs in clean Markdown tables
- 🔧 **Sequential Execution**: Proper command sequencing (init → apply/deploy, with error handling)
- ✅ **Dependency Validation**: Checks for `cdklocal`/`tflocal` availability before execution

**Supported Project Types**:
- **CDK**: Projects with `cdk.json`, `app.py`, `app.js`, or `app.ts` files
- **Terraform**: Projects with `*.tf` or `*.tf.json` files  
- **Auto**: Automatically detects project type, handles ambiguous/unknown cases

### `localstack-iam-policy-analyzer`
Workflow-oriented tool for IAM policy development and analysis.

**Parameters**:
- `action` (enum, required): The action to perform (`"set-mode"`, `"analyze-policies"`, `"get-status"`)
- `mode` (enum, optional): IAM enforcement mode (`"ENFORCED"`, `"SOFT_MODE"`, `"DISABLED"`) - required for `set-mode`

**Complete IAM Workflow**:

#### Step 1: Configure IAM Enforcement
```javascript
// Check current IAM enforcement status
await localstackIamPolicyAnalyzer({ action: "get-status" });

// Enable strict IAM enforcement (blocks unauthorized actions)
await localstackIamPolicyAnalyzer({ 
  action: "set-mode", 
  mode: "ENFORCED" 
});

// Or use SOFT_MODE for logging without blocking
await localstackIamPolicyAnalyzer({ 
  action: "set-mode", 
  mode: "SOFT_MODE" 
});
```

#### Step 2: Run Your Application & Generate Policies
```javascript
// After running your app and triggering permission errors:
await localstackIamPolicyAnalyzer({ action: "analyze-policies" });
```

**Features**:
- 🔍 **Smart Log Analysis**: Automatically detects IAM denial patterns in LocalStack logs
- 📋 **Resource Correlation**: Links DEBUG resource ARNs with INFO denial messages for precise policies
- 🚀 **Complete Policy Generation**: Generates ready-to-use IAM policy JSON documents
- 📊 **Comprehensive Reports**: Human-readable permission summaries with actionable insights
- ⚙️ **Enforcement Control**: Easy switching between IAM enforcement modes via HTTP API

**Supported Enforcement Modes**:
- **ENFORCED**: Strict mode - blocks unauthorized actions, perfect for testing real IAM policies
- **SOFT_MODE**: Logging mode - records violations without blocking, ideal for policy development  
- **DISABLED**: No enforcement - allows all actions (LocalStack default behavior)

## Usage Examples

### Complete Development Workflow

#### 1. Initial Setup and Health Check
```javascript
// Start LocalStack with Pro services
await localstackManagement({
  action: "start",
  enablePro: true,
  authToken: "your-auth-token",
  envVars: {
    "ENFORCE_IAM": "1",
    "DEBUG": "1"
  }
});

// Get high-level health overview
await localstackLogsAnalysis({ analysisType: "summary" });
```

#### 2. When Tests Are Failing
```javascript
// Start with summary to understand scope of issues
await localstackLogsAnalysis({ analysisType: "summary" });

// Dive into specific errors
await localstackLogsAnalysis({ analysisType: "errors" });

// Analyze API call patterns
await localstackLogsAnalysis({ analysisType: "requests" });
```

#### 3. Service-Specific Debugging
```javascript
// Focus on S3 service issues
await localstackLogsAnalysis({ 
  analysisType: "errors", 
  service: "s3" 
});

// Examine S3 API call patterns
await localstackLogsAnalysis({ 
  analysisType: "requests", 
  service: "s3" 
});

// Deep dive into specific operation
await localstackLogsAnalysis({ 
  analysisType: "requests", 
  service: "s3", 
  operation: "CreateBucket" 
});
```

#### 4. Performance Analysis
```javascript
// Check overall API call success rates
await localstackLogsAnalysis({ analysisType: "requests" });

// Look for specific error patterns
await localstackLogsAnalysis({ 
  analysisType: "logs", 
  filter: "timeout",
  lines: 1000 
});
```

#### 5. Infrastructure Deployment
```javascript
// Quick deploy with auto-detection
await localstackDeployer({
  action: "deploy",
  directory: "./my-app"
});

// CDK deployment with context
await localstackDeployer({
  action: "deploy",
  projectType: "cdk", 
  directory: "./cdk-stack",
  variables: {
    "environment": "dev",
    "bucketName": "my-test-bucket"
  }
});

// Terraform with variables
await localstackDeployer({
  action: "deploy",
  projectType: "terraform",
  directory: "./terraform/",
  variables: {
    "region": "us-west-2",
    "vpc_cidr": "10.0.0.0/16"
  }
});

// Clean up resources
await localstackDeployer({
  action: "destroy", 
  directory: "./my-app"
});
```

#### 6. IAM Policy Development Workflow
```javascript
// Step 1: Enable IAM enforcement
await localstackIamPolicyAnalyzer({
  action: "set-mode",
  mode: "ENFORCED"
});

// Step 2: Deploy your infrastructure (will likely fail due to missing permissions)
await localstackDeployer({
  action: "deploy",
  directory: "./my-cdk-app"
});

// Step 3: Generate the missing IAM policies automatically
await localstackIamPolicyAnalyzer({
  action: "analyze-policies"
});

// The tool provides a complete IAM policy JSON you can add to your infrastructure code
```

### Natural Language Query Examples

The log analyzer intelligently handles these common developer queries:

- **"My tests are failing, find out what's happening"** → `analysisType: 'summary'`
- **"Show me the errors for the S3 service"** → `analysisType: 'errors', service: 's3'`
- **"What S3 API calls have been made recently?"** → `analysisType: 'requests', service: 's3'`
- **"Show me the last 100 log lines containing 'invoke'"** → `analysisType: 'logs', lines: 100, filter: 'invoke'`
- **"Deploy my CDK app to LocalStack"** → `action: 'deploy', directory: './my-cdk-app'`
- **"Destroy my Terraform resources"** → `action: 'destroy', projectType: 'terraform', directory: './terraform'`
- **"Enable IAM enforcement and help me fix permission errors"** → `action: 'set-mode', mode: 'ENFORCED'` then `action: 'analyze-policies'`
- **"Generate IAM policies from recent failures"** → `action: 'analyze-policies'`

## Configuration

### Environment Variables
- `LOCALSTACK_AUTH_TOKEN`: Pre-configured LocalStack Pro auth token
- Custom environment variables can be passed via the `envVars` parameter in the start action

### LocalStack Pro
To use LocalStack Pro features:
1. Set `enablePro: true` when calling the start action
2. Provide your auth token via the `authToken` parameter or `LOCALSTACK_AUTH_TOKEN` environment variable
3. The server will automatically configure Pro services

## Advanced Log Analysis Features

### Smart Log Parsing
The log analyzer includes sophisticated parsing that automatically detects:
- **Timestamps** in various formats
- **Log levels** (DEBUG, INFO, WARN, ERROR, FATAL)
- **AWS services** mentioned in logs
- **API operations** and method calls
- **HTTP status codes** and response codes
- **Request IDs** for correlation
- **Error patterns** and stack traces

### Intelligent Error Grouping
Similar errors are automatically grouped together by:
- Removing dynamic IDs, timestamps, and IP addresses
- Identifying common error patterns
- Reducing noise from repeated issues
- Showing occurrence frequency

### API Call Analytics
Comprehensive analysis includes:
- Success/failure rates by service
- Operation-level statistics
- Status code distribution
- Failed call details with context
- Performance patterns over time

## Troubleshooting

### Common Issues

1. **"LocalStack CLI not found"**
   - This error appears automatically when CLI validation fails
   - Install LocalStack: `pip install localstack`
   - Verify installation: `localstack --version`
   - All actions automatically validate CLI availability

2. **"Permission denied accessing Docker"**
   - Ensure your user has Docker permissions
   - Try running with `sudo` or add user to docker group

3. **Pro services not working**
   - Verify your auth token is valid
   - Check your LocalStack Pro subscription status
   - Ensure network connectivity to LocalStack Pro services

4. **Log analysis timeouts**
   - Reduce the number of lines with the `lines` parameter
   - Check if LocalStack is generating excessive logs
   - Use more specific filters to reduce processing time

5. **"cdklocal/tflocal not found" (deployment tool)**
   - Install AWS CDK Local: `npm install -g aws-cdk-local aws-cdk`
   - Install Terraform Local: `pip install terraform-local`
   - Verify installation: `cdklocal --version` or `tflocal --version`

6. **"Ambiguous project type"**
   - Both CDK and Terraform files found in directory
   - Specify `projectType` explicitly: `"cdk"` or `"terraform"`

7. **"Security violation" during deployment**
   - Variables contain forbidden shell characters (`;`, `&&`, `|`, etc.)
   - Review and clean variable names and values
   - Use only alphanumeric characters and underscores in variable keys

8. **IAM policy analyzer not finding denials**
   - Ensure IAM enforcement is active: use `get-status` to check current mode
   - Try `set-mode` with `ENFORCED` or `SOFT_MODE` to enable IAM checking
   - Run your application to generate fresh IAM denial logs
   - Check that LocalStack supports IAM enforcement (Pro feature in some versions)

### Debug Mode
Start LocalStack with debug logging:
```javascript
await localstackManagement({
  action: "start",
  envVars: { "DEBUG": "1", "LS_LOG": "debug" }
});
```

## Development

### Building
```bash
npm run build
```

### Development Mode
```bash
npm run dev
```

### Project Structure
```
src/
├── lib/
│   ├── localstack-utils.ts         # Shared LocalStack utilities
│   ├── log-retriever.ts            # Log retrieval and parsing engine (enhanced with IAM parsing)
│   └── deployment-utils.ts         # Deployment utilities and validation
└── tools/
    ├── localstack-management.ts    # Unified LocalStack management
    ├── localstack-logs-analysis.ts # Intelligent log analyzer
    ├── localstack-deployer.ts      # Infrastructure deployment tool
    └── localstack-iam-policy-analyzer.ts # IAM policy development workflow
```

### Utility Functions

#### `localstack-utils.ts`
- `checkLocalStackCli()`: Check CLI availability and version
- `getLocalStackStatus()`: Get status with structured result
- `ensureLocalStackCli()`: Validate CLI for tool execution

#### `log-retriever.ts`
- `LocalStackLogRetriever`: Main log analysis engine
- `retrieveLogs()`: Fetch and parse LocalStack logs
- `parseLogLine()`: Extract structured data from log lines (enhanced with IAM denial detection)
- `groupLogsByError()`: Intelligent error grouping
- `analyzeApiCalls()`: API call statistics and analysis
- **IAM Enhancement**: Detects IAM denial patterns and resource correlation for policy generation

#### `deployment-utils.ts`
- `checkDependencies()`: Validate cdklocal/tflocal availability
- `inferProjectType()`: Auto-detect CDK or Terraform projects
- `validateVariables()`: Security validation for command injection
- `stripAnsiCodes()`: Clean command output formatting
- `parseTerraformOutputs()`: Parse Terraform output JSON
- `parseCdkOutputs()`: Extract CDK deployment outputs

#### `localstack-iam-policy-analyzer.ts`
- **Workflow Actions**: `get-status`, `set-mode`, `analyze-policies` for complete IAM development
- **HTTP API Integration**: Direct communication with LocalStack's IAM configuration endpoint
- **Log Correlation**: Advanced correlation of denial logs with resource information
- **Policy Generation**: Automatic creation of precise IAM policies from observed failures
- **Report Formatting**: Comprehensive Markdown reports with actionable insights

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add new tools in the `src/tools/` directory
4. Follow the XMCP tool pattern (schema, metadata, default function)
5. Update this README with new tool documentation
6. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
