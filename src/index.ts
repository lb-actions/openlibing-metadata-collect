/**
 * openlibing-metadata-collect 主入口
 *
 * GitCode Actions 插件，用于收集 pytest 测试用例元数据并生成 XML 报告
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/**
 * Sanitize output value for CI output file.
 * Escapes newlines, carriage returns, equals signs, and backslashes to prevent CI output injection.
 */
function sanitizeOutputValue(value: string): string {
  if (!value) return "";
  // Escape characters that could break CI output format:
  // \ (backslash) - must be first to prevent bypass via \n sequence
  // \n (newline) - could inject new output variables
  // \r (carriage return) - could corrupt output format
  // = (equals) - could create new key-value pairs
  return value
    .replace(/\\/g, "\\\\") // Backslash (must be first)
    .replace(/\n/g, "\\n") // Newline
    .replace(/\r/g, "\\r") // Carriage return
    .replace(/=/g, "\\="); // Equals
}

/**
 * Pytest 执行结果接口
 */
interface PytestResult {
  success: boolean;
  error: Error | null;
  stdout: string;
  stderr: string;
}

/**
 * 执行 pytest 收集用例
 */
async function runPytest(
  pythonCommand: string,
  testcasePath: string,
  pytestConfigFile: string,
  metadataOutput: string
): Promise<PytestResult> {
  // 验证路径安全性：检查原始路径是否包含路径遍历字符
  if (path.normalize(testcasePath).includes("..")) {
    throw new Error("Testcase path contains path traversal characters");
  }
  if (path.normalize(metadataOutput).includes("..")) {
    throw new Error("Metadata output path contains path traversal characters");
  }

  // 转换为绝对路径供后续使用
  const safeTestcasePath = path.resolve(testcasePath);
  const safeMetadataOutput = path.resolve(metadataOutput);

  let stdout = "";
  let stderr = "";

  const options: exec.ExecOptions = {
    cwd: safeTestcasePath, // 使用验证后的路径
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      },
      stderr: (data: Buffer) => {
        stderr += data.toString();
      },
    },
    silent: true,
    // 清理环境变量，只保留必要的环境变量
    env: {
      // 核心环境变量
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      USER: process.env.USER || "",
      LANG: process.env.LANG || "C.UTF-8",
      // Python相关环境变量
      PYTHONPATH: process.env.PYTHONPATH || "",
      PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || "",
      VIRTUAL_ENV: process.env.VIRTUAL_ENV || "",
      // 系统环境变量
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || "",
      TERM: process.env.TERM || "",
      SHELL: process.env.SHELL || "",
      PWD: process.env.PWD || "",
      TZ: process.env.TZ || "",
      LANGUAGE: process.env.LANGUAGE || "",
      // 代理设置
      HTTP_PROXY: process.env.HTTP_PROXY || "",
      HTTPS_PROXY: process.env.HTTPS_PROXY || "",
      NO_PROXY: process.env.NO_PROXY || "",
      http_proxy: process.env.http_proxy || "",
      https_proxy: process.env.https_proxy || "",
      no_proxy: process.env.no_proxy || "",
    },
  };

  // 构建 pytest 参数
  const args: string[] = [
    "-m",
    "pytest",
    "--collect-only",
    "--tb=no",
    "-q",
    "--rootdir",
    safeTestcasePath, // 使用验证后的路径
    "--metadata-output",
    safeMetadataOutput, // 使用验证后的路径
  ];

  // 添加配置文件参数（如果指定）
  if (pytestConfigFile) {
    // 验证配置文件路径安全性
    if (path.normalize(pytestConfigFile).includes("..")) {
      throw new Error("Config file path contains path traversal characters");
    }
    const safeConfigPath = path.resolve(pytestConfigFile);
    args.push("-c", safeConfigPath);
    // 注意：使用配置文件时，不手动指定测试路径
    // 让 pytest 根据配置文件中的 testpaths 自动收集
  } else {
    // 没有配置文件时，才手动指定测试路径
    args.push(safeTestcasePath);
  }

  try {
    await exec.exec(pythonCommand, args, options);
    return { success: true, error: null, stdout, stderr };
  } catch (error) {
    return { success: false, error: error as Error, stdout, stderr };
  }
}

/**
 * 验证路径安全性，防止路径遍历攻击
 */
function validatePath(inputPath: string, paramName: string): string {
  if (!inputPath || inputPath.trim() === "") {
    throw new Error(`${paramName} cannot be empty`);
  }

  // 检查路径是否包含路径遍历字符
  if (path.normalize(inputPath).includes("..")) {
    throw new Error(`${paramName} contains path traversal characters: ${inputPath}`);
  }

  // 转换为绝对路径返回
  return path.resolve(inputPath);
}

/**
 * 验证输出路径的文件名必须以 metadata 开头
 */
