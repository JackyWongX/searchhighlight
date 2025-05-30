import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as jschardet from 'jschardet';
import * as iconv from 'iconv-lite';

interface WritePatterns {
    [key: string]: {
        operators: string[];
        methods: string[];
        excludeOperators?: string[];
    };
}

interface SearchResult {
    file: string;
    fileName: string;
    line: number;
    lineContent: string;
    isWrite: boolean;
    matchStart?: number;
    matchEnd?: number;
}

// 写操作检测类
class WriteOperationDetector {
    private patterns: WritePatterns;
    private patternCache: Map<string, RegExp[]> = new Map();

    constructor() {
        this.patterns = this.loadPatternsFromConfig();
    }

    private loadPatternsFromConfig(): WritePatterns {
        const config = vscode.workspace.getConfiguration('searchhighlight');
        return config.get<WritePatterns>('patterns') || {};
    }

    public reloadPatterns(): void {
        this.patterns = this.loadPatternsFromConfig();
        this.patternCache.clear();
    }

    public isWriteOperation(lineText: string): boolean {
        const patterns = this.patterns.common;
        const checkText = lineText.trim();
        if (!patterns || !checkText) {
            return false;
        }

        // 如果以.开头，检查是否是写操作方法
        if (checkText.startsWith('.')) {
            return patterns.methods.some(method =>
                checkText.startsWith('.' + method));
        }

        // 如果以->开头，检查是否是写操作方法（C++指针操作）
        if (checkText.startsWith('->')) {
            return patterns.methods.some(method =>
                checkText.startsWith('->' + method));
        }

        // 检查第一个非空白字符是否是操作符
        if (patterns.operators.includes(checkText[0])) {
            // 排除比较操作符
            return !patterns.excludeOperators?.some(op =>
                checkText.startsWith(op));
        }

        // 如果第一个字符既不是.也不是操作符，返回false
        return false;
    }
}

// 创建写操作检测器实例
const writeDetector = new WriteOperationDetector();

// 修改 RipGrep 搜索类
class RipGrepSearch {
    private rgPath: string;

