export function sanitizeAwsCliCommand(rawCommand: string): string {
  const command = rawCommand.trim();
  
  // Check for empty command
  if (!command) {
    throw new Error("Command cannot be empty.");
  }
  
  // Comprehensive regex pattern to catch dangerous shell injection patterns
  const dangerousPatterns = [
    // Command chaining and control operators
    /\|\|/,           // OR operator
    /&&/,             // AND operator
    /;/,              // Command separator
    /\|/,             // Pipe operator
    /&/,              // Background process
    /`/,              // Backticks for command substitution
    /\$\([^)]*\)/,    // Command substitution with $()
    /\$\{[^}]*\}/,    // Command substitution with ${}
    
    // Redirection operators
    />/,              // Output redirection
    /</,              // Input redirection
    />>/,             // Append redirection
    /<</,             // Here document
    /2>/,             // Error redirection
    /&>/,             // Redirect both stdout and stderr
    
    // Newlines and other control characters
    /\n/,             // Newlines
    /\r/,             // Carriage returns
    /\t/,             // Tabs (could be used for formatting malicious commands)
    
    // Environment variable injection attempts
    /\$\w+/,          // Environment variables (basic pattern)
    
    // Path traversal attempts
    /\.\./,           // Parent directory traversal
    /\/\.\./,         // Path traversal with slash
    
    // Common injection patterns
    /eval\s*\(/,      // eval() function calls
    /exec\s*\(/,      // exec() function calls
    /system\s*\(/,    // system() function calls
    /shell_exec\s*\(/, // shell_exec() function calls
  ];
  
  // Validate that command starts with expected AWS CLI patterns first
  const validStartPatterns = [
    /^[a-z][a-z0-9-]*\s+/,  // AWS service names (e.g., "s3", "dynamodb", "lambda")
    /^help\s*$/,            // Help command
    /^configure\s+/,        // Configure command
    /^version\s*$/,         // Version command
  ];
  
  const hasValidStart = validStartPatterns.some(pattern => pattern.test(command));
  if (!hasValidStart) {
    throw new Error("Command must start with a valid AWS CLI service or command.");
  }
  
  // Check for dangerous patterns
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      throw new Error(`Command contains forbidden pattern: ${pattern.source}`);
    }
  }
  
  // Additional validation: check for suspicious standalone commands
  // Only flag commands that appear as standalone commands, not as part of AWS CLI operations
  const suspiciousCommands = [
    'rm ', 'del ', 'format ', 'fdisk ', 'mkfs ', 'dd ', 'shred ',
    'wget ', 'curl ', 'nc ', 'netcat ', 'telnet ', 'ssh ', 'scp ', 'rsync ',
    'chmod ', 'chown ', 'sudo ', 'su ', 'passwd ', 'useradd ', 'usermod ',
    'crontab ', 'at ', 'systemctl ', 'service ', 'init ', 'kill ', 'killall ',
    'pkill ', 'xkill ', 'reboot ', 'shutdown ', 'halt ', 'poweroff '
  ];
  
  const lowerCommand = command.toLowerCase();
  for (const suspiciousCmd of suspiciousCommands) {
    if (lowerCommand.includes(suspiciousCmd)) {
      throw new Error(`Command contains potentially dangerous operation: ${suspiciousCmd.trim()}`);
    }
  }
  
  return command;
}
