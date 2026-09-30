# SearchHighlight

[English](https://github.com/JackyWongX/searchhighlight/blob/master/README_EN.md)

SearchHighlight 是一个用于搜索代码中变量、函数等标识符的 VSCode 插件。它能够根据搜索结果所在行的上下文来判断该标识符是在进行读操作还是写操作，并以不同的颜色进行高亮显示。

![演示](https://raw.githubusercontent.com/JackyWongX/searchhighlight/master/images/show.gif)

## 功能特点

- 快速搜索工作区内的代码标识符
- 智能识别读写操作
- 可自定义的读写操作高亮颜色
- 丰富的写操作检测规则配置
- 实时显示搜索结果统计
- 支持按目录分组显示结果，并显示每处结果所在的函数/方法
- 支持快速跳转到代码位置
- 支持大小写敏感和全词匹配控制
- 支持过滤特定后缀的文件

## 使用方法

1. 在编辑器中选中要搜索的文本 (没有选中时使用光标所在的文本)
2. 使用快捷键 `Ctrl+Shift+F` (Windows) 或 `Cmd+Shift+F` (MacOS) 进行搜索
3. 在活动栏的 Search Highlight 视图中查看搜索结果
4. 可以通过右上角的按钮控制大小写敏感（Aa）和全词匹配（\\b）
5. 点击搜索结果可跳转到对应的代码位置

## 插件设置

### 写操作检测规则

插件根据「匹配到的标识符之后、同一行内」的文本判断读写，命中下列任意一条即按写操作高亮：

| 写法 | 示例 |
|------|------|
| 赋值、自增运算符 | `x = 1`、`x += 1`、`x++`、`x := 1`、`ch <- v` |
| 带下标、成员、类型注解的赋值 | `x[0] = 1`、`obj.field = 1`、`p->field = 1`、`x: int = 1` |
| 多重赋值与解构 | `a, b = f()`、`let {a} = obj`、`let [a] = arr` |
| 会修改自身的成员方法 | `xs.append(v)`、`xs.Add(v)`、`list.push_back(v)`、`obj.setValue(v)` |
| 会修改第一个实参的函数 | `append(xs, v)`、`memcpy(dst, src)` |

其余情况一律按读操作高亮。字符串字面量和注释里的同名文本不会被判成写操作，`==`、`===`、`!=`、`=>` 等比较运算符也不会误判成赋值。

规则可以通过 `searchhighlight.patterns` 配置，支持按语言分成多个分组（例如 `common`、`go`、`python`），检测时会把所有分组的内容合并使用：

```json
{
  "common": {
    "operators": ["=", "+=", "-=", "??=", "||=", "<<=", "**=", "//=", ":=", "<-", "++", "--"],
    "methods": ["append", "add", "insert", "remove", "clear", "set", "push", "push_back", "update", "sort"],
    "functions": ["append", "memcpy", "strcpy", "snprintf"]
  },
  "go": {
    "operators": [":=", "<-"],
    "functions": ["append", "delete", "close", "copy"]
  }
}
```

- `operators`：赋值运算符
- `methods`：会修改自身的成员方法名，大小写不敏感，并且支持 CamelCase 变体（配置 `set` 即可识别 `setValue`、`Set`）
- `functions`：会修改第一个实参的函数名，例如 `append(xs, v)` 里的 `xs`
- `excludeOperators`：不能当成赋值的运算符（`==`、`=>` 这类比较运算符始终会被排除）

修改配置后可以执行命令 `Reload Write Operation Patterns` 立即生效。

> 纯文本判断无法覆盖通过迭代器、引用间接修改的情况（例如 `std::sort(v.begin(), v.end())`），这类写法会按读操作高亮。

通过`searchhighlight.excludePatterns`配置不需要搜索的目录

### 高亮颜色

- `searchhighlight.colors.read`: 读操作高亮颜色 (默认: "rgba(64, 200, 64, 0.5)")
- `searchhighlight.colors.write`: 写操作高亮颜色 (默认: "rgba(240, 64, 64, 0.5)")

### 搜索配置

- `searchhighlight.caseSensitive`: 是否区分大小写（默认：true）
- `searchhighlight.matchWholeWord`: 是否全词匹配（默认：true）
- `searchhighlight.excludePatterns`: 要排除的目录列表
- `searchhighlight.respectGitIgnore`: 是否遵循 `.gitignore` 等忽略规则（默认：false，即搜索时忽略这些规则）
- `searchhighlight.debug`: 是否在输出面板打印调试日志（默认：false）
- `searchhighlight.excludeFileExtensions`: 要排除的文件后缀列表，默认包含：
  - 自动生成的代码文件（.pb.h, .pb.cc, .generated.h, .generated.cpp 等）
  - 压缩和映射文件（.min.js, .min.css, .map）
  - 编译产物和中间文件（.pyc, .dll, .exe, .obj 等）

## 快捷键

| 功能 | Windows | MacOS |
|------|---------|--------|
| 搜索选中文本 | Ctrl+Shift+F | Cmd+Shift+F |

> 注意：该快捷键会覆盖 VS Code 自带的「在文件中查找」。如需保留内置的全局搜索，可以在「键盘快捷方式」里修改 `Search and Highlight Selected Text` 的绑定。

## 支持的文件类型

- JavaScript (.js, .jsx)
- TypeScript (.ts, .tsx)
- Python (.py)
- Java (.java)
- C/C++ (.c, .cpp, .h, .hpp)
- Vue (.vue)
- Go (.go)
- Rust (.rs)
- PHP (.php)

## 注意
- 本插件使用vscode自带的rg.exe来快速搜索文件，在大型项目中也能快速处理
- 若搜索较慢请检查rg.exe的路径或者手动添加到系统path中后重试

## 贡献

欢迎提交 [issue 和新的功能需求](https://github.com/JackyWongX/searchhighlight/issues) 来帮助改进这个插件。

## 许可证

[MIT](LICENSE)
