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

                        // 获取searchText后面的内容
                        const searchTextIndex = content.indexOf(searchText);
                        const searchTextEnd = content.substring(searchTextIndex+searchText.length);
                        fileResults.push({
                            file: filePath,
                            fileName: path.basename(filePath),
                            line: parseInt(lineNum) - 1, // 转换为0-based索引
                            lineContent: content,
                            isWrite: writeDetector.isWriteOperation(searchTextEnd)
                        });
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
            }
        });
    }

    public showResults(results: SearchResult[], searchText: string) {
        if (this._view) {
            const config = vscode.workspace.getConfiguration('searchhighlight');
            const readColor = config.get<string>('colors.read');
            const writeColor = config.get<string>('colors.write');
            this._searchText = searchText;

            this._currentSearchResults = { results, searchText };
            this._view.show(true);
            this._view.webview.postMessage({ 
                type: 'results', 
                results,
                searchText,
                colors: {
                    read: readColor,
                    write: writeColor
                },
                searchOptions: this._getSearchOptions()
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

    public dispose() {
        // 清理资源
    }

    // 转义正则表达式特殊字符
    private escapeRegExp(string: string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 高亮搜索文本的函数
    private highlightSearchText(editor: vscode.TextEditor, searchText: string, lineNumber: number) {
        // 清除之前的高亮
        const decorations: vscode.DecorationOptions[] = [];
        
        // 获取指定行的文本
        const line = editor.document.lineAt(lineNumber);
        const lineText = line.text;
        
        // 创建高亮样式
        const decorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 255, 0, 0.3)', // 黄色半透明背景
            overviewRulerColor: 'rgba(255, 165, 0, 0.8)',
            overviewRulerLane: vscode.OverviewRulerLane.Full
        });
        
        // 查找所有匹配项
        const regex = new RegExp(this.escapeRegExp(searchText), 'gi');
        let match;
        while ((match = regex.exec(lineText)) !== null) {
            const startPos = new vscode.Position(lineNumber, match.index);
            const endPos = new vscode.Position(lineNumber, match.index + match[0].length);
            const decoration = { range: new vscode.Range(startPos, endPos) };
            decorations.push(decoration);
        }
        
        // 应用高亮
        editor.setDecorations(decorationType, decorations);
        
        // 5秒后自动清除高亮
        setTimeout(() => {
            decorationType.dispose();
        }, 5000);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const searchResultsProvider = new SearchResultsProvider(context.extensionUri);
    const viewDisposable = vscode.window.registerWebviewViewProvider('searchHighlightResults', searchResultsProvider);
    context.subscriptions.push(viewDisposable);

    // 修改确保视图可见的函数
    async function ensureViewIsVisible() {
        // 只使用一个命令打开视图容器即可
        await vscode.commands.executeCommand('workbench.view.extension.search-highlight');
    }

    // 注册 focus 命令
    context.subscriptions.push(
        vscode.commands.registerCommand('searchhighlight.focus', () => {
            return ensureViewIsVisible();
        })
    );

    // 监听配置变更
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('searchhighlight.patterns') ||
                e.affectsConfiguration('searchhighlight.colors')) {
                writeDetector.reloadPatterns();
                searchResultsProvider.updateCurrentResults();
                vscode.window.showInformationMessage('搜索高亮配置已更新');
            }
        })
    );

    let disposable = vscode.commands.registerCommand('searchhighlight.searchAndHighlight', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        const selection = editor.selection;
        const searchText = editor.document.getText(selection);
        
        if (!searchText) {
            vscode.window.showInformationMessage('请先选择要搜索的文本');
            return;
        }
        
        // 确保搜索结果视图是可见的
        await ensureViewIsVisible();

        // 显示进度提示
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `搜索 "${searchText}"`,
            cancellable: true
        }, async (progress) => {
            try {
                // 使用 ripgrep 执行搜索
                const results = await ripGrepSearch.search(searchText);
                
                // 更新搜索结果视图
                searchResultsProvider.showResults(results, searchText);

                // 显示统计信息
                const writeCount = results.filter(r => r.isWrite).length;
                const readCount = results.length - writeCount;
            } catch (error) {
                console.error('Search error:', error);
                vscode.window.showErrorMessage('搜索过程中发生错误');
            }
        });
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {
    SearchResultsView.dispose();
}
