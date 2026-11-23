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
import {
  validatePath,
  validateOutputPath,
  validateIndexUrl,
  sanitizeOutputValue,
} from "./validation";

/**
 * 收集执行结果接口
 */
interface CollectResult {
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
  rootdir: string,
  metadataOutput: string
): Promise<CollectResult> {
  // 验证路径安全性并解析符号链接 (FIND-08)：复用 validatePath 消除重复的 .. 检查
  // 仅提供 pytest-config-file（由其 testpaths 决定收集范围）时 testcasePath 为空，跳过校验
  const safeTestcasePath = testcasePath
    ? validatePath(testcasePath, "testcase-path")
    : "";
  const safeRootdir = rootdir ? validatePath(rootdir, "rootdir") : "";
  const safeMetadataOutput = validatePath(metadataOutput, "metadata-output");

  let stdout = "";
  let stderr = "";

  const options: exec.ExecOptions = {
    cwd: safeTestcasePath || undefined, // 省略时用默认工作目录（仓库根），让 -c 配置文件的 testpaths 正确解析
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      },
      stderr: (data: Buffer) => {
        stderr += data.toString();
      },
    },
    silent: true,
    // 环境变量白名单：仅保留 pytest 收集必需项，最小化 conftest.py 可触达的能力 (FIND-01)
    // 不透传 PYTHONPATH/LD_LIBRARY_PATH（防搜索路径/共享库劫持）
    // 不透传 HOME/USER/SHELL/TERM/PWD/TZ/VIRTUAL_ENV/代理变量（核心收集不涉及）
    env: {
      PATH: `${path.dirname(pythonCommand)}:/usr/bin`, // 缩窄到 venv bin + 系统 bin
      LANG: process.env.LANG || "C.UTF-8", // 保证 UTF-8，避免 metadata XML 中文乱码
      LANGUAGE: process.env.LANGUAGE || "",
      PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || "1", // 实时 stdout，配合 listener 计数 (FIND-04)
    },
  };

  // 构建 pytest 参数
  const args: string[] = [
    "-m",
    "pytest",
    "--collect-only",
    "--tb=no",
    "-q",
    "-p",
    "no:cacheprovider", // 禁用 cache 插件，避免因缺少 HOME 而写 ~/.pytest_cache 失败 (FIND-01)
    "--metadata-output",
    safeMetadataOutput, // 使用验证后的路径
  ];
  // 显式 rootdir 优先；其次在指定 testcase-path 时以其为 rootdir；
  // 省略两者时让 pytest 按 -c 配置文件的自然 rootdir（ini 所在目录）解析 testpaths，
  // 避免 --rootdir 覆盖导致 testpaths 解析到不存在路径而回退全量收集
  if (safeRootdir) {
    args.push("--rootdir", safeRootdir);
  } else if (safeTestcasePath) {
    args.push("--rootdir", safeTestcasePath);
  }

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
    if (!safeTestcasePath) {
      throw new Error("必须指定 testcase-path 或 pytest-config-file 之一");
    }
    args.push(safeTestcasePath);
  }

  try {
    await exec.exec(pythonCommand, args, options);
    return { success: true, error: null, stdout, stderr };
  } catch (caughtError) {
    return { success: false, error: caughtError as Error, stdout, stderr };
  }
}

/**
 * 执行 unittest 收集用例
 *
 * 直接运行 action 仓库内置的 scripts/unittest_collector.py 独立脚本，
 * 不依赖 pytest_testcase_collector wheel 包。
 * 通过 unittest.TestLoader().discover() 发现测试用例并生成元数据 XML。
 */
