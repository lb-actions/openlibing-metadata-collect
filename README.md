# openlibing-metadata-collect

<!-- 简短的一句话介绍该 Action 的核心功能 -->

一个用于在测试流水线中收集 pytest/unittest 测试用例元数据并生成 XML 报告的 Actions 插件。

<!-- 放置 Marketplace / CI 专属的 Badges -->

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://img.shields.io/badge/CI-passing-green.svg)]()

---

## 核心特性 (Features)

- **双框架支持**：同时支持 `pytest` 和 `unittest` 两种测试框架的用例元数据收集，通过 `framework` 参数切换。
- **unittest 零外部依赖**：unittest 模式使用内置脚本 `scripts/unittest_collector.py`，通过 `unittest.TestLoader().discover()` 发现用例，不依赖外部 pip 包。
- **安全加固**：路径穿越校验、符号链接解析、环境变量白名单、子进程输出不泄露。
- **输出标准化**：生成与 pytest 收集器相同 schema 的 `metadata` XML，含用例名、类名、源码路径及 git 仓库信息，供下游编排和上传插件消费。
- **运行时**：`node20`。当前仅在 GitHub Actions 平台验证可用，GitCode 平台待 Node 运行时版本切换后再同步适配。

## 快速上手 (Quick Start)

在你的项目的 `.github/workflows/` 目录下创建一个 `.yml` 文件，并添加以下配置：

```yaml
name: Collect Metadata

on:
  push:
    branches: [main]
  pull_request:

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      # Step 1: 必须先拉取代码仓库
      - name: Checkout code
        uses: actions/checkout@v4

      # Step 2: 收集 unittest 用例元数据
      - name: Collect unittest metadata
        uses: openlibing/metadata-collect@v1
        with:
          framework: unittest
          testcase-path: tests/
          metadata-output-path: metadata_test.xml
```

## 输入参数 (Inputs)

| 参数名称 | 是否必填 | 默认值 | 描述说明 |
| :--- | :---: | :--- | :--- |
| `framework` | 否 | `pytest` | 测试框架类型，支持 `pytest` 或 `unittest` |
| `testcase-path` | unittest 模式 **是** / pytest 模式否 | `''` | 测试用例目录路径。pytest 模式指定 `pytest-config-file` 时可省略 |
| `metadata-output-path` | 否 | `metadata_test.xml` | XML 输出路径，文件名必须以 `metadata` 开头。并发场景请指定不同路径避免覆盖 |
| `pytest-config-file` | 否 | 无 | pytest 配置文件路径（如 `pytest.ini`），**仅 pytest 模式生效**，unittest 模式忽略 |
| `rootdir` | 否 | `''` | pytest rootdir 覆盖路径，**仅 pytest 模式生效**，unittest 模式忽略 |

> **注意**：unittest 模式下只有 `testcase-path` 和 `metadata-output-path` 生效，`pytest-config-file` 和 `rootdir` 会被忽略。

## 输出参数 (Outputs)

| 输出名称 | 类型 | 描述说明 |
| :--- | :--- | :--- |
| `metadata-output-path` | `string` | 生成的 XML 文件绝对路径 |

### 如何使用输出参数示例

```yaml
- name: Collect metadata
  id: collect
  uses: openlibing/metadata-collect@v1
  with:
    framework: unittest
    testcase-path: tests/

- name: Print output path
  run: echo "Metadata written to ${{ steps.collect.outputs.metadata-output-path }}"
```

## 使用约束

- **路径安全**：`testcase-path` 和 `metadata-output-path` 拒绝 `..` 路径穿越，符号链接会被 realpath 解析并校验是否在工作区内。
- **输出文件名**：`metadata-output-path` 的文件名必须以 `metadata` 开头，否则报错。
- **环境变量白名单**：子进程仅保留 `PATH`、`LANG`、`LANGUAGE`、`PYTHONUNBUFFERED`，阻断 `PYTHONPATH`/`HOME`/代理变量。
- **PYPI_INDEX_URL**：pytest 模式安装依赖时使用的镜像源，默认华为云镜像，仅允许 HTTPS 协议且 host 在白名单内。

## level/type 支持情况

不同框架对 `level` 和 `type` 字段的支持不同：

- **pytest**：通过 `pytest-testcase-collector` 收集，支持从 pytest marker 中提取 level/type。
- **unittest**：不支持 level/type，XML 中这两个字段为空值。

## 输出 XML 格式

### pytest 模式

```xml
<?xml version='1.0' encoding='utf-8'?>
<metadata>
  <frameType>pytest</frameType>
  <repoUrl>github.com/org/repo</repoUrl>
  <repoBranch>main</repoBranch>
  <testCases>
    <testCase>
      <name>test_login_success</name>
      <level>P0</level>
      <type>functional</type>
      <className>TestLogin</className>
      <filePath>tests/test_login.py</filePath>
    </testCase>
  </testCases>
</metadata>
```

### unittest 模式

```xml
<?xml version='1.0' encoding='utf-8'?>
<metadata>
  <frameType>unittest</frameType>
  <repoUrl>github.com/org/repo</repoUrl>
  <repoBranch>main</repoBranch>
  <testCases>
    <testCase>
      <name>test_login_success</name>
      <level></level>
      <type></type>
      <className>TestLogin</className>
      <filePath>tests/test_login.py</filePath>
    </testCase>
  </testCases>
</metadata>
```

## 贡献与本地调试 (Contributing & Debugging)

如果你想本地修改或调试这个 Action：

1. 克隆仓库并安装依赖：`npm install`
2. 打包生成分发文件：`npm run build`（`tsc` + `ncc` 打包到 `dist/index.js`）
3. 类型检查：`npx tsc --noEmit`
4. 提交 PR 前请确保通过本地类型检查。

## 开源协议 (License)

[MIT](LICENSE) © openlibing