    constructor() {
        // 使用 VS Code 内置的 ripgrep
        const vscodePath = process.env.VSCODE_CWD || process.env.VSCODE_NLS_CONFIG
            ? path.dirname(process.execPath)
            : 'C:\\Program Files\\Microsoft VS Code';

        this.rgPath = path.join(vscodePath, 'resources', 'app', 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg.exe');

        // 如果找不到 VS Code 内置的 ripgrep，尝试使用系统中的 rg
        if (!fs.existsSync(this.rgPath)) {
            console.warn('未找到 VS Code 内置的 ripgrep，将尝试使用系统中的 rg');
            this.rgPath = 'rg';
        }
        console.log(`RipGrep 路径: ${this.rgPath}`);
    }

    public async search(searchText: string): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;

        if (!workspaceFolders || !searchText.trim()) {
            return results;
        }

        // 从配置中获取搜索选项和过滤规则
        const config = vscode.workspace.getConfiguration('searchhighlight');
        const caseSensitive = config.get<boolean>('caseSensitive', true);
        const matchWholeWord = config.get<boolean>('matchWholeWord', true);
        const excludeDirs = config.get<string[]>('excludePatterns') || [];
        const excludeExts = config.get<string[]>('excludeFileExtensions') || [];

        // 构建排除目录的 glob 模式
        const excludeArgs = [
            ...excludeDirs.flatMap(dir => [
                '--glob',
                `!${dir.startsWith('**/') ? dir : `**/${dir}`}`
            ]),
            // 添加文件后缀过滤
            ...excludeExts.flatMap(ext => [
                '--glob',
                `!**/*${ext}`
            ])
        ];

        const searchPromises = workspaceFolders.map(folder => {
            return new Promise<SearchResult[]>((resolve, reject) => {
                const rgArgs = [
                    '--line-number',     // 显示行号
                    '--no-heading',      // 不显示文件头
                    '--color=never',     // 不使用颜色
                    '--hidden',          // 搜索隐藏文件
                    '--no-ignore',       // 不使用 ignore 文件
                    '--max-columns=1000', // 限制每行最大长度
                    '--fixed-strings',   // 按字面字符串搜索
                    ...(matchWholeWord ? ['--word-regexp'] : []), // 全词匹配
                    ...(caseSensitive ? [] : ['-i']), // 不区分大小写
                    ...excludeArgs,      // 排除目录和文件后缀
                    '--',                // 分隔符
                    searchText,          // 搜索模式
                    folder.uri.fsPath    // 搜索路径
                ];

                console.log(`执行命令: ${this.rgPath} ${rgArgs.join(' ')}`);

                const rg = cp.spawn(this.rgPath, rgArgs, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: {
                        ...process.env,
                        LANG: 'zh_CN.UTF-8',
                        LC_ALL: 'zh_CN.UTF-8'
                    }
                });

                let output = '';
                let errorOutput = '';

                rg.stdout.on('data', (data: Buffer) => {
                    // 检测编码
                    const detected = jschardet.detect(data);
                    const encoding = detected.encoding || 'utf8';

                    // 使用检测到的编码解码内容
                    if (encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'ascii') {
                        output += data.toString('utf8');
                    } else {
                        try {
                            output += iconv.decode(data, encoding);
                        } catch (e) {
                            console.error(`解码错误(${encoding}):`, e);
                            output += data.toString('utf8'); // 降级到 UTF-8
                        }
                    }
                });

                rg.stderr.on('data', (data: Buffer) => {
                    const detected = jschardet.detect(data);
                    const encoding = detected.encoding || 'utf8';

                    if (encoding.toLowerCase() === 'utf-8' || encoding.toLowerCase() === 'ascii') {
                        errorOutput += data.toString('utf8');
                    } else {
                        try {
                            errorOutput += iconv.decode(data, encoding);
                        } catch (e) {
                            console.error(`解码错误(${encoding}):`, e);
                            errorOutput += data.toString('utf8');
                        }
                    }
                });

                rg.on('error', (err) => {
                    console.error(`ripgrep 执行错误: ${err.message}`);
                    reject(err);
                });

                rg.on('close', (code: number) => {
                    if (errorOutput) {
                        console.error(`ripgrep 错误输出: ${errorOutput}`);
                    }

                    // code 1 表示没有找到匹配项，这是正常的
                    if (code !== 0 && code !== 1) {
                        console.error(`ripgrep 进程退出代码 ${code}`);
                        resolve([]);
                        return;
                    }

                    //console.log(`搜索结果 : ${output}`);
                    const fileResults: SearchResult[] = [];
                    const lines = output.split('\n');

                    for (const line of lines) {
                        if (!line.trim()) {
                            continue;
                        }

                        //console.log(`处理行: ${line} (${line.length} 字符)`);
                        // 1. 查找第一个点(.)的位置
                        const lastDotPos = line.indexOf('.');
                        if (lastDotPos === -1) {
                            console.warn('无效格式(缺少文件扩展名):', line);
                            continue;
                        }
                        //console.warn(`.的位置: ${lastDotPos} 后面的字符: ${line.substring(lastDotPos)}`);

                        // 2. 从点位置开始查找第一个冒号(:)
                        const firstColonAfterDot = line.indexOf(':', lastDotPos);
                        if (firstColonAfterDot === -1) {
                            console.warn('无效格式(文件名后缺少冒号):', line);
                            continue;
                        }
                        //console.warn(`:的位置: ${firstColonAfterDot} 后面的字符: ${line.substring(firstColonAfterDot)}`);

                        // 3. 查找下一个冒号(分隔行号和内容)
                        const secondColonAfterDot = line.indexOf(':', firstColonAfterDot + 1);
                        if (secondColonAfterDot === -1) {
                            console.warn('无效格式(行号后缺少冒号):', line);
                            continue;
                        }
                        //console.warn(`:的位置: ${secondColonAfterDot} 后面的字符: ${line.substring(secondColonAfterDot)}`);

                        // 提取各部分
                        const filePath = line.substring(0, firstColonAfterDot);
                        const lineNum = line.substring(firstColonAfterDot + 1, secondColonAfterDot);
                        const content = line.substring(secondColonAfterDot + 1).trim();
                        // 若content是注释的则跳过
                        if (content.startsWith('//') || content.startsWith('#')) {
                            continue;
                        }

                        // 构建搜索正则表达式，应用和highlightSearchText相同的逻辑
                        const flags = caseSensitive ? 'g' : 'gi';
                        const wordBoundary = matchWholeWord ? '\\b' : '';
                        const escapedSearchText = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const searchRegex = new RegExp(`${wordBoundary}${escapedSearchText}${wordBoundary}`, flags);

                        let match;
                        let matches = [];
                        while ((match = searchRegex.exec(content)) !== null) {
                            // 对每个匹配项判断其后面的文本是否为写操作
                            const afterText = content.substring(match.index + match[0].length).trim();
                            const isWrite = writeDetector.isWriteOperation(afterText);
                            matches.push({
                                start: match.index,
                                end: match.index + match[0].length,
                                isWrite: isWrite
                            });
                        }

                        // 如果找到匹配项，将每个匹配项以及其写操作状态加入到结果中
                        if (matches.length > 0) {
                            matches.forEach(match => {
                                fileResults.push({
                                    file: filePath,
                                    fileName: path.basename(filePath),
                                    line: parseInt(lineNum) - 1,
                                    lineContent: content,
                                    isWrite: match.isWrite,
                                    matchStart: match.start,    // 添加匹配位置信息
                                    matchEnd: match.end
                                });
                            });
                        }
                    }

                    resolve(fileResults);
                });
            });
        });