function validateOutputPath(outputPath: string): string {
  const absolutePath = validatePath(outputPath, "metadata-output-path");

  // 获取文件名并检查是否以 metadata 开头
  const basename = path.basename(absolutePath);
  if (!basename.startsWith("metadata")) {
    throw new Error(
      `Output file name must start with 'metadata', got: ${basename}. ` +
        `Please ensure the file name begins with 'metadata' (e.g., metadata_test.xml, metadata_report.xml)`
    );
  }

  return absolutePath;
}

/**
 * Validate download URL for security.
 * Only allows HTTPS protocol and trusted domains (gitcode.com).
 * Prevents supply chain attacks via malicious package download.
 */
function validateDownloadUrl(url: string, paramName: string): string {
  if (!url || url.trim() === "") {
    throw new Error(`${paramName} cannot be empty`);
  }

  const sanitized = url.trim();

  // Must use HTTPS protocol
  if (!sanitized.startsWith("https://")) {
    throw new Error(`${paramName} must use HTTPS protocol: ${sanitized}`);
  }

  // Parse URL to validate domain
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sanitized);
  } catch (e) {
    throw new Error(`${paramName} is not a valid URL: ${sanitized}`);
  }

  // Only allow trusted domains
  const trustedDomains = ["gitcode.com"];
  const hostname = parsedUrl.hostname.toLowerCase();
  if (!trustedDomains.includes(hostname)) {
    throw new Error(
      `${paramName} must be from trusted domain(s): ${trustedDomains.join(", ")}. ` + `Got: ${hostname}`
    );
  }

  // Validate path ends with .whl (wheel package)
  const pathname = parsedUrl.pathname.toLowerCase();
  if (!pathname.endsWith(".whl")) {
    throw new Error(`${paramName} must point to a .whl file (Python wheel package)`);
  }

  return sanitized;
}

/**
 * 主函数
 */
