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
  rootdir: string,
  metadataOutput: string
): Promise<PytestResult> {
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
 * 通过 curl 下载文件到本地，自动跟随重定向并重试 (FIND-02)。
 * curl -L 自动跟随 GitCode release 的 302 CDN 重定向，--retry 容错瞬时网络错误。
 */
async function downloadToFile(url: string, dest: string): Promise<void> {
  await exec.exec("curl", [
    "-fsSL", // -f HTTP 错误返回非零, -s 静默进度, -S 显示错误, -L 跟随重定向
    "--retry",
    "3", // 瞬时错误重试 3 次
    "-o",
    dest,
    url,
  ]);
  // 临时文件权限加固，限制其他用户读取
  fs.chmodSync(dest, 0o600);
}

/**
 * 下载 wheel 到随机临时目录并返回本地路径 (FIND-03)。
 * 保留 URL 中的原始 wheel 文件名，使 pip 能按 PEP 427 解析元数据，
 * 否则报 "not a valid wheel filename"。
 */
async function downloadAndVerifyWheel(url: string): Promise<string> {
  // 随机临时目录避免可预测路径被预创建/符号链接竞争 (FIND-03)；
  // 保留 URL 中的原始 wheel 文件名，使 pip 能按 PEP 427 解析元数据，否则报 "not a valid wheel filename"
  const wheelDir = fs.mkdtempSync(path.join(os.tmpdir(), "collect-wheel-"));
  const wheelPath = path.join(wheelDir, path.basename(url));
  core.info(`Downloading wheel from ${url}...`);
  await downloadToFile(url, wheelPath);
  return wheelPath;
}

/**
 * 主函数
 */
async function run(): Promise<void> {
  // 使用 mkdtempSync 创建随机临时 venv 目录，避免可预测路径被预创建/符号链接竞争 (FIND-03)
  const venvPath = fs.mkdtempSync(path.join(os.tmpdir(), "collect-venv-"));

  try {
    console.log("=".repeat(60));
    console.log("Starting pytest testcase collection...");
    console.log("=".repeat(60));

    // Step 1: 获取输入参数
    core.startGroup("Step 1: Get input parameters");
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

    // 硬编码 wheel 下载地址
    const testcaseCollectorUrl =
      "https://gitcode.com/openlibing/openlibing-pytest-executor/releases/download/pytest-testcase-collector-1.0.0/pytest_testcase_collector-1.0.0-py3-none-any.whl";
    let pythonCommand = "python3"; // 默认使用 python3

    console.log("Input parameters loaded:");
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
    if (testcasePath) {
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

    // Step 4: 下载 wheel 后本地安装
    core.startGroup("Step 4: Download and install pytest-testcase-collector");
    const verifiedWheelPath = await downloadAndVerifyWheel(testcaseCollectorUrl);
    try {
      console.log("Installing pytest and verified pytest-testcase-collector...");
      await exec.exec(pipCommand, [
        "install",
        "pytest",
        verifiedWheelPath,
        "-i",
        pypiIndexUrl,
        "-q",
      ]);
      console.log("pytest-testcase-collector installed successfully");
    } finally {
      // 清理整个临时 wheel 目录（含原始文件名的 wheel）
      fs.rmSync(path.dirname(verifiedWheelPath), { recursive: true, force: true });
    }
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
    // Note: destructure as pytestError to avoid shadowing the core.error() call below.
    const { success, error: pytestError, stdout, stderr } = await runPytest(
      pythonCommand,
      testcasePath,
      pytestConfigFile,
      rootdir,
      outputPath
    );

    // 仅输出长度，不输出内容/预览，避免泄露子进程输出 (FIND-07)
    console.log("pytest execution result:");
    console.log(`  - success: ${success}`);
    if (stdout) {
      console.log("  - stdout length:", stdout.length);
    }
    if (stderr) {
      console.log("  - stderr length:", stderr.length);
    }
    if (pytestError) {
      console.log("  - error:", pytestError.message);
    }

    if (!success) {
      // 临时调试：失败时输出 stdout/stderr 全量，便于定位 pytest 收集错误
      // （成功时仍只输出长度，保留 FIND-07；定位后还原此块）
      if (stdout) {
        console.log("----- pytest stdout start -----");
        console.log(stdout);
        console.log("----- pytest stdout end -----");
      }
      if (stderr) {
        console.log("----- pytest stderr start -----");
        console.log(stderr);
        console.log("----- pytest stderr end -----");
      }
      const errorMsg = `pytest 执行失败: ${pytestError ? pytestError.message : "(unknown)"}`;
      core.error(errorMsg);
      throw new Error("pytest 执行失败，请查看上述错误信息");
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