        try {
            const allResults = await Promise.all(searchPromises);
            return allResults.flat();
        } catch (error) {
            console.error('搜索过程中出错:', error);
            return [];
        }
    }
}

// 创建 RipGrep 搜索实例
const ripGrepSearch = new RipGrepSearch();

class SearchResultsView {
    private static currentProvider: SearchResultsProvider | undefined;

    public static createOrShow(context: vscode.ExtensionContext) {
        if (!this.currentProvider) {
            this.currentProvider = new SearchResultsProvider(context.extensionUri);
        }
        return this.currentProvider;
    }

    public static dispose() {
        if (this.currentProvider) {
            this.currentProvider.dispose();
            this.currentProvider = undefined;
        }
    }
}

class SearchResultsProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _currentSearchResults?: { results: SearchResult[]; searchText: string; };
    private _searchText = '';
    private _currentDecorationTypes: vscode.TextEditorDecorationType[] = [];

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
    }

    private _getSearchOptions() {
        const config = vscode.workspace.getConfiguration('searchhighlight');
        return {
            caseSensitive: config.get<boolean>('caseSensitive', true),
            matchWholeWord: config.get<boolean>('matchWholeWord', true)
        };
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'jump':
                    const document = await vscode.workspace.openTextDocument(message.file);
                    const editor = await vscode.window.showTextDocument(document);
                    const position = new vscode.Position(message.line, 0);
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(
                        new vscode.Range(position, position),
                        vscode.TextEditorRevealType.InCenter
                    );
                    this.highlightSearchText(editor, this._searchText, message.line);
                    break;
                case 'updateOption':
                    const config = vscode.workspace.getConfiguration('searchhighlight');
                    await config.update(message.option, message.value, vscode.ConfigurationTarget.Global);
                    if (this._currentSearchResults) {
                        // 重新执行搜索以应用新设置
                        const results = await ripGrepSearch.search(this._currentSearchResults.searchText);
                        this.showResults(results, this._currentSearchResults.searchText);
                    }
                    break;
                case 'search':
                    // 处理来自输入框的搜索请求
                    const searchText = message.text;
                    if (searchText) {
                        this._searchText = searchText;
                        // 显示进度提示
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `搜索 "${searchText}"`,
                            cancellable: true
                        }, async (progress) => {
                            try {
                                // 使用 ripgrep 执行搜索
                                const results = await ripGrepSearch.search(searchText);
                                // 更新搜索结果视图
                                this.showResults(results, searchText);
                            } catch (error) {
                                console.error('搜索过程中发生错误:', error);
                                vscode.window.showErrorMessage('搜索过程中发生错误');
                            }
                        });
                    }
                    break;
                case 'addFileExtFilter':
                    // 处理添加文件扩展名到过滤列表
                    const extension = message.extension;
                    if (extension) {
                        const config = vscode.workspace.getConfiguration('searchhighlight');
                        const excludeExts = config.get<string[]>('excludeFileExtensions') || [];

                        // 检查是否已存在该扩展名
                        if (!excludeExts.includes(extension)) {
                            excludeExts.push(extension);
                            await config.update('excludeFileExtensions', excludeExts, vscode.ConfigurationTarget.Global);
                            vscode.window.showInformationMessage(`已将 ${extension} 文件类型添加到搜索忽略列表`);

                            // 如果有当前搜索结果，则重新执行搜索以应用新设置
                            if (this._currentSearchResults) {
                                const results = await ripGrepSearch.search(this._currentSearchResults.searchText);
                                this.showResults(results, this._currentSearchResults.searchText);
                            }
                        } else {
                            vscode.window.showInformationMessage(`${extension} 文件类型已在搜索忽略列表中`);
                        }
                    }
                    break;
                case 'copyToClipboard':
                    // 处理复制到剪贴板
                    if (message.text) {
                        await vscode.env.clipboard.writeText(message.text);
                        vscode.window.showInformationMessage(`已复制到剪贴板: ${message.text}`);
                    }
                    break;
                case 'openInExplorer':
                    // 处理在资源管理器中打开文件
                    if (message.filePath) {
                        const filePath = message.filePath;
                        const dirname = path.dirname(filePath);
                        try {
                            // 使用 VS Code 内部命令在资源管理器中打开文件
                            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
                        } catch (error) {
                            console.error('在资源管理器中打开文件失败:', error);
                            vscode.window.showErrorMessage('无法在资源管理器中打开文件');
                        }
                    }
                    break;
            }
        });
    }

    public showResults(results: SearchResult[], searchText: string) {
        if (this._view) {
            const config = vscode.workspace.getConfiguration('searchhighlight');
            const readColor = config.get<string>('colors.read');
            const writeColor = config.get<string>('colors.write');
            this._searchText = searchText;

            // 获取当前活动编辑器的文件路径
            const currentFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;

            // 对结果进行排序：当前文档优先
            const sortedResults = [...results].sort((a, b) => {
                if (currentFilePath === a.file) {return -1;}
                if (currentFilePath === b.file) {return 1;}
                return 0;
            });

            this._currentSearchResults = { results: sortedResults, searchText };
            this._view.show(true);
            this._view.webview.postMessage({
                type: 'results',
                results: sortedResults,
                searchText, // 将搜索文本传递给 webview 用于显示在输入框
                colors: {
                    read: readColor,
                    write: writeColor
                },
                searchOptions: this._getSearchOptions()
            });
        }
    }

    // 添加方法来聚焦输入框
    public focusSearchInput() {
        if (this._view) {
            // 先确保视图显示
            this._view.show(true);
            // 发送消息让 webview 聚焦到输入框
            this._view.webview.postMessage({
                type: 'focusSearch'
            });
        }
    }

    public updateCurrentResults() {
        if (this._currentSearchResults) {
            this.showResults(this._currentSearchResults.results, this._currentSearchResults.searchText);
        }
    }

    private _getHtmlForWebview() {
        const webviewPath = path.join(this._extensionUri.fsPath, 'src', 'webview.html');
        let html = fs.readFileSync(webviewPath, { encoding: 'utf8' });
        return html;
    }

    private highlightSearchText(editor: vscode.TextEditor, searchText: string, currentLine: number) {
        // 清除之前的高亮
        this.clearDecorations();

        // 获取配置
        const config = vscode.workspace.getConfiguration('searchhighlight');
        const readColor = config.get<string>('colors.read', '#FFEB3B');
        const writeColor = config.get<string>('colors.write', '#FF5252');
        const { caseSensitive, matchWholeWord } = this._getSearchOptions();

        // 创建读写操作的高亮样式
        const readDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: readColor,
        });

        const writeDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: writeColor,
        });

        this._currentDecorationTypes.push(readDecorationType, writeDecorationType);

        // 构建搜索正则表达式
        const flags = caseSensitive ? 'g' : 'gi';
        const wordBoundary = matchWholeWord ? '\\b' : '';
        const searchRegex = new RegExp(`${wordBoundary}${this.escapeRegExp(searchText)}${wordBoundary}`, flags);

        // 遍历文档中的每一行
        const readDecorations: vscode.DecorationOptions[] = [];
        const writeDecorations: vscode.DecorationOptions[] = [];

        for (let i = 0; i < editor.document.lineCount; i++) {
            const line = editor.document.lineAt(i);
            let match;
            while ((match = searchRegex.exec(line.text)) !== null) {
                const startPos = new vscode.Position(i, match.index);
                const endPos = new vscode.Position(i, match.index + match[0].length);
                const range = new vscode.Range(startPos, endPos);

                // 判断是否为写操作
                const afterText = line.text.substring(match.index + match[0].length).trim();
                const isWrite = writeDetector.isWriteOperation(afterText);

                const decoration = { range };
                if (isWrite) {
                    writeDecorations.push(decoration);
                } else {
                    readDecorations.push(decoration);
                }
            }
        }

        // 应用高亮
        if (readDecorations.length > 0 || writeDecorations.length > 0) {
            editor.setDecorations(readDecorationType, readDecorations);
            editor.setDecorations(writeDecorationType, writeDecorations);
            // 设置上下文变量，标记有高亮存在
            vscode.commands.executeCommand('setContext', 'searchHighlightActive', true);
        }

        // 注册事件监听器清除高亮
        const disposables: vscode.Disposable[] = [];

        // 文档切换监听
        disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.clearDecorations();
                disposables.forEach(d => d.dispose());
            })
        );
    }

    public clearDecorations() {
        if (this._currentDecorationTypes.length > 0) {
            this._currentDecorationTypes.forEach(decoration => decoration.dispose());
            this._currentDecorationTypes = [];
            // 清除上下文变量，取消高亮状态
            vscode.commands.executeCommand('setContext', 'searchHighlightActive', false);
        }
    }

    public dispose() {
        this.clearDecorations();
    }

    // 转义正则表达式特殊字符
    private escapeRegExp(string: string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('SearchHighlight 插件开始激活...');

    try {
        console.log('正在创建 SearchResultsProvider...');
        const searchResultsProvider = new SearchResultsProvider(context.extensionUri);
        console.log('正在注册 WebviewViewProvider...');
        const viewDisposable = vscode.window.registerWebviewViewProvider(
            'searchHighlightResults',
            searchResultsProvider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true  // 切换视图时保持 WebView 内容
                }
            }
        );
        context.subscriptions.push(viewDisposable);
        console.log('WebviewViewProvider 注册成功');

        // 修改确保视图可见的函数
        async function ensureViewIsVisible() {
            console.log('正在确保视图可见...');
            try {
                await vscode.commands.executeCommand('workbench.view.extension.search-highlight');
                console.log('视图已显示');
            } catch (error) {
                console.error('显示视图时出错:', error);
            }
        }

        // 注册 focus 命令
        console.log('正在注册 focus 命令...');
        context.subscriptions.push(
            vscode.commands.registerCommand('searchhighlight.focus', () => {
                console.log('执行 focus 命令...');
                return ensureViewIsVisible();
            })
        );
        console.log('focus 命令注册成功');

        // 监听配置变更
        console.log('正在注册配置变更监听器...');
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                console.log('配置发生变更:', e.affectsConfiguration('searchhighlight'));
                if (e.affectsConfiguration('searchhighlight.patterns') ||
                    e.affectsConfiguration('searchhighlight.colors')) {
                    console.log('更新写操作检测规则和颜色配置');
                    writeDetector.reloadPatterns();
                    searchResultsProvider.updateCurrentResults();
                    vscode.window.showInformationMessage('搜索高亮配置已更新');
                }
            })
        );
        console.log('配置变更监听器注册成功');

        // 注册clearHighlight命令
        console.log('正在注册清除高亮命令...');
        context.subscriptions.push(
            vscode.commands.registerCommand('searchhighlight.clearHighlight', async () => {
                console.log('执行清除高亮命令...');
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    searchResultsProvider.clearDecorations();
                }
            })
        );

        console.log('正在注册主搜索命令...');
        let disposable = vscode.commands.registerCommand('searchhighlight.searchAndHighlight', async () => {
            console.log('执行搜索命令...');
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                console.log('没有活动的编辑器');
                // 打开搜索面板并聚焦到输入框
                await ensureViewIsVisible();
                // 获取视图提供程序实例
                const provider = SearchResultsView.createOrShow(context);
                if (provider instanceof SearchResultsProvider) {
                    provider.focusSearchInput();
                }
                return;
            }

            const selection = editor.selection;
            let searchText = editor.document.getText(selection);

            // 如果没有选中文本，则获取光标所在位置的单词
            if (!searchText) {
                console.log('没有选中文本，尝试获取光标所在单词...');
                const position = editor.selection.active;
                const wordRange = editor.document.getWordRangeAtPosition(position);
                if (wordRange) {
                    searchText = editor.document.getText(wordRange);
                    console.log('获取到光标所在单词:', searchText);
                }
            }

            if (!searchText) {
                console.log('没有找到可搜索的文本');
                // 打开搜索面板并聚焦到输入框，不再显示错误消息
                await ensureViewIsVisible();
                // 获取视图提供程序实例
                const provider = SearchResultsView.createOrShow(context);
                if (provider instanceof SearchResultsProvider) {
                    provider.focusSearchInput();
                }
                return;
            }

            console.log('搜索文本:', searchText);

            try {
                // 确保搜索结果视图是可见的
                console.log('正在显示搜索结果视图...');
                await ensureViewIsVisible();

                // 显示进度提示
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `搜索 "${searchText}"`,
                    cancellable: true
                }, async (progress) => {
                    try {
                        console.log('开始执行搜索...');
                        // 使用 ripgrep 执行搜索
                        const results = await ripGrepSearch.search(searchText);
                        console.log(`搜索完成，找到 ${results.length} 个结果`);

                        // 更新搜索结果视图
                        searchResultsProvider.showResults(results, searchText);

                        // 显示统计信息
                        const writeCount = results.filter(r => r.isWrite).length;
                        const readCount = results.length - writeCount;
                        console.log(`读操作: ${readCount}, 写操作: ${writeCount}`);
                    } catch (error) {
                        console.error('搜索过程中发生错误:', error);
                        vscode.window.showErrorMessage('搜索过程中发生错误');
                    }
                });
            } catch (error) {
                console.error('命令执行过程中发生错误:', error);
                vscode.window.showErrorMessage('执行搜索命令时发生错误');
            }
        });

        context.subscriptions.push(disposable);
        console.log('主搜索命令注册成功');
        console.log('SearchHighlight 插件激活完成');

    } catch (error) {
        console.error('插件激活过程中发生错误:', error);
        throw error; // 重新抛出错误以便 VS Code 可以捕获并显示
    }
}

export function deactivate() {
    SearchResultsView.dispose();
}
