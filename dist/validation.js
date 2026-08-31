"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRealPath = resolveRealPath;
exports.assertWithinWorkspace = assertWithinWorkspace;
exports.validatePath = validatePath;
exports.validateOutputPath = validateOutputPath;
exports.validateIndexUrl = validateIndexUrl;
exports.sha256File = sha256File;
exports.sanitizeOutputValue = sanitizeOutputValue;
/**
 * 纯校验工具：URL / 路径 / 哈希校验，供 index.ts 与单元测试复用。
 *
 * 安全相关：
 * - validateIndexUrl：供应链端点校验 (FIND-04/10)
 * - validatePath / resolveRealPath / assertWithinWorkspace / validateOutputPath：路径限制与符号链接解析 (FIND-08)
 * - sha256File：文件完整性哈希 (FIND-02/09)
 * - sanitizeOutputValue：CI 输出注入净化 (FIND-05)
 */
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
/**
 * 解析路径为绝对路径并跟随符号链接，获取真实路径。
 * 若目标尚不存在（如待写入的输出文件），则解析其父目录的 realpath。
 * 用于防止符号链接绕过路径限制 (FIND-08)。
 */
function resolveRealPath(inputPath) {
    const resolved = path.resolve(inputPath);
    try {
        return fs.realpathSync(resolved);
    }
    catch {
        // 路径不存在（输出文件待创建）：解析父目录的 realpath 后拼接文件名
        const parent = path.dirname(resolved);
        try {
            const realParent = fs.realpathSync(parent);
            return path.join(realParent, path.basename(resolved));
        }
        catch {
            return resolved;
        }
    }
}
/**
 * 校验路径解析后的真实路径位于工作区内，防止符号链接逃逸到敏感目录 (FIND-08)。
 */
function assertWithinWorkspace(realPath, paramName) {
    const workspace = path.resolve(process.cwd());
    const target = path.resolve(realPath);
    if (target !== workspace && !target.startsWith(workspace + path.sep)) {
        throw new Error(`${paramName} must be within the workspace (${workspace}); resolved to ${target}`);
    }
}
/**
 * 验证路径安全性，防止路径遍历攻击与符号链接绕过 (FIND-08)。
 */
function validatePath(inputPath, paramName) {
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
function validateOutputPath(outputPath) {
    const absolutePath = validatePath(outputPath, "metadata-output-path");
    const basename = path.basename(absolutePath);
    if (!basename.startsWith("metadata")) {
        throw new Error(`Output file name must start with 'metadata', got: ${basename}. ` +
            `Please ensure the file name begins with 'metadata' (e.g., metadata_test.xml, metadata_report.xml)`);
    }
    assertWithinWorkspace(absolutePath, "metadata-output-path");
    return absolutePath;
}
/**
 * Validate PyPI index URL for security (FIND-04).
 * Requires HTTPS and an allow-listed host to prevent malicious mirror redirection
 * combined with dependency-confusion during pip install.
 */
function validateIndexUrl(url, paramName) {
    if (!url || url.trim() === "") {
        throw new Error(`${paramName} cannot be empty`);
    }
    const sanitized = url.trim();
    if (!sanitized.startsWith("https://")) {
        throw new Error(`${paramName} must use HTTPS protocol: ${sanitized}`);
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(sanitized);
    }
    catch {
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
        throw new Error(`${paramName} host not allowed: ${hostname}. Allowed: ${allowedHosts.join(", ")}`);
    }
    return sanitized;
}
/**
 * 计算文件 SHA-256 (FIND-02 / FIND-09)。
 */
function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    const data = fs.readFileSync(filePath);
    hash.update(data);
    return hash.digest("hex");
}
/**
 * 净化输出值，防止 CI 输出注入 (FIND-05)。
 * 转义反斜杠、换行、回车、等号，避免破坏 ATOMGIT_OUTPUT 的 key=value 格式。
 */
function sanitizeOutputValue(value) {
    if (!value)
        return "";
    return value
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/=/g, "\\=");
}
