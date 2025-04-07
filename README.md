# SearchHighlight

[English](README_EN.md)

SearchHighlight 是一个用于搜索代码中变量、函数等标识符的 VSCode 插件。它能够根据搜索结果所在行的上下文来判断该标识符是在进行读操作还是写操作，并以不同的颜色进行高亮显示。

## 功能特点

- 快速搜索工作区内的代码标识符
- 智能识别读写操作
- 可自定义的读写操作高亮颜色
- 丰富的写操作检测规则配置
- 实时显示搜索结果统计
- 支持文件分组显示
- 支持快速跳转到代码位置

## 使用方法

1. 在编辑器中选中要搜索的文本
2. 使用快捷键 `Ctrl+Shift+F` (Windows) 或 `Cmd+Shift+F` (MacOS) 进行搜索
3. 在活动栏的 Search Highlight 视图中查看搜索结果
4. 点击搜索结果可跳转到对应的代码位置

## 插件设置

### 写操作检测规则

可以通过 `searchhighlight.patterns` 配置写操作的检测规则：

```json
{
  "common": {
    "operators": ["=", "+=", "-=", "*=", "/=", "%=", "++", "--"],
    "methods": [".append", ".add", ".insert", ".remove", ".delete", ".clear"],
    "excludeOperators": ["==", "===", "!=", "!==", ">=", "<=", ">", "<"]
  }
}
```

### 高亮颜色

- `searchhighlight.colors.read`: 读操作高亮颜色 (默认: "rgba(64, 200, 64, 0.5)")
- `searchhighlight.colors.write`: 写操作高亮颜色 (默认: "rgba(240, 64, 64, 0.5)")

## 快捷键

| 功能 | Windows | MacOS |
|------|---------|--------|
| 搜索选中文本 | Ctrl+Shift+F | Cmd+Shift+F |

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

## 贡献

欢迎提交 issue 和 pull request 来帮助改进这个插件。

## 许可证

[MIT](LICENSE)
