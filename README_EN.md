# SearchHighlight

[中文](README.md)

SearchHighlight is a VSCode extension for searching code identifiers such as variables and functions. It analyzes the context of search results to determine whether the identifier is being read or written, and highlights them in different colors.

## Features

- Quick search for code identifiers in workspace
- Smart detection of read/write operations
- Customizable highlighting colors
- Rich configuration for write operation detection
- Real-time search result statistics
- File-grouped display
- Quick navigation to code location
- Case sensitivity and whole word match control
- File extension filtering support

## Version History
- 1.0.0 Initial release with read/write highlighting
- 1.0.1 Using rg.exe for better performance in large projects
- 1.0.2 Bug fixes and display improvements
- 1.0.3 Added text highlighting after jumping to location
- 1.0.4 Added case sensitivity and whole word match control, file extension filtering

## Usage

1. Select the text you want to search in the editor
2. Use shortcut `Ctrl+Shift+F` (Windows) or `Cmd+Shift+F` (MacOS) to search
3. View results in the Search Highlight view in the activity bar
4. Use the buttons in the top-right corner to control case sensitivity (Aa) and whole word match (\\b)
5. Click on results to jump to the corresponding code location

## Extension Settings

### Write Operation Detection Rules

Configure write operation detection rules through `searchhighlight.patterns`:

```json
{
  "common": {
    "operators": ["=", "+=", "-=", "*=", "/=", "%=", "++", "--"],
    "methods": [".append", ".add", ".insert", ".remove", ".delete", ".clear"],
    "excludeOperators": ["==", "===", "!=", "!==", ">=", "<=", ">", "<"]
  }
}
```

### Search Configuration

- `searchhighlight.caseSensitive`: Enable case-sensitive search (default: true)
- `searchhighlight.matchWholeWord`: Enable whole word match (default: true)
- `searchhighlight.excludePatterns`: Directory patterns to exclude
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