async function runUnittestCollector(
  pythonCommand: string,
  testcasePath: string,
  metadataOutput: string
): Promise<CollectResult> {
  const safeTestcasePath = validatePath(testcasePath, "testcase-path");
  const safeMetadataOutput = validatePath(metadataOutput, "metadata-output");

  // 脚本路径：action 根目录下的 scripts/unittest_collector.py
  const scriptPath = path.join(__dirname, "..", "scripts", "unittest_collector.py");
  if (!fs.existsSync(scriptPath)) {
    return {
      success: false,
      error: new Error(`unittest collector script not found: ${scriptPath}`),
      stdout: "",
      stderr: "",
    };
  }

  let stdout = "";
  let stderr = "";

  const options: exec.ExecOptions = {
    cwd: safeTestcasePath || undefined,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString();
      },
      stderr: (data: Buffer) => {
        stderr += data.toString();
      },
    },
    silent: true,
    // 环境变量白名单：与 runPytest 保持一致，最小化子进程可触达能力 (FIND-01)
    // unittest_collector.py 需要 git 命令获取仓库信息，但内部已清理 GIT_ASKPASS/SSH_ASKPASS
    env: {
      PATH: `${path.dirname(pythonCommand)}:/usr/bin`,
      LANG: process.env.LANG || "C.UTF-8",
      LANGUAGE: process.env.LANGUAGE || "",
      PYTHONUNBUFFERED: process.env.PYTHONUNBUFFERED || "1",
    },
  };

  const args: string[] = [
    scriptPath,
    "--testcase-path",
    safeTestcasePath,
    "--metadata-output",
    safeMetadataOutput,
  ];

  try {
    await exec.exec(pythonCommand, args, options);
    return { success: true, error: null, stdout, stderr };
  } catch (caughtError) {
    return { success: false, error: caughtError as Error, stdout, stderr };
  }
}

/**
 * 主函数
 */
