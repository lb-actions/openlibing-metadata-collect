/**
 * 纯校验工具：URL / 路径 / 哈希校验，供 index.ts 与单元测试复用。
 *
 * 安全相关：
 * - validateIndexUrl：供应链端点校验 (FIND-04/10)
 * - validatePath / resolveRealPath / assertWithinWorkspace / validateOutputPath：路径限制与符号链接解析 (FIND-08)
 * - sha256File：文件完整性哈希 (FIND-02/09)
 * - sanitizeOutputValue：CI 输出注入净化 (FIND-05)
 */
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

/**
 * 解析路径为绝对路径并跟随符号链接，获取真实路径。
 * 若目标尚不存在（如待写入的输出文件），则解析其父目录的 realpath。
 * 用于防止符号链接绕过路径限制 (FIND-08)。
 */
export function resolveRealPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // 路径不存在（输出文件待创建）：解析父目录的 realpath 后拼接文件名
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      return path.join(realParent, path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

/**
 * 校验路径解析后的真实路径位于工作区内，防止符号链接逃逸到敏感目录 (FIND-08)。
 */
export function assertWithinWorkspace(realPath: string, paramName: string): void {
  const workspace = path.resolve(process.cwd());
  const target = path.resolve(realPath);
  if (target !== workspace && !target.startsWith(workspace + path.sep)) {
    throw new Error(
      `${paramName} must be within the workspace (${workspace}); resolved to ${target}`
    );
  }
}

/**
 * 验证路径安全性，防止路径遍历攻击与符号链接绕过 (FIND-08)。
 */
export function validatePath(inputPath: string, paramName: string): string {
  if (!inputPath || inputPath.trim() === "") {
    throw new Error(`${paramName} cannot be empty`);
  }

  if (path.normalize(inputPath).includes("..")) {
    throw new Error(`${paramName} contains path traversal characters: ${inputPath}`);
  }

  return resolveRealPath(inputPath);
}

/**
 * 验证输出路径的文件名必须以 metadata 开头，且位于工作区内 (FIND-08)。
 */
export function validateOutputPath(outputPath: string): string {
  const absolutePath = validatePath(outputPath, "metadata-output-path");

  const basename = path.basename(absolutePath);
  if (!basename.startsWith("metadata")) {
    throw new Error(
      `Output file name must start with 'metadata', got: ${basename}. ` +
        `Please ensure the file name begins with 'metadata' (e.g., metadata_test.xml, metadata_report.xml)`
    );
  }

  assertWithinWorkspace(absolutePath, "metadata-output-path");

  return absolutePath;
}

/**
 * Validate PyPI index URL for security (FIND-04).
 * Requires HTTPS and an allow-listed host to prevent malicious mirror redirection
 * combined with dependency-confusion during pip install.
 */
export function validateIndexUrl(url: string, paramName: string): string {
  if (!url || url.trim() === "") {
    throw new Error(`${paramName} cannot be empty`);
  }

  const sanitized = url.trim();

  if (!sanitized.startsWith("https://")) {
    throw new Error(`${paramName} must use HTTPS protocol: ${sanitized}`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sanitized);
  } catch {
    throw new Error(`${paramName} is not a valid URL: ${sanitized}`);
  }

  const allowedHosts = [
    "pypi.org",
    "files.pythonhosted.org",
    "mirrors.huaweicloud.com",
    "mirrors.aliyun.com",
    "pypi.tuna.tsinghua.edu.cn",
    "mirrors.cloud.tencent.com",
    "mirrors.163.com",
  ];
  const hostname = parsedUrl.hostname.toLowerCase();
  if (!allowedHosts.includes(hostname)) {
    throw new Error(
      `${paramName} host not allowed: ${hostname}. Allowed: ${allowedHosts.join(", ")}`
    );
  }

  return sanitized;
}

/**
 * 计算文件 SHA-256 (FIND-02 / FIND-09)。
 */
export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

/**
 * 净化输出值，防止 CI 输出注入 (FIND-05)。
 * 转义反斜杠、换行、回车、等号，避免破坏 ATOMGIT_OUTPUT 的 key=value 格式。
 */
export function sanitizeOutputValue(value: string): string {
  if (!value) return "";
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/=/g, "\\=");
}
