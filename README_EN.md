# SearchHighlight

[中文](README.md)

SearchHighlight is a VSCode extension for searching code identifiers such as variables and functions. It analyzes the context of search results to determine whether the identifier is being read or written, and highlights them in different colors.

## Features

- Quick search for code identifiers in workspace
- Smart detection of read/write operations
- Customizable highlighting colors
- Rich configuration for write operation detection
- Real-time search result statistics
- Directory-grouped display with the enclosing function/method of each result
- Quick navigation to code location
- Case sensitivity and whole word match control
- File extension filtering support

## Usage

1. Select the text you want to search in the editor
2. Use shortcut `Ctrl+Shift+F` (Windows) or `Cmd+Shift+F` (MacOS) to search
3. View results in the Search Highlight view in the activity bar
4. Use the buttons in the top-right corner to control case sensitivity (Aa) and whole word match (\\b)
5. Click on results to jump to the corresponding code location

## Extension Settings

### Write Operation Detection Rules

An identifier is treated as a write only when that name itself is the thing being modified. A prefix used to reach it is a read. The text after the match on the same line is checked against:

| Form | What counts as the write | Examples |
|------|--------------------------|----------|
| Assignment / increment | The name on the left of the operator | `x = 1`, `x += 1`, `x++`, `++x`, `x := 1`, `ch <- v` |
| Index or type annotation | That same name | `x[0] = 1`, `x: int = 1`, `int *x = 1` |
| Member assignment | The final member. The object or pointer is a read | `obj.field = 1` writes `field`; `++p->field` writes `field`. `*p = 1` does not write `p` |
| Multiple assignment and destructuring | Each assigned name, not a rename key | `a, b = f()`, `let {a} = obj`. In `{a: b} = obj`, `b` is the write |
| Loop variable, out/ref, alias | The bound or written-back name | `for x in xs`, `for (x of xs)`, `for (auto x : xs)`, `out x`, `import a as b` |
| Mutating member method | The object immediately before `.` or `->`, and only when it is a call | `xs.append(v)`, `p->insert(v)`. `obj.set = 1` writes `set` |
| Free function that mutates its first argument | The last name of the first argument | `memcpy(dst, src)`; `strcpy(p->date, src)` writes `date`, not `p` |

Everything else is treated as a read. Identifiers inside string literals, line comments, and same-line block comments (`/* ... */`) are never treated as writes. Line comments follow the language: `//` in C-family languages, `#` in Python and similar languages, and `--` in SQL, Lua, and Haskell. Comparison operators such as `==`, `===`, `!=`, and `=>` are not mistaken for assignment.

Searching for `pOrder`, `pOrder = &list[i]` and `++pOrder` are writes. `pOrder->status = Open`, `pOrder->days++`, `*pOrder = 1`, and `if (pOrder != nullptr)` are reads. `int *pOrder = 0` is still a write. On `pOrder->huicheprice = max(pOrder->huicheprice, high)` both occurrences of `pOrder` are reads; the name being written is `huicheprice`.

A line still contributes one result. If the searched name is both read and written on that line, the highlight is placed on the write, as in `if (x > 0) x = 1`.

A member call such as `list.append(item)` marks `list` as the mutated receiver. `item` is not treated as a write just because `append` is also listed under `functions`. `a.b.append(v)` marks `b`, not `a`. The same applies to `p->insert(pos, value)` and `obj?.erase(it)`: only the object next to the method counts.

A few forms look like assignment but are only guessed from the same line:

- `FOO` in `case FOO:` is not a write.
- In `let x: int = 1`, `const x: int = 1`, and Python `x: int = 1`, the type name after the colon is not a write. `let x: &'a str = "hi"` recognizes `x` as a write.
- Without a declaration keyword such as `let`, `const`, or `public`, `label` in `label: x = 1` and `int` in `x: int = 1` may still be marked as writes. A label and a type annotation cannot be told apart on one line.

Rules are configured through `searchhighlight.patterns`. Multiple groups (for example `common`, `go`, `python`) are merged together:

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

- `operators`: assignment operators
- `methods`: mutating member method names, matched case-insensitively and with CamelCase variants (configuring `set` also matches `setValue` and `Set`)
- `functions`: free functions that mutate their first argument. `append(xs, v)` writes `xs`; `strcpy(p->date, src)` writes `date`, not `p`. Member calls do not use this rule. `close(fd)` does not mark `fd` as a write, because `close` does not modify the variable. `gets` / `fgets` write into the buffer, so they still count
- `excludeOperators`: operators that must not be treated as assignment (comparison operators such as `==` and `=>` are always excluded)

Run the `Reload Write Operation Patterns` command to apply changes immediately.

> Pure text analysis cannot detect indirect mutation through iterators or references (e.g. `std::sort(v.begin(), v.end())`); such code is highlighted as a read.

### Search Configuration

- `searchhighlight.caseSensitive`: Enable case-sensitive search (default: true)
- `searchhighlight.matchWholeWord`: Enable whole word match (default: true). Editor highlights use the same Unicode word boundaries as ripgrep, so non-ASCII identifiers such as Chinese names match as a whole word
- `searchhighlight.excludePatterns`: Directory patterns to exclude
- `searchhighlight.respectGitIgnore`: Respect `.gitignore` and similar ignore files (default: false, i.e. search everything)
- `searchhighlight.debug`: Print debug logs to the output panel (default: false)
- `searchhighlight.excludeFileExtensions`: File extensions to exclude, defaults include:
  - Generated code files (.pb.h, .pb.cc, .generated.h, .generated.cpp, etc.)
  - Minified and map files (.min.js, .min.css, .map)
  - Build artifacts and intermediates (.pyc, .dll, .exe, .obj, etc.)

### Highlight Colors

- `searchhighlight.colors.read`: Read operation highlight color (default: "rgba(64, 200, 64, 0.5)")
- `searchhighlight.colors.write`: Write operation highlight color (default: "rgba(240, 64, 64, 0.5)")

## Keyboard Shortcuts

| Feature | Windows | MacOS |
|---------|---------|-------|
| Search selected text | Ctrl+Shift+F | Cmd+Shift+F |

> Note: this shortcut overrides the built-in "Find in Files". If you want to keep the built-in search, rebind `Search and Highlight Selected Text` in Keyboard Shortcuts.

## Supported File Types

- JavaScript (.js, .jsx)
- TypeScript (.ts, .tsx)
- Python (.py)
- Java (.java)
- C/C++ (.c, .cpp, .h, .hpp)
- Vue (.vue)
- Go (.go)
- Rust (.rs)
- PHP (.php)

## Note
- This extension uses VSCode's built-in rg.exe for fast file searching, even in large projects
- If search is slow, please check rg.exe path or add it to system PATH and try again

## Contributing

Issues and pull requests are welcome to help improve this extension.

## License

[MIT](LICENSE)