async function run(): Promise<void> {
  // 使用 mkdtempSync 创建随机临时 venv 目录，避免可预测路径被预创建/符号链接竞争 (FIND-03)
  const venvPath = fs.mkdtempSync(path.join(os.tmpdir(), "collect-venv-"));

  try {
    console.log("=".repeat(60));
    console.log("Starting testcase collection...");
    console.log("=".repeat(60));

    // Step 1: 获取输入参数
    core.startGroup("Step 1: Get input parameters");
    const frameworkRaw = core.getInput("framework") || "pytest";
    const framework = frameworkRaw.toLowerCase();
    if (framework !== "pytest" && framework !== "unittest") {
      throw new Error(
        `不支持的 framework 参数: ${frameworkRaw}，仅支持 pytest 或 unittest`
      );
    }
    const testcasePathRaw = core.getInput("testcase-path", { required: false });
    const metadataOutputPathRaw = core.getInput("metadata-output-path") || "metadata_test.xml";
    const pytestConfigFileRaw = core.getInput("pytest-config-file") || "";
    const rootdirRaw = core.getInput("rootdir", { required: false }) || "";
    const testcasePath = testcasePathRaw
      ? validatePath(testcasePathRaw, "testcase-path")
      : "";
    const outputPath = validateOutputPath(metadataOutputPathRaw);
    const pytestConfigFile = pytestConfigFileRaw
      ? validatePath(pytestConfigFileRaw, "pytest-config-file")
      : "";
    const rootdir = rootdirRaw ? validatePath(rootdirRaw, "rootdir") : "";

    let pythonCommand = "python3"; // 默认使用 python3

    console.log("Input parameters loaded:");
    console.log(`  - framework: ${framework}`);
    console.log(`  - testcase-path: ${testcasePath || "(not specified)"}`);
    console.log(`  - metadata-output-path: ${outputPath}`);
    console.log(`  - pytest-config-file: ${pytestConfigFile || "(not specified)"}`);
    console.log(`  - rootdir: ${rootdir || "(not specified)"}`);

    // 获取镜像源配置并校验协议/主机，防止被重定向到恶意镜像 (FIND-04)
    const pypiIndexUrlRaw =
      process.env.PYPI_INDEX_URL || "https://mirrors.huaweicloud.com/repository/pypi/simple";
    const pypiIndexUrl = validateIndexUrl(pypiIndexUrlRaw, "PYPI_INDEX_URL");

    core.endGroup();

    // Step 2: 检查用例目录（省略 testcase-path 时跳过，由 pytest-config-file 的 testpaths 决定收集范围）
    core.startGroup("Step 2: Validate testcase path");
    if (framework === "unittest") {
      // unittest 模式必须指定 testcase-path
      if (!testcasePath) {
        throw new Error("unittest 模式必须指定 testcase-path");
      }
      if (!fs.existsSync(testcasePath)) {
        throw new Error(`用例目录不存在: ${testcasePath}`);
      }
      console.log(`Testcase path validated: ${testcasePath}`);
    } else if (testcasePath) {
      if (!fs.existsSync(testcasePath)) {
        throw new Error(`用例目录不存在: ${testcasePath}`);
      }
      console.log(`Testcase path validated: ${testcasePath}`);
    } else {
      console.log("Testcase path not specified; collection scope driven by pytest-config-file testpaths");
    }
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

    // Step 4: 通过 pip 安装 pytest-testcase-collector（unittest 模式跳过，使用内置独立脚本）
    core.startGroup("Step 4: Install testcase-collector");
    if (framework === "unittest") {
      console.log("unittest mode: skip install, use built-in collector script");
    } else {
      console.log("Installing pytest and pytest-testcase-collector...");
      await exec.exec(pipCommand, [
        "install",
        "pytest",
        "pytest-testcase-collector",
        "-i",
        pypiIndexUrl,
        "-q",
      ]);
      console.log("testcase-collector installed successfully");
    }
    core.endGroup();

    // Step 5: 执行测试用例收集
    core.startGroup(`Step 5: Execute ${framework} collection`);
    console.log(`Metadata will be output to: ${outputPath}`);

    // 检查配置文件（pytest 模式如果指定）
    if (framework === "pytest" && pytestConfigFile) {
      if (!fs.existsSync(pytestConfigFile)) {
        throw new Error(`pytest 配置文件不存在: ${pytestConfigFile}`);
      }
      console.log(`Config file exists: ${pytestConfigFile}`);
    }

    let success: boolean;
    let collectError: Error | null;
    let stdout = "";
    let stderr = "";

    if (framework === "unittest") {
      console.log("Running unittest metadata collector...");
      const result = await runUnittestCollector(
        pythonCommand,
        testcasePath,
        outputPath
      );
      success = result.success;
      collectError = result.error;
      stdout = result.stdout;
      stderr = result.stderr;
    } else {
      console.log("Running pytest --collect-only...");
      const result = await runPytest(
        pythonCommand,
        testcasePath,
        pytestConfigFile,
        rootdir,
        outputPath
      );
      success = result.success;
      collectError = result.error;
      stdout = result.stdout;
      stderr = result.stderr;
    }

    // 仅输出长度，不输出内容/预览，避免泄露子进程输出 (FIND-07)
    console.log(`${framework} execution result:`);
    console.log(`  - success: ${success}`);
    if (stdout) {
      console.log("  - stdout length:", stdout.length);
    }
    if (stderr) {
      console.log("  - stderr length:", stderr.length);
    }
    if (collectError) {
      console.log("  - error:", collectError.message);
    }

    if (!success) {
      // 临时调试：失败时输出 stdout/stderr 全量，便于定位收集错误
      // （成功时仍只输出长度，保留 FIND-07；定位后还原此块）
      if (stdout) {
        console.log(`----- ${framework} stdout start -----`);
        console.log(stdout);
        console.log(`----- ${framework} stdout end -----`);
      }
      if (stderr) {
        console.log(`----- ${framework} stderr start -----`);
        console.log(stderr);
        console.log(`----- ${framework} stderr end -----`);
      }
      const errorMsg = `${framework} 执行失败: ${collectError ? collectError.message : "(unknown)"}`;
      core.error(errorMsg);
      throw new Error(`${framework} 执行失败，请查看上述错误信息`);
    }

    core.endGroup();

    // Step 6: 设置输出
    core.startGroup("Step 6: Set outputs");
    core.setOutput("metadata-output-path", outputPath);
    console.log("Execution outputs:");
    console.log(`  - metadata-output-path: ${outputPath}`);
    // 写入 $ATOMGIT_OUTPUT 以兼容 GitCode（参考 pytest-orch 实现，值经 sanitizeOutputValue 防注入）
    const atomgitOutputFile = process.env.ATOMGIT_OUTPUT;
    if (atomgitOutputFile) {
      const outputContent = `metadata-output-path=${sanitizeOutputValue(outputPath)}\n`;
      fs.appendFileSync(atomgitOutputFile, outputContent);
    }
    core.endGroup();

    console.log("=".repeat(60));
    console.log("Testcase collection completed successfully");
    console.log("=".repeat(60));
  } catch (caughtError) {
    const err = caughtError as Error;
    core.error("=".repeat(60));
    core.error(`Testcase collection failed: ${err.message}`);
    core.error("=".repeat(60));
    core.setFailed(err.message);
  } finally {
    // 清理临时 venv 目录 (FIND-03)
    try {
      fs.rmSync(venvPath, { recursive: true, force: true });
    } catch {
      // 忽略清理失败
    }
  }
}

// 执行主函数
run();
