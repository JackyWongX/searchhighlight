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

An identifier is treated as a write when the text after it on the same line matches one of the following:

| Form | Examples |
|------|----------|
| Assignment / increment operators | `x = 1`, `x += 1`, `x++`, `x := 1`, `ch <- v` |
| Assignment through index, member or type annotation | `x[0] = 1`, `obj.field = 1`, `p->field = 1`, `x: int = 1` |
| Multiple assignment and destructuring | `a, b = f()`, `let {a} = obj`, `let [a] = arr` |
| Mutating member methods | `xs.append(v)`, `xs.Add(v)`, `list.push_back(v)`, `obj.setValue(v)` |
| Functions that mutate their first argument | `append(xs, v)`, `memcpy(dst, src)` |

Everything else is treated as a read. Identifiers inside string literals and comments are never treated as writes, and comparison operators such as `==`, `===`, `!=`, `=>` are not mistaken for assignment.

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
    "functions": ["append", "delete", "close", "copy"]
  }
}
```

- `operators`: assignment operators
- `methods`: mutating member method names, matched case-insensitively and with CamelCase variants (configuring `set` also matches `setValue` and `Set`)
- `functions`: functions that mutate their first argument, e.g. `xs` in `append(xs, v)`
- `excludeOperators`: operators that must not be treated as assignment (comparison operators such as `==` and `=>` are always excluded)

Run the `Reload Write Operation Patterns` command to apply changes immediately.

> Pure text analysis cannot detect indirect mutation through iterators or references (e.g. `std::sort(v.begin(), v.end())`); such code is highlighted as a read.

### Search Configuration

- `searchhighlight.caseSensitive`: Enable case-sensitive search (default: true)
- `searchhighlight.matchWholeWord`: Enable whole word match (default: true)
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
