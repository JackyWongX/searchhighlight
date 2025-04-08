# SearchHighlight

[English](https://raw.githubusercontent.com/JackyWongX/searchhighlight/blob/master/README_EN.md)

SearchHighlight 是一个用于搜索代码中变量、函数等标识符的 VSCode 插件。它能够根据搜索结果所在行的上下文来判断该标识符是在进行读操作还是写操作，并以不同的颜色进行高亮显示。

![演示](https://raw.githubusercontent.com/JackyWongX/searchhighlight/master/images/show.gif)

## 功能特点

- 快速搜索工作区内的代码标识符
- 智能识别读写操作
- 可自定义的读写操作高亮颜色
- 丰富的写操作检测规则配置
- 实时显示搜索结果统计
- 支持文件分组显示
- 支持快速跳转到代码位置

## 版本历史
- 1.0.0 初始版本 搜索字符串并根据字符的读写属性显示不同的颜色
- 1.0.1 使用rg.exe提高大型项目中的搜索速度
- 1.0.2 修复bug和优化显示效果
- 1.0.3 跳转后高亮显示搜索的文本

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

通过`searchhighlight.excludePatterns`配置不需要搜索的目录

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

## 注意
- 本插件使用vscode自带的rg.exe来快速搜索文件，在大型项目中也能快速处理
- 若搜索较慢请检查rg.exe的路径或者手动添加到系统path中后重试

## 未来开发计划
- 增加搜索选项支持 (忽略大小写 全词匹配)
- 增加过滤指定后缀文件 .pb.h .pb.cc

## 贡献

欢迎提交 [issue 和新的功能需求](https://github.com/JackyWongX/searchhighlight/issues) 来帮助改进这个插件。

## 许可证

[MIT](LICENSE)