async function run(): Promise<void> {
  // 定义虚拟环境路径（使用进程ID避免并发冲突，使用系统临时目录提高可移植性）
  const venvPath = path.join(os.tmpdir(), `collect_venv_${process.pid}`);

  try {
    console.log("=".repeat(60));
    console.log("Starting pytest testcase collection...");
    console.log("=".repeat(60));

    // Step 1: 获取输入参数
    core.startGroup("Step 1: Get input parameters");
    const testcasePathRaw = core.getInput("testcase-path", { required: true });
    const metadataOutputPathRaw = core.getInput("metadata-output-path") || "metadata_test.xml";
    const pytestConfigFileRaw = core.getInput("pytest-config-file") || "";
    const testcasePath = validatePath(testcasePathRaw, "testcase-path");
    const outputPath = validateOutputPath(metadataOutputPathRaw);
    const pytestConfigFile = pytestConfigFileRaw
      ? validatePath(pytestConfigFileRaw, "pytest-config-file")
      : "";

    const testcaseCollectorUrlRaw =
      core.getInput("testcase-collector-url", { required: false }) ||
      "https://gitcode.com/openlibing/openlibing-pytest-executor/releases/download/pytest-testcase-collector-1.0.0/pytest_testcase_collector-1.0.0-py3-none-any.whl";
    const testcaseCollectorUrl = validateDownloadUrl(testcaseCollectorUrlRaw, "testcase-collector-url");
    let pythonCommand = "python3"; // 默认使用 python3

    console.log("Input parameters loaded:");
    console.log(`  - testcase-path: ${testcasePath}`);
    console.log(`  - metadata-output-path: ${outputPath}`);
    console.log(`  - pytest-config-file: ${pytestConfigFile || "(not specified)"}`);

    // 获取镜像源配置（可从环境变量覆盖）
    const pypiIndexUrl =
      process.env.PYPI_INDEX_URL || "https://mirrors.huaweicloud.com/repository/pypi/simple";

    core.endGroup();

    // Step 2: 检查用例目录
    core.startGroup("Step 2: Validate testcase path");
    if (!fs.existsSync(testcasePath)) {
      throw new Error(`用例目录不存在: ${testcasePath}`);
    }
    console.log(`Testcase path validated: ${testcasePath}`);
    core.endGroup();

    // Step 3: 创建虚拟环境
    core.startGroup("Step 3: Create virtual environment");
    console.log(`Creating virtual environment at: ${venvPath}`);

    let venvCreated = false;
    try {
      await exec.exec("python3", ["-m", "venv", venvPath]);
      venvCreated = true;
      console.log("Virtual environment created successfully");
    } catch (e) {
      const error = e as Error;
      console.log(`Failed to create virtual environment: ${error.message}`);
      console.log("Attempting to install python3-venv...");
    }

    if (!venvCreated) {
      // Detect package manager (apt-get for Debian/Ubuntu, dnf for RHEL/CentOS/Fedora)
      let packageManager = "apt-get";
      try {
        await exec.exec("which", ["dnf"], { silent: true });
        packageManager = "dnf";
        console.log("Detected dnf package manager");
      } catch (e) {
        console.log("Use default apt-get package manager");
      }

      // Install python3-venv using appropriate package manager
      try {
        if (packageManager === "dnf") {
          console.log("Installing python3-venv via dnf...");
          await exec.exec("sudo", ["dnf", "install", "-y", "python3-venv"]);
        } else {
          console.log("Updating package lists...");
          await exec.exec("sudo", ["apt-get", "update", "-qq"]);
          console.log("Installing python3-venv via apt-get...");
          await exec.exec("sudo", ["apt-get", "install", "-y", "python3-venv"]);
        }
        console.log("python3-venv installed successfully");
      } catch (e) {
        const error = e as Error;
        throw new Error(
          `Failed to install python3-venv: ${error.message}. ` +
            `Please ensure you have sudo privileges and the package manager is available.`
        );
      }

      // Retry creating virtual environment
      console.log("Retrying to create virtual environment...");
      try {
        await exec.exec("python3", ["-m", "venv", venvPath]);
        console.log("Virtual environment created successfully");
      } catch (e) {
        const error = e as Error;
        throw new Error(
          `Failed to create virtual environment after installing python3-venv: ${error.message}. ` +
            `Please check if python3-venv is properly installed and try again.`
        );
      }
    }

    // 切换到虚拟环境中的 Python
    const pipCommand = path.join(venvPath, "bin", "pip");
    pythonCommand = path.join(venvPath, "bin", "python");
    console.log(`Python path: ${pythonCommand}`);
    console.log(`Pip path: ${pipCommand}`);
    core.endGroup();

    // Step 4: 安装 pytest 和 pytest-testcase-collector
    core.startGroup("Step 4: Install pytest and pytest-testcase-collector");
    console.log("Installing pytest and pytest-testcase-collector...");
    await exec.exec(pipCommand, [
      "install",
      "pytest",
      testcaseCollectorUrl,
      "-i",
      pypiIndexUrl,
      "-q",
    ]);
    console.log("pytest and pytest-testcase-collector installed successfully");
    core.endGroup();

    // Step 5: 执行 pytest 收集
    core.startGroup("Step 5: Execute pytest collection");
    console.log(`Metadata will be output to: ${outputPath}`);

    // 检查配置文件（如果指定）
    if (pytestConfigFile) {
      if (!fs.existsSync(pytestConfigFile)) {
        throw new Error(`pytest 配置文件不存在: ${pytestConfigFile}`);
      }
      console.log(`Config file exists: ${pytestConfigFile}`);
    }

    console.log("Running pytest --collect-only...");
    const { success, error, stdout, stderr } = await runPytest(
      pythonCommand,
      testcasePath,
      pytestConfigFile,
      outputPath
    );

    // 输出调试信息
    console.log("pytest execution result:");
    console.log(`  - success: ${success}`);
    if (stdout) {
      console.log("  - stdout length:", stdout.length);
      console.log("  - stdout preview:", stdout.substring(0, 500));
    }
    if (stderr) {
      console.log("  - stderr length:", stderr.length);
      console.log("  - stderr content:", stderr);
    }
    if (error) {
      console.log("  - error:", error.message);
    }

    if (!success) {
      const errorMsg = [
        "pytest 执行失败:",
        `  Python命令: ${pythonCommand}`,
        `  用例路径: ${testcasePath}`,
        `  配置文件: ${pytestConfigFile || "(not specified)"}`,
        `  stderr: ${stderr || "(empty)"}`,
        `  stdout: ${stdout || "(empty)"}`,
        `  error: ${error ? error.message : "(none)"}`,
      ].join("\n");
      core.error(errorMsg);
      throw new Error("pytest 执行失败，请查看上述错误信息");
    }

    core.endGroup();

    // Step 6: 设置输出
    core.startGroup("Step 6: Set outputs");
    core.setOutput("metadata-output-path", outputPath);
    console.log("Execution outputs:");
    console.log(`  - metadata-output-path: ${outputPath}`);
    // Also write to $ATOMGIT_OUTPUT for GitCode compatibility
    const atomgitOutputPath = process.env.ATOMGIT_OUTPUT;
    if (atomgitOutputPath) {
      // Security: Sanitize output values to prevent CI output injection
      const sanitizedPath = sanitizeOutputValue(outputPath);
      const outputContent = `metadata-output-path=${sanitizedPath}\n`;
      fs.appendFileSync(atomgitOutputPath, outputContent);
    }
    core.endGroup();

    console.log("=".repeat(60));
    console.log("Testcase collection completed successfully");
    console.log("=".repeat(60));
  } catch (error) {
    const err = error as Error;
    core.error("=".repeat(60));
    core.error(`Testcase collection failed: ${err.message}`);
    core.error("=".repeat(60));
    if (err.stack) {
      core.error(`Stack trace:\n${err.stack}`);
    }
    core.setFailed(err.message);
  }
}

// 执行主函数
run();