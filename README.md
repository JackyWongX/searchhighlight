# SearchHighlight

[English](https://github.com/JackyWongX/searchhighlight/blob/master/README_EN.md)

SearchHighlight 是一个用于搜索代码中变量、函数等标识符的 VSCode 插件。它能够根据搜索结果所在行的上下文来判断该标识符是在进行读操作、写操作，还是函数调用，并以不同的颜色进行高亮显示。

![演示](https://raw.githubusercontent.com/JackyWongX/searchhighlight/master/images/show.gif)

## 功能特点

- 快速搜索工作区内的代码标识符。优先用语言服务器的符号数据库；符号库不可用或查不到时，自动改用 ripgrep 全文搜索
- 智能识别读写操作
- 函数调用用暗橙色高亮，和读、写区分开。名字后面紧跟着括号就算调用
- 可自定义的读、写、函数调用高亮颜色
- 丰富的写操作检测规则配置
- 实时显示搜索结果统计
- 支持按目录分组显示结果，并显示每处结果所在的函数/方法
- 支持快速跳转到代码位置
- 支持大小写敏感和全词匹配控制
- 搜索框右边的 ▼ 可以打开以前搜过的内容，最近搜的在最上面
- 支持过滤特定后缀的文件

## 使用方法

1. 在编辑器中选中要搜索的文本 (没有选中时使用光标所在的文本)
2. 使用快捷键 `Ctrl+Shift+F` (Windows) 或 `Cmd+Shift+F` (MacOS) 进行搜索
3. 在活动栏的 Search Highlight 视图中查看搜索结果
4. 可以通过右上角的按钮控制大小写敏感（Aa）和全词匹配（\\b）
5. 点搜索框最右边的 ▼，可以看到以前搜过的词，最近搜的在最上面。点其中一条，会用这个词再搜一次并显示结果
6. 点击搜索结果可跳转到对应的代码位置

## 插件设置

### 写操作检测规则

插件根据「匹配到的标识符之后、同一行内」的文本判断读写。写操作只算在真正被改掉的那个名字上，用来找到它的前缀不算写。命中下列任意一条即按写操作高亮：

| 写法 | 谁算写 | 示例 |
|------|--------|------|
| 赋值、自增运算符 | 运算符左边这个名字 | `x = 1`、`x += 1`、`x++`、`x := 1`、`ch <- v` |
| 下标、类型注解 | 仍是这个名字 | `x[0] = 1`、`x: int = 1` |
| 成员赋值 | 最后那个成员，前面的对象或指针算读 | `obj.field = 1` 写 `field`；`p->field = 1` 写 `field`，`p` 是读 |
| 多重赋值与解构 | 每个被赋值的名字 | `a, b = f()`、`let {a} = obj`、`let [a] = arr` |
| 前缀自增 | 真正被加减的那个名字 | `++x`、`--x`；`++p->field` 写 `field`，`p` 是读 |
| 循环变量、输出参数、别名 | 被绑定或写回的那个名字 | `for x in xs`、`for (x of xs)`、`for (auto x : xs)`、`out x`、`import a as b` |
| 会修改自身的成员方法 | 点或箭头紧前面的那个对象，而且必须是调用 | `xs.append(v)`、`xs.Add(v)`、`list.push_back(v)`、`p->insert(v)`。`obj.set = 1` 写的是 `set` |
| 会修改第一个实参的自由函数 | 第一个实参末尾的那个名字 | `append(xs, v)`、`memcpy(dst, src)`、`strcpy(p->date, src)` 写 `date` 不写 `p` |

其余情况一律按读操作高亮。字符串字面量、行注释和同一行里的块注释（`/* ... */`）中的同名文本不会被判成写操作。行注释按语言识别：C 系语言的 `//`、Python 等的 `#`、SQL / Lua / Haskell 的 `--`。`==`、`===`、`!=`、`=>` 等比较运算符也不会误判成赋值。

所以搜索 `pOrder` 时，`pOrder = &list[i]`、`++pOrder` 是写，`pOrder->status = Open`、`pOrder->days++`、`*pOrder = 1`、`if (pOrder != nullptr)` 都是读。`int *pOrder = 0` 这种声明仍然是写。同一行里 `pOrder->huicheprice = max(pOrder->huicheprice, high)` 的两个 `pOrder` 都是读，被改的是 `huicheprice`。

同一行里这个名字如果出现多次，结果列表仍只显示一条，但会标在被写的那一次上。例如 `if (x > 0) x = 1` 会把红色标在后面的 `x` 上。`*x = 1` 里 `x` 只是被拿去定位，不算写；`int *x = 1` 里的 `x` 是在声明并赋值，算写。

`list.append(item)` 这种成员调用只把点前面的 `list` 当成被修改的对象，括号里的 `item` 不会因为函数表里也有 `append` 而被判成写。`a.b.append(v)` 只把 `b` 当成写，`a` 是读。`p->insert(pos, value)`、`obj?.erase(it)` 同样只看紧挨着方法的那个对象。

下面几种写法和真正的赋值长得很像，插件只能按行内文本猜测，所以有边界：

- `case FOO:` 里的 `FOO` 不会判成写。
- `let x: int = 1`、`const x: int = 1`，以及 Python 的 `x: int = 1`，冒号后面的类型名（`int`）不会判成写。带生命周期的写法 `let x: &'a str = "hi"` 能认出 `x` 是写。
- 没有 `let` / `const` / `public` 这类声明前缀时，`label: x = 1` 里的 `label`，以及 `x: int = 1` 里的 `int`，仍可能被判成写。这是标签和类型注解在同一行里分不清导致的。

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
    "functions": ["append", "delete", "copy"]
  }
}
```

- `operators`：赋值运算符
- `methods`：会修改自身的成员方法名，大小写不敏感，并且支持 CamelCase 变体（配置 `set` 即可识别 `setValue`、`Set`）
- `functions`：会修改第一个实参的自由函数名。`append(xs, v)` 里写的是 `xs`；`strcpy(p->date, src)` 里写的是 `date`，不是 `p`。成员调用不走这条规则。`close(fd)` 不会把 `fd` 判成写，因为 `close` 并不修改这个变量；`gets` / `fgets` 会往缓冲区里写，所以仍然算写
- `excludeOperators`：不能当成赋值的运算符（`==`、`=>` 这类比较运算符始终会被排除）

修改配置后可以执行命令 `Reload Write Operation Patterns` 立即生效。

> 纯文本判断无法覆盖通过迭代器、引用间接修改的情况（例如 `std::sort(v.begin(), v.end())`），这类写法会按读操作高亮。

通过`searchhighlight.excludePatterns`配置不需要搜索的目录

### 函数调用

名字后面接着括号时，按函数调用用暗橙色高亮，例如 `foo()`、`name = foo(raw)`、`obj.foo()`、`p->foo()`、`foo<int>()`。不用先确认符号库里这个名字是不是函数。

下面这些仍按读、写上色，不会标成调用：

- 函数定义和声明，例如 `void foo()`、`function foo()`、`def foo():`、`foo() {`
- 只是提到这个名字、并没有调用，例如 `callback = foo`、`bar(foo)`

括号如果写在下一行，这一行上也认不出调用。

### 高亮颜色

- `searchhighlight.colors.read`: 读操作高亮颜色 (默认: "rgba(64, 200, 64, 0.5)")
- `searchhighlight.colors.write`: 写操作高亮颜色 (默认: "rgba(240, 64, 64, 0.5)")
- `searchhighlight.colors.call`: 函数调用高亮颜色 (默认: "rgba(184, 78, 0, 0.55)")，暗橙色

### 搜索配置

- `searchhighlight.caseSensitive`: 是否区分大小写（默认：true）
- `searchhighlight.matchWholeWord`: 是否全词匹配（默认：true）。编辑器里的高亮和 ripgrep 一样按 Unicode 分词，中文标识符也能完整匹配
- `searchhighlight.excludePatterns`: 要排除的目录列表
- `searchhighlight.respectGitIgnore`: 是否遵循 `.gitignore` 等忽略规则（默认：false，即搜索时忽略这些规则）
- `searchhighlight.ripgrepPath`: ripgrep 可执行文件的绝对路径（默认：留空）。留空时先找 VS Code 安装目录里的 ripgrep，找不到再找 Cursor、Trae 等常见编辑器，最后再找 PATH。这些地方都没有时，搜索会提示你填写这一项
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
- 打开「全词匹配」时，搜索会先问语言服务器的符号数据库。查到这个完整名字后，用它的引用作为搜索结果，并照常按读、写上色
- 下面几种情况会自动改用 ripgrep 扫描文件：没有符号数据库、查询超时、符号库里没有这个名字、没有拿到引用，或同名符号太多（超过 30 个）
- 关掉「全词匹配」时直接使用 ripgrep。符号库只认识完整名字，不能按任意一段文字搜索
- 符号库给出的是语言服务器认定的同一个符号。别处同名、但互不相干的局部变量，可能不会出现在这批结果里
- 只有改用 ripgrep 时才需要 rg 程序。符号数据库能回答时，没有 rg 也可以搜索
- ripgrep 优先使用 VS Code 安装目录里的 rg，在大型项目中也能快速处理
- 安装目录里没有 rg 时，会继续到 Cursor、Trae、Trae CN、Windsurf、VSCodium 等基于 VS Code 的编辑器安装目录，以及系统 PATH 里查找
- 这些地方都找不到时，会弹出提示，让你设置 `searchhighlight.ripgrepPath`（rg 程序的完整路径）
- 若已经找到 rg 但全文搜索仍然很慢，可以检查排除目录配置，或把 rg 加到系统 PATH 后重试
- 用快捷键搜索时，结果页会先打开。页面准备好后结果会自动出现，不用再搜一次。如果全文搜索本身失败，右下角会弹出失败原因

## 贡献

欢迎提交 [issue 和新的功能需求](https://github.com/JackyWongX/searchhighlight/issues) 来帮助改进这个插件。

## 许可证

[MIT](LICENSE)
