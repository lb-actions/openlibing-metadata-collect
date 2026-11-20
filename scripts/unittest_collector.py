#!/usr/bin/env python3
"""
unittest 测试用例元数据收集器（独立脚本）

不依赖 pytest_testcase_collector 包，自包含 git 信息采集与 XML 生成逻辑。
与 pytest 收集器输出相同格式的 metadata XML，frameType 为 unittest。

用法：
    python unittest_collector.py \
        --testcase-path tests/unit-test \
        --metadata-output metadata.xml \
        [--pattern test_*.py]
"""
import argparse
import inspect
import os
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET


def _run_git(args, cwd=None):
    """执行 git 命令，返回 stdout 字符串，失败返回空字符串。"""
    env = dict(os.environ)
    env.pop("GIT_ASKPASS", None)
    env.pop("SSH_ASKPASS", None)
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.SubprocessError, OSError):
        pass
    return ""


def get_git_info():
    """获取 git 仓库 URL 和分支。"""
    repo_url = _run_git(["remote", "get-url", "origin"])
    repo_branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"])

    # 去除 URL 中可能包含的凭证信息
    if repo_url and "@" in repo_url:
        # git@host:owner/repo.git → host:owner/repo.git
        if repo_url.startswith("git@"):
            repo_url = repo_url.split("@", 1)[1]
        # https://user:pass@host/... → https://host/...
        elif "://" in repo_url:
            from urllib.parse import urlparse, urlunparse
            parsed = urlparse(repo_url)
            repo_url = urlunparse((
                parsed.scheme, parsed.hostname or "", parsed.path,
                "", "", "",
            ))

    if repo_url.endswith(".git"):
        repo_url = repo_url[:-4]

    return {"repoUrl": repo_url, "repoBranch": repo_branch}


def get_git_root_from_path(file_path):
    """从给定路径向上查找 git 仓库根目录。"""
    current = os.path.abspath(file_path)
    if os.path.isfile(current):
        current = os.path.dirname(current)

    while current != os.path.dirname(current):
        if os.path.isdir(os.path.join(current, ".git")):
            return current
        current = os.path.dirname(current)

    # fallback: git rev-parse
    root = _run_git(["rev-parse", "--show-toplevel"], cwd=file_path)
    return root or None


def _extract_test_cases(suite, test_cases, git_root):
    """递归遍历 TestSuite，提取每个 TestCase 的元数据。"""
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            _extract_test_cases(test, test_cases, git_root)
            continue

        if not isinstance(test, unittest.TestCase):
            continue

        test_class = test.__class__
        test_method_name = test._testMethodName

        try:
            file_path = inspect.getsourcefile(test_class)
        except (TypeError, OSError):
            file_path = ""

        if file_path and git_root:
            try:
                file_path = os.path.relpath(file_path, git_root)
            except ValueError:
                pass

        test_cases.append({
            "name": test_method_name,
            "level": "",
            "type": "",
            "className": test_class.__name__,
            "filePath": file_path or "",
        })


def collect_unittest_metadata(testcase_path, pattern="test*.py"):
    """收集 unittest 测试用例元数据。"""
    testcase_path = os.path.abspath(testcase_path)
    git_root = get_git_root_from_path(testcase_path)

    loader = unittest.TestLoader()
    suite = loader.discover(testcase_path, pattern=pattern)

    test_cases = []
    _extract_test_cases(suite, test_cases, git_root)
    return test_cases


def generate_xml(test_cases, git_info, output_file):
    """生成元数据 XML 文件。"""
    metadata = ET.Element("metadata")

    ET.SubElement(metadata, "frameType").text = "unittest"
    ET.SubElement(metadata, "repoUrl").text = git_info.get("repoUrl", "")
    ET.SubElement(metadata, "repoBranch").text = git_info.get("repoBranch", "")

    test_cases_elem = ET.SubElement(metadata, "testCases")
    for tc in test_cases:
        case_elem = ET.SubElement(test_cases_elem, "testCase")
        ET.SubElement(case_elem, "name").text = tc["name"]
        ET.SubElement(case_elem, "level").text = tc["level"]
        ET.SubElement(case_elem, "type").text = tc["type"]
        ET.SubElement(case_elem, "className").text = tc["className"]
        ET.SubElement(case_elem, "filePath").text = tc["filePath"]

    tree = ET.ElementTree(metadata)
    try:
        ET.indent(tree, space="    ", level=0)
    except AttributeError:
        pass  # Python < 3.9

    output_dir = os.path.dirname(output_file)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    tree.write(output_file, encoding="utf-8", xml_declaration=True)


def main():
    parser = argparse.ArgumentParser(
        description="收集 unittest 测试用例元数据并生成 XML 报告"
    )
    parser.add_argument("--testcase-path", required=True, help="测试用例目录路径")
    parser.add_argument(
        "--metadata-output", default="metadata.xml",
        help="元数据 XML 输出路径（默认 metadata.xml）",
    )
    parser.add_argument(
        "--pattern", default="test*.py",
        help="测试文件匹配模式（默认 test*.py）",
    )

    args = parser.parse_args()

    if not os.path.exists(args.testcase_path):
        print(
            f"Error: testcase path not found: {args.testcase_path}",
            file=sys.stderr,
        )
        sys.exit(1)

    test_cases = collect_unittest_metadata(
        args.testcase_path, pattern=args.pattern
    )
    print(f"Collected {len(test_cases)} unittest test cases")

    git_info = get_git_info()

    generate_xml(test_cases, git_info, args.metadata_output)
    print(f"Metadata XML written to: {args.metadata_output}")


if __name__ == "__main__":
    main()
