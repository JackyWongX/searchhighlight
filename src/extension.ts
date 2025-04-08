import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

// 定义接口
interface PatternConfig {
    pattern: string;
    description: string;
    examples: string[];
}

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

    private getFileLanguage(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case '.py':
                return 'python';
            case '.js':
            case '.ts':
            case '.jsx':
            case '.tsx':
                return 'javascript';
            case '.java':
                return 'java';
            case '.cpp':
            case '.hpp':
            case '.cc':
            case '.h':
                return 'cpp';
            default:
                return 'common';
        }
    }

    public isWriteOperation(lineText: string): boolean {
        const patterns = this.patterns.common;
        
        if (!patterns || !lineText) {
            return false;
        }

        // 获取第一个非空白字符
        const firstNonWhitespace = lineText.trim()[0];
        if (!firstNonWhitespace) {
            return false;
        }

        // 1. 如果以.开头，检查是否是写操作方法
        if (firstNonWhitespace === '.') {
            return patterns.methods.some(method => 
                lineText.trim().startsWith(method));
        }

        // 2. 检查第一个非空白字符是否是操作符
        if (patterns.operators.includes(firstNonWhitespace)) {
            // 排除比较操作符
            return !patterns.excludeOperators?.some(op => 
                lineText.trim().startsWith(op));
        }

        // 3. 如果第一个字符既不是.也不是操作符，返回false
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

        // 从配置中获取排除目录
        const config = vscode.workspace.getConfiguration('searchhighlight');
        const excludeDirs = config.get<string[]>('excludePatterns') || [];
        const excludeArgs = excludeDirs.flatMap(dir => [
            '--glob', 
            `!${dir.startsWith('**/') ? dir : `**/${dir}`}`
        ]);

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
                    '--ignore-case',     // 忽略大小写
                    ...excludeArgs,      // 排除目录
                    '--',                // 分隔符，确保后面的参数不被解析为选项
                    searchText,          // 搜索模式
                    folder.uri.fsPath   // 搜索路径
                ];

                console.log(`执行命令: ${this.rgPath} ${rgArgs.join(' ')}`);
                
                const rg = cp.spawn(this.rgPath, rgArgs, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true
                });
                
                let output = '';
                let errorOutput = '';

                rg.stdout.on('data', (data: Buffer) => {
                    output += data.toString();
                });

                rg.stderr.on('data', (data: Buffer) => {
                    errorOutput += data.toString();
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

                    console.log(`搜索结果 : ${output}`);

                    const fileResults: SearchResult[] = [];
                    const lines = output.split('\n');

                    for (const line of lines) {
                        if (!line.trim()) {
                            continue;
                        }

                        // 1. 查找最后一个点(.)的位置
                        const lastDotPos = line.lastIndexOf('.');
                        if (lastDotPos === -1) {
                            console.warn('无效格式(缺少文件扩展名):', line);
                            continue;
                        }

                        // 2. 从点位置开始查找第一个冒号(:)
                        const firstColonAfterDot = line.indexOf(':', lastDotPos);
                        if (firstColonAfterDot === -1) {
                            console.warn('无效格式(文件名后缺少冒号):', line);
                            continue;
                        }

                        // 3. 查找下一个冒号(分隔行号和内容)
                        const secondColonAfterDot = line.indexOf(':', firstColonAfterDot + 1);
                        if (secondColonAfterDot === -1) {
                            console.warn('无效格式(行号后缺少冒号):', line);
                            continue;
                        }

                        // 提取各部分
                        const filePath = line.substring(0, firstColonAfterDot);
                        const lineNum = line.substring(firstColonAfterDot + 1, secondColonAfterDot);
                        const content = line.substring(secondColonAfterDot + 1).trim();
                        // 若content是注释的则跳过
                        if (content.startsWith('//') || content.startsWith('#')) {
                            console.warn('跳过注释行:', content);
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

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
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
                    break;
            }
        });
    }

    public showResults(results: SearchResult[], searchText: string) {
        if (this._view) {
            const config = vscode.workspace.getConfiguration('searchhighlight');
            const readColor = config.get<string>('colors.read');
            const writeColor = config.get<string>('colors.write');

            this._currentSearchResults = { results, searchText };
            this._view.show(true);
            this._view.webview.postMessage({ 
                type: 'results', 
                results, 
                searchText,
                colors: {
                    read: readColor,
                    write: writeColor
                }
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
        let html = fs.readFileSync(webviewPath, 'utf8');
        return html;
    }

    public dispose() {
        // 清理资源
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
